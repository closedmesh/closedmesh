/**
 * Phase 5.C — customer credit ledger (USD micros, rail-agnostic).
 *
 * Separate from peer earned-credits (`senda:credits:*`). Sprint 1 = Redis;
 * Vitest uses an in-memory map when Upstash is unavailable.
 *
 * See `internal/designs/phase-5ce-usdc-paid-api.md`.
 */

import { getRedis } from "./redis";

const BALANCE_PREFIX = "senda:cust:balance";
const RESERVE_PREFIX = "senda:cust:reserve";
const DEPOSIT_PREFIX = "senda:cust:deposit";
const LEDGER_PREFIX = "senda:cust:ledger";
const LEDGER_TTL_SEC = 365 * 24 * 3600;
const RESERVE_TTL_SEC = 30 * 60;
const LEDGER_MAX_ENTRIES = 100;

type MemoryStore = {
  balances: Map<string, number>;
  reserves: Map<string, { accountId: string; micros: number }>;
  deposits: Set<string>;
  journal: Map<string, string[]>;
};

const memory: MemoryStore = {
  balances: new Map(),
  reserves: new Map(),
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
  memory.deposits.clear();
  memory.journal.clear();
}

function balanceKey(accountId: string): string {
  return `${BALANCE_PREFIX}:${accountId}`;
}

function reserveKey(requestId: string): string {
  return `${RESERVE_PREFIX}:${requestId}`;
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

export async function getCustomerBalance(
  accountId: string,
): Promise<number | null> {
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

  // Memory path (tests / explicit memory mode).
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

/**
 * Hold funds for an in-flight request. Fails if balance < micros.
 */
export async function reserveCustomer(input: {
  accountId: string;
  requestId: string;
  micros: number;
}): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
  const id = normalizeAccountId(input.accountId);
  const requestId = input.requestId.trim();
  if (!id || !requestId) return { ok: false, error: "invalid_account" };
  if (!Number.isFinite(input.micros) || input.micros <= 0) {
    return { ok: false, error: "invalid_amount" };
  }
  const micros = Math.floor(input.micros);
  if (!customerStoreReady()) return { ok: false, error: "store_unavailable" };

  const redis = getRedis();
  if (redis) {
    try {
      const rKey = reserveKey(requestId);
      const existing = await redis.get(rKey);
      if (existing != null) return { ok: false, error: "reserve_exists" };

      const balanceRaw = await redis.get<number | string | null>(balanceKey(id));
      const balance = balanceRaw == null ? 0 : Number(balanceRaw);
      if (!Number.isFinite(balance) || balance < micros) {
        return { ok: false, error: "insufficient_funds" };
      }
      const next = await redis.decrby(balanceKey(id), micros);
      if (Number(next) < 0) {
        await redis.incrby(balanceKey(id), micros);
        return { ok: false, error: "insufficient_funds" };
      }
      await redis.set(rKey, JSON.stringify({ accountId: id, micros }), {
        ex: RESERVE_TTL_SEC,
      });
      await appendJournal(id, {
        kind: "reserve",
        micros,
        requestId,
        balance: Number(next),
      });
      return { ok: true, balance: Number(next) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  if (memory.reserves.has(requestId)) {
    return { ok: false, error: "reserve_exists" };
  }
  const balance = memory.balances.get(id) ?? 0;
  if (balance < micros) return { ok: false, error: "insufficient_funds" };
  const next = balance - micros;
  memory.balances.set(id, next);
  memory.reserves.set(requestId, { accountId: id, micros });
  await appendJournal(id, {
    kind: "reserve",
    micros,
    requestId,
    balance: next,
  });
  return { ok: true, balance: next };
}

/**
 * Finalize a reserve: charge actual cost, release unused hold back to balance.
 */
export async function settleCustomer(input: {
  requestId: string;
  actualMicros: number;
}): Promise<{ ok: true; balance: number; charged: number } | { ok: false; error: string }> {
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
      const rKey = reserveKey(requestId);
      const raw = await redis.get<string | null>(rKey);
      if (raw == null) return { ok: false, error: "reserve_missing" };
      const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw)) as {
        accountId: string;
        micros: number;
      };
      const reserved = Number(parsed.micros);
      const id = parsed.accountId;
      const charged = Math.min(actual, reserved);
      const release = reserved - charged;
      let balance = (await getCustomerBalance(id)) ?? 0;
      if (release > 0) {
        balance = Number(await redis.incrby(balanceKey(id), release));
      } else {
        balance = (await getCustomerBalance(id)) ?? 0;
      }
      await redis.del(rKey);
      await appendJournal(id, {
        kind: "settle",
        requestId,
        reserved,
        charged,
        released: release,
        balance,
      });
      return { ok: true, balance, charged };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  const held = memory.reserves.get(requestId);
  if (!held) return { ok: false, error: "reserve_missing" };
  const charged = Math.min(actual, held.micros);
  const release = held.micros - charged;
  const next = (memory.balances.get(held.accountId) ?? 0) + release;
  memory.balances.set(held.accountId, next);
  memory.reserves.delete(requestId);
  await appendJournal(held.accountId, {
    kind: "settle",
    requestId,
    reserved: held.micros,
    charged,
    released: release,
    balance: next,
  });
  return { ok: true, balance: next, charged };
}
