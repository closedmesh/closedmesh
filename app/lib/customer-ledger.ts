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
/** Journal list trim only — liability keys (balance, deposit, settled) do not expire. */
const JOURNAL_MAX_AGE_HINT_SEC = 365 * 24 * 3600;
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
    await redis.expire(key, JOURNAL_MAX_AGE_HINT_SEC);
    return;
  }
  if (!useMemory()) return;
  const prev = memory.journal.get(accountId) ?? [];
  prev.unshift(line);
  memory.journal.set(accountId, prev.slice(0, LEDGER_MAX_ENTRIES));
}

/**
 * Atomic reclaim of one expired reserve (or no-op if already settled).
 * KEYS: reserve, settled, exp_zset · ARGV: requestId
 */
const RECLAIM_ONE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('ZREM', KEYS[3], ARGV[1])
  return {0, 0, '', 0}
end
local raw = redis.call('GET', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
if not raw then
  return {0, 0, '', 0}
end
local micros = tonumber(string.match(raw, '"micros":([0-9]+)'))
local accountId = string.match(raw, '"accountId":"([^"]+)"')
if not micros or micros <= 0 or not accountId then
  redis.call('DEL', KEYS[1])
  return {0, 0, '', 0}
end
local balKey = 'senda:cust:balance:' .. accountId
local bal = redis.call('INCRBY', balKey, micros)
redis.call('DEL', KEYS[1])
return {1, micros, accountId, bal}
`;

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
      const script = redis.createScript<(string | number)[]>(RECLAIM_ONE_LUA);
      for (const requestId of ids) {
        const id = String(requestId);
        const result = await script.eval(
          [reserveKey(id), settledKey(id), RESERVE_EXP_ZSET],
          [id],
        );
        if (Number(result?.[0]) !== 1) continue;
        const hold = Number(result?.[1]);
        const accountId = String(result?.[2] ?? "");
        const balance = Number(result?.[3]);
        if (accountId && hold > 0) {
          await appendJournal(accountId, {
            kind: "reclaim",
            requestId: id,
            micros: hold,
            balance,
          });
          microsTotal += hold;
          reclaimed += 1;
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
 * When `depositId` is set, NX + INCRBY are atomic (no burned deposit without credit).
 */
const CREDIT_DEPOSIT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local bal = tonumber(redis.call('GET', KEYS[2]) or '0')
  return {-1, bal}
end
redis.call('SET', KEYS[1], '1')
local bal = redis.call('INCRBY', KEYS[2], ARGV[1])
return {1, bal}
`;

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
      let balance: number;
      if (input.depositId) {
        const script = redis.createScript<number[]>(CREDIT_DEPOSIT_LUA);
        const result = await script.eval(
          [depositKey(input.depositId), balanceKey(id)],
          [String(micros)],
        );
        const code = Number(result?.[0]);
        balance = Number(result?.[1]);
        if (code === -1) return { ok: true, balance };
        if (code !== 1) return { ok: false, error: "redis_error" };
      } else {
        balance = Number(await redis.incrby(balanceKey(id), micros));
      }
      await appendJournal(id, {
        kind: "credit",
        micros,
        reason: input.reason,
        depositId: input.depositId,
        balance,
      });
      return { ok: true, balance };
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

const ADJUST_LUA = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
local delta = tonumber(ARGV[1])
if delta < 0 and bal < -delta then
  return {-1, bal}
end
local next = redis.call('INCRBY', KEYS[1], delta)
if next < 0 then
  redis.call('INCRBY', KEYS[1], -delta)
  return {-1, bal}
end
return {1, next}
`;

/**
 * Adjust spendable balance by a signed delta (refund drain / restore / ops).
 * Negative deltas fail with insufficient_balance when funds are short.
 */
export async function adjustCustomerBalance(input: {
  accountId: string;
  deltaMicros: number;
  reason: string;
  ref?: string;
}): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
  await reclaimExpiredReserves(10);
  const id = normalizeAccountId(input.accountId);
  if (!id) return { ok: false, error: "invalid_account" };
  if (!Number.isFinite(input.deltaMicros) || input.deltaMicros === 0) {
    return { ok: false, error: "invalid_amount" };
  }
  const delta = Math.trunc(input.deltaMicros);
  if (!customerStoreReady()) return { ok: false, error: "store_unavailable" };

  const redis = getRedis();
  if (redis) {
    try {
      const script = redis.createScript<number[]>(ADJUST_LUA);
      const result = await script.eval([balanceKey(id)], [String(delta)]);
      const code = Number(result?.[0]);
      const balance = Number(result?.[1]);
      if (code === -1) return { ok: false, error: "insufficient_balance" };
      if (code !== 1) return { ok: false, error: "redis_error" };
      await appendJournal(id, {
        kind: "adjust",
        micros: delta,
        reason: input.reason,
        ref: input.ref,
        balance,
      });
      return { ok: true, balance };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  const current = memory.balances.get(id) ?? 0;
  const next = current + delta;
  if (next < 0) return { ok: false, error: "insufficient_balance" };
  memory.balances.set(id, next);
  await appendJournal(id, {
    kind: "adjust",
    micros: delta,
    reason: input.reason,
    ref: input.ref,
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


const SETTLE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return {0, redis.call('GET', KEYS[2]), 0, 0, 0, 0, ''}
end
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {-2, '', 0, 0, 0, 0, ''}
end
local reserved = tonumber(string.match(raw, '"micros":([0-9]+)'))
local accountId = string.match(raw, '"accountId":"([^"]+)"')
if not reserved or not accountId then
  return {-3, '', 0, 0, 0, 0, ''}
end
local balKey = 'senda:cust:balance:' .. accountId
local spendable = tonumber(redis.call('GET', balKey) or '0')
if spendable < 0 then spendable = 0 end
local actual = tonumber(ARGV[1])
local charged = 0
local release = 0
local shortfall = 0
local underpaid = 0
if actual <= reserved then
  charged = actual
  release = reserved - actual
else
  local want = actual - reserved
  if want > spendable then shortfall = spendable else shortfall = want end
  charged = reserved + shortfall
  underpaid = actual - charged
end
if release > 0 then
  redis.call('INCRBY', balKey, release)
end
if shortfall > 0 then
  local after = redis.call('DECRBY', balKey, shortfall)
  if after < 0 then
    redis.call('INCRBY', balKey, shortfall)
    charged = reserved
    shortfall = 0
    underpaid = actual - charged
  end
end
local balance = tonumber(redis.call('GET', balKey) or '0')
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[2])
local payload = '{"charged":' .. charged .. ',"balance":' .. balance .. ',"underpaid":' .. underpaid .. '}'
redis.call('SET', KEYS[2], payload)
return {1, payload, charged, balance, underpaid, release, accountId}
`;

/**
 * Finalize a reserve: charge actual cost (may pull shortfall from balance),
 * release unused hold. Idempotent per requestId. Atomic on Redis.
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
      const script = redis.createScript<(string | number)[]>(SETTLE_LUA);
      const result = await script.eval(
        [reserveKey(requestId), settledKey(requestId), RESERVE_EXP_ZSET],
        [String(actual), requestId],
      );
      const code = Number(result?.[0]);
      if (code === 0) {
        const prior = String(result?.[1] ?? "");
        const parsed = JSON.parse(prior) as {
          charged: number;
          balance: number;
          underpaid?: number;
        };
        return {
          ok: true,
          balance: Number(parsed.balance),
          charged: Number(parsed.charged),
          underpaid: parsed.underpaid ? Number(parsed.underpaid) : undefined,
          idempotent: true,
        };
      }
      if (code === -2) return { ok: false, error: "reserve_missing" };
      if (code !== 1) return { ok: false, error: "redis_error" };
      const charged = Number(result?.[2]);
      const balance = Number(result?.[3]);
      const underpaid = Number(result?.[4]) || 0;
      const release = Number(result?.[5]) || 0;
      const accountId = String(result?.[6] ?? "");
      if (accountId) {
        await appendJournal(accountId, {
          kind: "settle",
          requestId,
          charged,
          released: release,
          underpaid,
          balance,
        });
      }
      return {
        ok: true,
        balance,
        charged,
        underpaid: underpaid || undefined,
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
  const next = spendable + amounts.release - amounts.shortfallDebit;
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

/** Sum all customer spendable balances (SCAN — ops reconcile). */
export async function sumCustomerBalances(): Promise<number> {
  const redis = getRedis();
  if (redis) {
    try {
      let cursor = "0";
      let total = 0;
      do {
        const [next, keys] = await redis.scan(cursor, {
          match: `${BALANCE_PREFIX}:*`,
          count: 100,
        });
        cursor = String(next);
        for (const key of keys) {
          const raw = await redis.get<number | string | null>(key);
          const n = raw == null ? 0 : Number(raw);
          if (Number.isFinite(n) && n > 0) total += n;
        }
      } while (cursor !== "0");
      return total;
    } catch {
      return 0;
    }
  }
  let total = 0;
  for (const v of memory.balances.values()) total += v;
  return total;
}
