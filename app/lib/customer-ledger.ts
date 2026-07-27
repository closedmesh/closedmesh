/**
 * Phase 5.C — customer credit ledger (USD micros, rail-agnostic).
 *
 * Reserve model (hardened before paid API preview launch):
 * - Atomic Redis reserve (Lua) so concurrent requests can't overdraw.
 * - Holds are indexed by expiry; reclaimExpiredReserves() refunds abandoned
 *   holds (hang / killed isolate) so TTL never orphans DECRBY'd funds.
 * - settle is idempotent per requestId.
 *
 * See `internal/designs/phase-5ce-usdc-paid-api.md`.
 */

import { getRedis } from "./redis";

const BALANCE_PREFIX = "senda:cust:balance";
const RESERVE_PREFIX = "senda:cust:reserve";
const SETTLED_PREFIX = "senda:cust:settled";
const DEPOSIT_PREFIX = "senda:cust:deposit";
const LEDGER_PREFIX = "senda:cust:ledger";
const RESERVE_EXP_ZSET = "senda:cust:reserves:exp";
const LEDGER_TTL_SEC = 365 * 24 * 3600;
/** Max time a hold may live before reclaim refunds it. */
export const RESERVE_TTL_SEC = 10 * 60;
const LEDGER_MAX_ENTRIES = 100;

type ReserveRecord = {
  accountId: string;
  micros: number;
  expiresAt: number;
};

type MemoryStore = {
  balances: Map<string, number>;
  reserves: Map<string, ReserveRecord>;
  settled: Map<string, { charged: number; balance: number }>;
  deposits: Set<string>;
  journal: Map<string, string[]>;
};

const memory: MemoryStore = {
  balances: new Map(),
  reserves: new Map(),
  settled: new Map(),
  deposits: new Set(),
  journal: new Map(),
};

function useMemory(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.SENDA_CUST_LEDGER_MEMORY === "1"
  );
}

export function customerStoreReady(): boolean {
  return getRedis() != null || useMemory();
}

/** Test helper — wipe in-memory ledger between cases. */
export function resetCustomerLedgerMemory(): void {
  memory.balances.clear();
  memory.reserves.clear();
  memory.settled.clear();
  memory.deposits.clear();
  memory.journal.clear();
}

function balanceKey(accountId: string): string {
  return `${BALANCE_PREFIX}:${accountId}`;
}

function reserveKey(requestId: string): string {
  return `${RESERVE_PREFIX}:${requestId}`;
}

function settledKey(requestId: string): string {
  return `${SETTLED_PREFIX}:${requestId}`;
}

function depositKey(txHash: string): string {
  return `${DEPOSIT_PREFIX}:${txHash}`;
}

function ledgerKey(accountId: string): string {
  return `${LEDGER_PREFIX}:${accountId}`;
}

function normalizeAccountId(accountId: string): string | null {
  const id = accountId.trim();
  if (!id || id.length > 128) return null;
  return id;
}

async function appendJournal(
  accountId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() });
  const redis = getRedis();
  if (redis) {
    const key = ledgerKey(accountId);
    await redis.lpush(key, line);
    await redis.ltrim(key, 0, LEDGER_MAX_ENTRIES - 1);
    await redis.expire(key, LEDGER_TTL_SEC);
    return;
  }
  if (!useMemory()) return;
  const prev = memory.journal.get(accountId) ?? [];
  prev.unshift(line);
  memory.journal.set(accountId, prev.slice(0, LEDGER_MAX_ENTRIES));
}

/**
 * Refund holds whose expiry has passed and were never settled.
 * Safe to call often; bound by `limit`.
 */
