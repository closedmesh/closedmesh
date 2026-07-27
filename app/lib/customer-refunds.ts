/**
 * Customer API-balance refund requests (ops-assisted in preview).
 *
 * Atomic drain + ticket creation. Ops mark tickets paid after USDC return
 * (or cancel + restore). Liability keys do not expire.
 */

import { randomBytes } from "crypto";
import { getRedis } from "./redis";
import { adjustCustomerBalance, getCustomerBalance } from "./customer-ledger";
import { MIN_WITHDRAW_USDC_ATOMIC } from "./solana-config";

const REFUND_PREFIX = "senda:refund";
const REFUND_STATUS_PREFIX = "senda:refund:status";
const PENDING_ZSET = "senda:refund:pending";
const BY_WALLET_PREFIX = "senda:refund:by-wallet";
const BALANCE_PREFIX = "senda:cust:balance";

export type RefundStatus = "pending" | "sending" | "paid" | "cancelled";

export type RefundRequest = {
  id: string;
  wallet: string;
  destination: string;
  micros: number;
  status: RefundStatus;
  createdAt: string;
  note?: string;
  txSignature?: string;
  processedAt?: string;
};

type MemoryStore = {
  byId: Map<string, RefundRequest>;
  byWallet: Map<string, string[]>;
};

const memory: MemoryStore = {
  byId: new Map(),
  byWallet: new Map(),
};

function useMemory(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.SENDA_CUST_LEDGER_MEMORY === "1"
  );
}

export function newRefundId(): string {
  return `rf_${randomBytes(12).toString("hex")}`;
}

export function resetRefundMemory(): void {
  memory.byId.clear();
  memory.byWallet.clear();
}

/**
 * Atomic: debit available (or requested micros) and create pending ticket.
 * ARGV: min, score, id, wallet, destination, createdAt, note, wantMicros(0=all)
 */
const DRAIN_REFUND_LUA = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
local min = tonumber(ARGV[1])
local want = tonumber(ARGV[8])
local drain = want
if want <= 0 then drain = bal end
if drain < min or bal < drain then
  return {-1, bal}
end
redis.call('DECRBY', KEYS[1], drain)
local note = ARGV[7]
local payload
if note ~= '' then
  payload = '{"id":"' .. ARGV[3] .. '","wallet":"' .. ARGV[4] .. '","destination":"' .. ARGV[5] .. '","micros":' .. drain .. ',"status":"pending","createdAt":"' .. ARGV[6] .. '","note":"' .. note .. '"}'
else
  payload = '{"id":"' .. ARGV[3] .. '","wallet":"' .. ARGV[4] .. '","destination":"' .. ARGV[5] .. '","micros":' .. drain .. ',"status":"pending","createdAt":"' .. ARGV[6] .. '"}'