export async function reclaimExpiredReserves(
  limit = 25,
): Promise<{ reclaimed: number; micros: number }> {
  const now = Date.now();
  let reclaimed = 0;
  let microsTotal = 0;

  const redis = getRedis();
  if (redis) {
    try {
      const ids = await redis.zrange(RESERVE_EXP_ZSET, 0, now, {
        byScore: true,
        offset: 0,
        count: limit,
      });
      for (const requestId of ids) {
        const id = String(requestId);
        const settled = await redis.get(settledKey(id));
        if (settled != null) {
          await redis.zrem(RESERVE_EXP_ZSET, id);
          continue;
        }
        const raw = await redis.get<string | null>(reserveKey(id));
        await redis.zrem(RESERVE_EXP_ZSET, id);
        if (raw == null) continue;
        const parsed = (
          typeof raw === "string" ? JSON.parse(raw) : raw
        ) as ReserveRecord;
        const hold = Math.floor(Number(parsed.micros) || 0);
        if (hold > 0 && parsed.accountId) {
          const balance = await redis.incrby(balanceKey(parsed.accountId), hold);
          await redis.del(reserveKey(id));
          await appendJournal(parsed.accountId, {
            kind: "reclaim",
            requestId: id,
            micros: hold,
            balance: Number(balance),
          });
          microsTotal += hold;
          reclaimed += 1;
        } else {
          await redis.del(reserveKey(id));
        }
      }
    } catch {
      // best-effort
    }
    return { reclaimed, micros: microsTotal };
  }

  if (!useMemory()) return { reclaimed: 0, micros: 0 };
  for (const [requestId, rec] of [...memory.reserves.entries()]) {
    if (reclaimed >= limit) break;
    if (rec.expiresAt > now) continue;
    if (memory.settled.has(requestId)) {
      memory.reserves.delete(requestId);
      continue;
    }
    const next = (memory.balances.get(rec.accountId) ?? 0) + rec.micros;
    memory.balances.set(rec.accountId, next);
    memory.reserves.delete(requestId);
    await appendJournal(rec.accountId, {
      kind: "reclaim",
      requestId,
      micros: rec.micros,
      balance: next,
    });
    microsTotal += rec.micros;
    reclaimed += 1;
  }
  return { reclaimed, micros: microsTotal };
}

export async function getCustomerBalance(
  accountId: string,
): Promise<number | null> {
  await reclaimExpiredReserves(10);
  const id = normalizeAccountId(accountId);
  if (!id) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<number | string | null>(balanceKey(id));
      if (raw == null) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return null;
    }
  }
  if (!useMemory()) return null;
  return memory.balances.get(id) ?? 0;
}

/**
 * Credit customer balance (USDC deposit or admin top-up).
 * When `depositId` is set, the credit is idempotent on that id.
 */
export async function creditCustomer(input: {
  accountId: string;
  micros: number;
  reason: "admin" | "usdc_deposit" | "reserve_release";
  depositId?: string;
}): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
  await reclaimExpiredReserves(10);
  const id = normalizeAccountId(input.accountId);
  if (!id) return { ok: false, error: "invalid_account" };
  if (!Number.isFinite(input.micros) || input.micros <= 0) {
    return { ok: false, error: "invalid_amount" };
  }
  const micros = Math.floor(input.micros);
  if (!customerStoreReady()) return { ok: false, error: "store_unavailable" };

  const redis = getRedis();
  if (redis) {
    try {
      if (input.depositId) {
        const dKey = depositKey(input.depositId);
        const existed = await redis.set(dKey, "1", {
          nx: true,
          ex: LEDGER_TTL_SEC,
        });
        if (existed !== "OK") {
          const balance = (await getCustomerBalance(id)) ?? 0;
          return { ok: true, balance };
        }
      }
      const balance = await redis.incrby(balanceKey(id), micros);
      await redis.expire(balanceKey(id), LEDGER_TTL_SEC);
      await appendJournal(id, {
        kind: "credit",
        micros,
        reason: input.reason,
        depositId: input.depositId,
        balance,
      });
      return { ok: true, balance: Number(balance) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  if (input.depositId) {
    if (memory.deposits.has(input.depositId)) {
      return { ok: true, balance: memory.balances.get(id) ?? 0 };
    }
    memory.deposits.add(input.depositId);
  }
  const next = (memory.balances.get(id) ?? 0) + micros;
  memory.balances.set(id, next);
  await appendJournal(id, {
    kind: "credit",
    micros,
    reason: input.reason,
    depositId: input.depositId,
    balance: next,
  });
  return { ok: true, balance: next };
}

const RESERVE_LUA = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
if redis.call('EXISTS', KEYS[2]) == 1 then
  return {-1, bal}
end
if redis.call('EXISTS', KEYS[4]) == 1 then
  return {-1, bal}
end
local need = tonumber(ARGV[1])
if bal < need then
  return {-2, bal}
end
local next = redis.call('DECRBY', KEYS[1], need)
if next < 0 then
  redis.call('INCRBY', KEYS[1], need)
  return {-2, bal}
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
return {1, next}
`;

/**
 * Hold funds for an in-flight request. Fails if balance < micros.
 */
export async function reserveCustomer(input: {
  accountId: string;
  requestId: string;
  micros: number;
  /** Override TTL for tests. */
  ttlSec?: number;
}): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
  await reclaimExpiredReserves(25);
  const id = normalizeAccountId(input.accountId);
  const requestId = input.requestId.trim();
  if (!id || !requestId) return { ok: false, error: "invalid_account" };
  if (!Number.isFinite(input.micros) || input.micros <= 0) {
    return { ok: false, error: "invalid_amount" };
  }
  const micros = Math.floor(input.micros);
  const ttlSec = input.ttlSec ?? RESERVE_TTL_SEC;
  const expiresAt = Date.now() + ttlSec * 1000;
  if (!customerStoreReady()) return { ok: false, error: "store_unavailable" };

  const redis = getRedis();
  if (redis) {
    try {
      const record: ReserveRecord = { accountId: id, micros, expiresAt };
      const script = redis.createScript<number[]>(RESERVE_LUA);
      const result = await script.eval(
        [
          balanceKey(id),
          reserveKey(requestId),
          RESERVE_EXP_ZSET,
          settledKey(requestId),
        ],
        [
          String(micros),
          JSON.stringify(record),
          String(expiresAt),
          requestId,
        ],
      );

      const code = Number(result?.[0]);
      const balance = Number(result?.[1]);
      if (code === -1) return { ok: false, error: "reserve_exists" };
      if (code === -2) return { ok: false, error: "insufficient_funds" };
      if (code !== 1) return { ok: false, error: "redis_error" };

      await appendJournal(id, {
        kind: "reserve",
        micros,
        requestId,
        expiresAt,
        balance,
      });
      return { ok: true, balance };
    } catch (err) {
      // Fallback non-atomic path if eval unsupported (shouldn't happen on Upstash).
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  if (memory.reserves.has(requestId) || memory.settled.has(requestId)) {
    return { ok: false, error: "reserve_exists" };
  }
  const balance = memory.balances.get(id) ?? 0;
  if (balance < micros) return { ok: false, error: "insufficient_funds" };
  const next = balance - micros;
  memory.balances.set(id, next);
  memory.reserves.set(requestId, { accountId: id, micros, expiresAt });
  await appendJournal(id, {
    kind: "reserve",
    micros,
    requestId,
    expiresAt,
    balance: next,
  });
  return { ok: true, balance: next };
}

export type SettleResult =
  | {
      ok: true;
      balance: number;
      charged: number;
      /** actual − charged when balance couldn't cover a shortfall */
      underpaid?: number;
      idempotent?: boolean;
    }
  | { ok: false; error: string };

/**
 * Apply settle math: charge up to reserved + remaining spendable balance.
 * Pure helper so shortfall behaviour is unit-tested.
 */
export function computeSettleAmounts(input: {
  reserved: number;
  actual: number;
  spendableBalance: number;
}): { charged: number; release: number; shortfallDebit: number; underpaid: number } {
  const reserved = Math.max(0, Math.floor(input.reserved));
  const actual = Math.max(0, Math.floor(input.actual));
  const spendable = Math.max(0, Math.floor(input.spendableBalance));
  if (actual <= reserved) {
    return {
      charged: actual,
      release: reserved - actual,
      shortfallDebit: 0,
      underpaid: 0,
    };
  }
  const wantExtra = actual - reserved;
  const shortfallDebit = Math.min(wantExtra, spendable);
  const charged = reserved + shortfallDebit;
  return {
    charged,
    release: 0,
    shortfallDebit,
    underpaid: actual - charged,
  };
}

/**
 * Finalize a reserve: charge actual cost (may pull shortfall from balance),
 * release unused hold. Idempotent per requestId.
 */
export async function settleCustomer(input: {
  requestId: string;
  actualMicros: number;
}): Promise<SettleResult> {
  const requestId = input.requestId.trim();
  if (!requestId) return { ok: false, error: "invalid_request" };
  if (!Number.isFinite(input.actualMicros) || input.actualMicros < 0) {
    return { ok: false, error: "invalid_amount" };
  }
  const actual = Math.floor(input.actualMicros);
  if (!customerStoreReady()) return { ok: false, error: "store_unavailable" };

  const redis = getRedis();
  if (redis) {
    try {
      const prior = await redis.get<string | null>(settledKey(requestId));
      if (prior != null) {
        const parsed = (
          typeof prior === "string" ? JSON.parse(prior) : prior
        ) as { charged: number; balance: number; underpaid?: number };
        return {
          ok: true,
          balance: Number(parsed.balance),
          charged: Number(parsed.charged),
          underpaid: parsed.underpaid ? Number(parsed.underpaid) : undefined,
          idempotent: true,
        };
      }

      const rKey = reserveKey(requestId);
      const raw = await redis.get<string | null>(rKey);
      if (raw == null) {
        return { ok: false, error: "reserve_missing" };
      }
      const parsed = (
        typeof raw === "string" ? JSON.parse(raw) : raw
      ) as ReserveRecord;
      const reserved = Number(parsed.micros);
      const id = parsed.accountId;
      const spendableRaw = await redis.get<number | string | null>(
        balanceKey(id),
      );
      const spendable =
        spendableRaw == null ? 0 : Math.max(0, Number(spendableRaw) || 0);
      const amounts = computeSettleAmounts({
        reserved,
        actual,
        spendableBalance: spendable,
      });

      if (amounts.release > 0) {
        await redis.incrby(balanceKey(id), amounts.release);
      }
      if (amounts.shortfallDebit > 0) {
        const after = await redis.decrby(balanceKey(id), amounts.shortfallDebit);
        if (Number(after) < 0) {
          // Race: put back and charge reserved only.
          await redis.incrby(balanceKey(id), amounts.shortfallDebit);
          const balance = Number(
            (await redis.get<number | string | null>(balanceKey(id))) ?? 0,
          );
          await redis.del(rKey);
          await redis.zrem(RESERVE_EXP_ZSET, requestId);
          const charged = reserved;
          const underpaid = Math.max(0, actual - charged);
          const settledPayload = JSON.stringify({
            charged,
            balance,
            underpaid,
          });
          await redis.set(settledKey(requestId), settledPayload, {
            ex: LEDGER_TTL_SEC,
          });
          await appendJournal(id, {
            kind: "settle",
            requestId,
            reserved,
            charged,
            released: 0,
            shortfallDebit: 0,
            underpaid,
            balance,
            note: "shortfall_race",
          });
          return {
            ok: true,
            balance,
            charged,
            underpaid: underpaid || undefined,
          };
        }
      }

      const balance = Number(
        (await redis.get<number | string | null>(balanceKey(id))) ?? 0,
      );
      await redis.del(rKey);
      await redis.zrem(RESERVE_EXP_ZSET, requestId);
      const settledPayload = JSON.stringify({
        charged: amounts.charged,
        balance,
        underpaid: amounts.underpaid,
      });
      await redis.set(settledKey(requestId), settledPayload, {
        ex: LEDGER_TTL_SEC,
      });
      await appendJournal(id, {
        kind: "settle",
        requestId,
        reserved,
        charged: amounts.charged,
        released: amounts.release,
        shortfallDebit: amounts.shortfallDebit,
        underpaid: amounts.underpaid,
        balance,
      });
      return {
        ok: true,
        balance,
        charged: amounts.charged,
        underpaid: amounts.underpaid || undefined,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  const priorMem = memory.settled.get(requestId);
  if (priorMem) {
    return {
      ok: true,
      balance: priorMem.balance,
      charged: priorMem.charged,
      idempotent: true,
    };
  }
  const held = memory.reserves.get(requestId);
  if (!held) return { ok: false, error: "reserve_missing" };
  const spendable = memory.balances.get(held.accountId) ?? 0;
  const amounts = computeSettleAmounts({
    reserved: held.micros,
    actual,
    spendableBalance: spendable,
  });
  const next =
    spendable + amounts.release - amounts.shortfallDebit;
  memory.balances.set(held.accountId, next);
  memory.reserves.delete(requestId);
  memory.settled.set(requestId, {
    charged: amounts.charged,
    balance: next,
  });
  await appendJournal(held.accountId, {
    kind: "settle",
    requestId,
    reserved: held.micros,
    charged: amounts.charged,
    released: amounts.release,
    shortfallDebit: amounts.shortfallDebit,
    underpaid: amounts.underpaid,
    balance: next,
  });
  return {
    ok: true,
    balance: next,
    charged: amounts.charged,
    underpaid: amounts.underpaid || undefined,
  };
}