end
redis.call('SET', KEYS[2], payload)
redis.call('SET', KEYS[5], 'pending')
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
redis.call('LPUSH', KEYS[4], ARGV[3])
return {1, drain}
`;

const CLAIM_REFUND_LUA = `
local st = redis.call('GET', KEYS[1])
if st ~= 'pending' then return {0} end
redis.call('SET', KEYS[1], 'sending')
return {1}
`;

export async function requestCustomerRefund(input: {
  wallet: string;
  destination: string;
  note?: string;
  /** Optional partial amount; default = full available. */
  micros?: number;
}): Promise<
  | { ok: true; request: RefundRequest }
  | { ok: false; error: string }
> {
  const wallet = input.wallet.trim();
  const destination = input.destination.trim();
  if (!wallet || !destination || destination.length < 32) {
    return { ok: false, error: "invalid_input" };
  }
  const id = newRefundId();
  const createdAt = new Date().toISOString();
  const note = (input.note?.trim().slice(0, 280) || "").replace(/"/g, "");
  const want =
    typeof input.micros === "number" && Number.isFinite(input.micros)
      ? Math.floor(input.micros)
      : 0;

  const redis = getRedis();
  if (redis) {
    try {
      const script = redis.createScript<number[]>(DRAIN_REFUND_LUA);
      const result = await script.eval(
        [
          `${BALANCE_PREFIX}:${wallet}`,
          `${REFUND_PREFIX}:${id}`,
          PENDING_ZSET,
          `${BY_WALLET_PREFIX}:${wallet}`,
          `${REFUND_STATUS_PREFIX}:${id}`,
        ],
        [
          String(MIN_WITHDRAW_USDC_ATOMIC),
          String(Date.now()),
          id,
          wallet,
          destination,
          createdAt,
          note,
          String(want),
        ],
      );
      const code = Number(result?.[0]);
      const micros = Number(result?.[1]);
      if (code === -1) return { ok: false, error: "below_minimum" };
      if (code !== 1) return { ok: false, error: "redis_error" };
      const request: RefundRequest = {
        id,
        wallet,
        destination,
        micros,
        status: "pending",
        createdAt,
        note: note || undefined,
      };
      return { ok: true, request };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  if (!useMemory()) return { ok: false, error: "store_unavailable" };
  const bal = await getCustomerBalance(wallet);
  if (bal == null) return { ok: false, error: "balance_unavailable" };
  const drain = want > 0 ? want : bal;
  if (drain < MIN_WITHDRAW_USDC_ATOMIC || bal < drain) {
    return { ok: false, error: "below_minimum" };
  }
  const adj = await adjustCustomerBalance({
    accountId: wallet,
    deltaMicros: -drain,
    reason: "refund_request",
    ref: `refund_drain:${id}`,
  });
  if (!adj.ok) return { ok: false, error: adj.error };
  const request: RefundRequest = {
    id,
    wallet,
    destination,
    micros: drain,
    status: "pending",
    createdAt,
    note: note || undefined,
  };
  memory.byId.set(request.id, request);
  const list = memory.byWallet.get(wallet) ?? [];
  list.unshift(request.id);
  memory.byWallet.set(wallet, list);
  return { ok: true, request };
}

export async function listWalletRefunds(
  wallet: string,
  limit = 20,
): Promise<RefundRequest[]> {
  const redis = getRedis();
  if (redis) {
    try {
      const ids = await redis.lrange(`${BY_WALLET_PREFIX}:${wallet}`, 0, limit - 1);
      const out: RefundRequest[] = [];
      for (const rid of ids) {
        const raw = await redis.get<string | null>(`${REFUND_PREFIX}:${rid}`);
        if (!raw) continue;
        out.push(
          typeof raw === "string" ? (JSON.parse(raw) as RefundRequest) : raw,
        );
      }
      return out;
    } catch {
      return [];
    }
  }
  const ids = memory.byWallet.get(wallet) ?? [];
  return ids
    .slice(0, limit)
    .map((rid) => memory.byId.get(rid))
    .filter((r): r is RefundRequest => r != null);
}

export async function listPendingRefunds(limit = 20): Promise<RefundRequest[]> {
  const redis = getRedis();
  if (redis) {
    try {
      const ids = await redis.zrange<string[]>(PENDING_ZSET, 0, limit - 1);
      const out: RefundRequest[] = [];
      for (const rid of ids) {
        const raw = await redis.get<string | null>(`${REFUND_PREFIX}:${rid}`);
        if (!raw) continue;
        const req =
          typeof raw === "string" ? (JSON.parse(raw) as RefundRequest) : raw;
        if (req.status === "pending" || req.status === "sending") out.push(req);
      }
      return out;
    } catch {
      return [];
    }
  }
  return [...memory.byId.values()]
    .filter((r) => r.status === "pending" || r.status === "sending")
    .slice(0, limit);
}

export async function getRefund(id: string): Promise<RefundRequest | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<string | null>(`${REFUND_PREFIX}:${id}`);
      if (!raw) return null;
      return typeof raw === "string"
        ? (JSON.parse(raw) as RefundRequest)
        : raw;
    } catch {
      return null;
    }
  }
  return memory.byId.get(id) ?? null;
}

async function saveRefund(request: RefundRequest): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${REFUND_PREFIX}:${request.id}`, JSON.stringify(request));
    await redis.set(`${REFUND_STATUS_PREFIX}:${request.id}`, request.status);
    if (request.status === "paid" || request.status === "cancelled") {
      await redis.zrem(PENDING_ZSET, request.id);
    }
    return;
  }
  memory.byId.set(request.id, request);
}

/** Claim pending → sending. Returns false if already claimed/paid. */
export async function claimRefundForSend(
  id: string,
): Promise<{ ok: true; request: RefundRequest } | { ok: false; error: string }> {
  const existing = await getRefund(id);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.txSignature) {
    return { ok: false, error: "already_sent" };
  }
  if (existing.status === "sending" && existing.txSignature) {
    return { ok: false, error: "already_sent" };
  }

  const redis = getRedis();
  if (redis) {
    try {
      const script = redis.createScript<number[]>(CLAIM_REFUND_LUA);
      const result = await script.eval(
        [`${REFUND_STATUS_PREFIX}:${id}`],
        [],
      );
      if (Number(result?.[0]) !== 1) {
        const again = await getRefund(id);
        if (again?.txSignature) return { ok: false, error: "already_sent" };
        if (again?.status === "sending") {
          return { ok: true, request: again };
        }
        return { ok: false, error: "not_pending" };
      }
      existing.status = "sending";
      await saveRefund(existing);
      return { ok: true, request: existing };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  if (existing.status !== "pending") return { ok: false, error: "not_pending" };
  existing.status = "sending";
  memory.byId.set(id, existing);
  return { ok: true, request: existing };
}

export async function markRefundPaid(input: {
  id: string;
  txSignature: string;
}): Promise<{ ok: true; request: RefundRequest } | { ok: false; error: string }> {
  const request = await getRefund(input.id);
  if (!request) return { ok: false, error: "not_found" };
  if (request.status === "paid" && request.txSignature) {
    return { ok: true, request };
  }
  if (request.status !== "pending" && request.status !== "sending") {
    return { ok: false, error: "not_pending" };
  }
  request.status = "paid";
  request.txSignature = input.txSignature.trim();
  request.processedAt = new Date().toISOString();
  await saveRefund(request);
  return { ok: true, request };
}

export async function cancelRefund(input: {
  id: string;
}): Promise<{ ok: true; request: RefundRequest } | { ok: false; error: string }> {
  const request = await getRefund(input.id);
  if (!request) return { ok: false, error: "not_found" };
  if (request.status !== "pending") return { ok: false, error: "not_pending" };
  const restore = await adjustCustomerBalance({
    accountId: request.wallet,
    deltaMicros: request.micros,
    reason: "refund_cancel",
    ref: `cancel:${request.id}`,
  });
  if (!restore.ok) return { ok: false, error: restore.error };
  request.status = "cancelled";
  request.processedAt = new Date().toISOString();
  await saveRefund(request);
  return { ok: true, request };
}

export async function sumPendingRefundMicros(): Promise<number> {
  const pending = await listPendingRefunds(500);
  return pending.reduce((s, r) => s + (r.micros || 0), 0);
}
