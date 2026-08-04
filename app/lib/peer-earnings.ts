/**
 * Phase 5.D — peer USD earnings from *paid* mesh serves.
 *
 * Separate from contributor credits (`senda:credits:*`), which stay
 * tier-weighted instrumentation. This ledger is micro-USD owed for payout.
 *
 * Accrual on paid /v1 mesh serves. Self-serve withdraw + 5.D-auto process
 * (caps / dry-run / AUTO kill switch) — see Decision 4.
 * Liability keys do not expire.
 */

import { randomBytes } from "crypto";
import { getRedis } from "./redis";
import { getRateCardRow, tokensCostMicros } from "./rate-card";
import {
  MIN_WITHDRAW_USDC_ATOMIC,
  peerPayoutDryRun,
  peerPayoutMaxGlobalDailyMicros,
  peerPayoutMaxPeerDailyMicros,
  peerPayoutMaxTicketMicros,
  peerPayoutsAutoEnabled,
  solanaPayoutsConfigured,
} from "./solana-config";
import { shortPeerId } from "./verification-receipts";
import { sendUsdc } from "./solana-usdc-send";

const BALANCE_PREFIX = "senda:peer:usd:balance";
const WALLET_PREFIX = "senda:peer:payout-wallet";
/** Reverse index: Solana wallet → short peer id (for /earn Phantom sign-in). */
const WALLET_PEER_PREFIX = "senda:peer:wallet-peer";
const PENDING_ZSET = "senda:peer:payout:pending";
const PAYOUT_PREFIX = "senda:peer:payout";
const PAYOUT_STATUS_PREFIX = "senda:peer:payout:status";
const ACCRUE_REQ_PREFIX = "senda:peer:usd:req";
const SPENT_DAY_PREFIX = "senda:peer:payout:spent";

type MemoryStore = {
  balances: Map<string, number>;
  wallets: Map<string, string>;
  /** wallet → peerId */
  walletPeers: Map<string, string>;
  pending: Map<string, PeerPayoutRequest>;
  accruedReqs: Set<string>;
  /** `${day}` or `${day}:${peerId}` → micros sent */
  spent: Map<string, number>;
};

const memory: MemoryStore = {
  balances: new Map(),
  wallets: new Map(),
  walletPeers: new Map(),
  pending: new Map(),
  accruedReqs: new Set(),
  spent: new Map(),
};

function useMemory(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.SENDA_CUST_LEDGER_MEMORY === "1"
  );
}

export function peerEarningsStoreReady(): boolean {
  return getRedis() != null || useMemory();
}

export function resetPeerEarningsMemory(): void {
  memory.balances.clear();
  memory.wallets.clear();
  memory.walletPeers.clear();
  memory.pending.clear();
  memory.accruedReqs.clear();
  memory.spent.clear();
}

/** UTC calendar day key YYYYMMDD for daily spend caps. */
export function payoutUtcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

async function getSpentMicros(key: string): Promise<number> {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<number | string | null>(
        `${SPENT_DAY_PREFIX}:${key}`,
      );
      const n = raw == null ? 0 : Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }
  return memory.spent.get(key) ?? 0;
}

async function addSpentMicros(key: string, micros: number): Promise<void> {
  if (micros <= 0) return;
  const redis = getRedis();
  if (redis) {
    try {
      const full = `${SPENT_DAY_PREFIX}:${key}`;
      await redis.incrby(full, micros);
      // Keep ~3 days of cap windows.
      await redis.expire(full, 3 * 24 * 3600);
    } catch {
      /* best-effort; next reconcile catches drift */
    }
    return;
  }
  memory.spent.set(key, (memory.spent.get(key) ?? 0) + micros);
}

export function newPeerPayoutId(): string {
  return `po_${randomBytes(12).toString("hex")}`;
}

export function peerUsdForCompletion(input: {
  modelId: string;
  completionTokens: number;
}): number {
  const row = getRateCardRow(input.modelId);
  return tokensCostMicros(
    input.completionTokens,
    row.peer_completion_per_mtok_usd_micros,
  );
}

export async function recordPeerUsdEarnings(input: {
  peerId: string;
  modelId: string;
  completionTokens: number;
  requestId?: string;
}): Promise<number> {
  const peerId = shortPeerId(input.peerId);
  if (!peerId || input.completionTokens <= 0) return 0;
  const micros = peerUsdForCompletion(input);
  if (micros <= 0) return 0;

  const reqId = input.requestId?.trim();
  if (reqId) {
    const redis = getRedis();
    if (redis) {
      try {
        const claimed = await redis.set(`${ACCRUE_REQ_PREFIX}:${reqId}`, "1", {
          nx: true,
        });
        if (claimed !== "OK") return 0;
      } catch {
        return 0;
      }
    } else if (useMemory()) {
      if (memory.accruedReqs.has(reqId)) return 0;
      memory.accruedReqs.add(reqId);
    }
  }

  const redis = getRedis();
  if (redis) {
    try {
      const key = `${BALANCE_PREFIX}:${peerId}`;
      const next = await redis.incrby(key, micros);
      return Number(next);
    } catch {
      return 0;
    }
  }
  if (!useMemory()) return 0;
  const next = (memory.balances.get(peerId) ?? 0) + micros;
  memory.balances.set(peerId, next);
  return next;
}

export async function getPeerUsdBalance(peerId: string): Promise<number | null> {
  const id = shortPeerId(peerId);
  if (!id) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<number | string | null>(
        `${BALANCE_PREFIX}:${id}`,
      );
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

export async function setPeerPayoutWallet(
  peerId: string,
  wallet: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = shortPeerId(peerId);
  const w = wallet.trim();
  if (!id || !w || w.length < 32) return { ok: false, error: "invalid_input" };
  const prev = await getPeerPayoutWallet(id);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`${WALLET_PREFIX}:${id}`, w);
      await redis.set(`${WALLET_PEER_PREFIX}:${w}`, id);
      if (prev && prev !== w) {
        try {
          await redis.del(`${WALLET_PEER_PREFIX}:${prev}`);
        } catch {
          /* best-effort */
        }
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "redis_error" };
    }
  }
  if (!useMemory()) return { ok: false, error: "store_unavailable" };
  if (prev && prev !== w) memory.walletPeers.delete(prev);
  memory.wallets.set(id, w);
  memory.walletPeers.set(w, id);
  return { ok: true };
}

export async function getPeerPayoutWallet(
  peerId: string,
): Promise<string | null> {
  const id = shortPeerId(peerId);
  if (!id) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const w = await redis.get<string | null>(`${WALLET_PREFIX}:${id}`);
      return w?.trim() || null;
    } catch {
      return null;
    }
  }
  return memory.wallets.get(id) ?? null;
}

/**
 * Resolve the short peer id bound to a Solana payout wallet.
 * Written on bind; also backfilled by {@link ensureWalletPeerIndex}.
 */
export async function getPeerIdForWallet(
  wallet: string,
): Promise<string | null> {
  const w = wallet.trim();
  if (!w || w.length < 32) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const id = await redis.get<string | null>(`${WALLET_PEER_PREFIX}:${w}`);
      return id?.trim() || null;
    } catch {
      return null;
    }
  }
  if (!useMemory()) return null;
  return memory.walletPeers.get(w) ?? null;
}

/**
 * Ensure wallet → peer reverse index exists (backfill for binds that
 * predated the index). Safe to call on every peer-earnings read.
 */
export async function ensureWalletPeerIndex(
  peerId: string,
  wallet: string,
): Promise<void> {
  const id = shortPeerId(peerId);
  const w = wallet.trim();
  if (!id || !w || w.length < 32) return;
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`${WALLET_PEER_PREFIX}:${w}`, id);
    } catch {
      /* ignore */
    }
    return;
  }
  if (useMemory()) memory.walletPeers.set(w, id);
}

export type PeerPayoutStatus =
  | "pending"
  | "pending_ops"
  | "sending"
  | "sent"
  | "failed";

export type PeerPayoutRequest = {
  id: string;
  peerId: string;
  wallet: string;
  micros: number;
  status: PeerPayoutStatus;
  createdAt: string;
  txSignature?: string;
  error?: string;
};

/**
 * Atomic: if balance ≥ min, drain to 0 and create payout ticket with micros.
 * ARGV: min, score, id, status, peerId, wallet, createdAt
 */
const DRAIN_PAYOUT_LUA = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
local min = tonumber(ARGV[1])
if bal < min then
  return {-1, bal}
end
redis.call('SET', KEYS[1], '0')
local payload = '{"id":"' .. ARGV[3] .. '","peerId":"' .. ARGV[5] .. '","wallet":"' .. ARGV[6] .. '","micros":' .. bal .. ',"status":"' .. ARGV[4] .. '","createdAt":"' .. ARGV[7] .. '"}'
redis.call('SET', KEYS[2], payload)
redis.call('SET', KEYS[4], ARGV[4])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
return {1, bal}
`;

/** Claim pending/pending_ops → sending. Winner only. */
const CLAIM_PAYOUT_LUA = `
local st = redis.call('GET', KEYS[1])
if st == false or st == nil then return {0} end
if st ~= 'pending' and st ~= 'pending_ops' then return {0} end
redis.call('SET', KEYS[1], 'sending')
return {1}
`;

export async function requestPeerPayout(input: {
  peerId: string;
  payoutId: string;
}): Promise<
  | { ok: true; request: PeerPayoutRequest }
  | { ok: false; error: string }
> {
  const peerId = shortPeerId(input.peerId);
  if (!peerId) return { ok: false, error: "invalid_peer" };
  const wallet = await getPeerPayoutWallet(peerId);
  if (!wallet) return { ok: false, error: "wallet_not_registered" };

  const status: PeerPayoutStatus = solanaPayoutsConfigured()
    ? "pending"
    : "pending_ops";
  const createdAt = new Date().toISOString();

  const redis = getRedis();
  if (redis) {
    try {
      const balKey = `${BALANCE_PREFIX}:${peerId}`;
      const script = redis.createScript<number[]>(DRAIN_PAYOUT_LUA);
      const result = await script.eval(
        [
          balKey,
          `${PAYOUT_PREFIX}:${input.payoutId}`,
          PENDING_ZSET,
          `${PAYOUT_STATUS_PREFIX}:${input.payoutId}`,
        ],
        [
          String(MIN_WITHDRAW_USDC_ATOMIC),
          String(Date.now()),
          input.payoutId,
          status,
          peerId,
          wallet,
          createdAt,
        ],
      );
      const code = Number(result?.[0]);
      const micros = Number(result?.[1]);
      if (code === -1) return { ok: false, error: "below_minimum" };
      if (code !== 1 || !Number.isFinite(micros) || micros < MIN_WITHDRAW_USDC_ATOMIC) {
        return { ok: false, error: "below_minimum" };
      }
      const request: PeerPayoutRequest = {
        id: input.payoutId,
        peerId,
        wallet,
        micros,
        status,
        createdAt,
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
  const bal = memory.balances.get(peerId) ?? 0;
  if (bal < MIN_WITHDRAW_USDC_ATOMIC) return { ok: false, error: "below_minimum" };
  memory.balances.set(peerId, 0);
  const request: PeerPayoutRequest = {
    id: input.payoutId,
    peerId,
    wallet,
    micros: bal,
    status,
    createdAt,
  };
  memory.pending.set(request.id, request);
  return { ok: true, request };
}

export async function listPendingPeerPayouts(
  limit = 20,
): Promise<PeerPayoutRequest[]> {
  const redis = getRedis();
  if (redis) {
    try {
      const ids = await redis.zrange<string[]>(PENDING_ZSET, 0, limit - 1);
      const out: PeerPayoutRequest[] = [];
      for (const id of ids) {
        const raw = await redis.get<string | null>(`${PAYOUT_PREFIX}:${id}`);
        if (!raw) continue;
        const req =
          typeof raw === "string" ? (JSON.parse(raw) as PeerPayoutRequest) : raw;
        if (
          req.status === "pending" ||
          req.status === "pending_ops" ||
          req.status === "sending"
        ) {
          out.push(req);
        }
      }
      return out;
    } catch {
      return [];
    }
  }
  return [...memory.pending.values()]
    .filter(
      (p) =>
        p.status === "pending" ||
        p.status === "pending_ops" ||
        p.status === "sending",
    )
    .slice(0, limit);
}

export async function updatePeerPayout(
  request: PeerPayoutRequest,
): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${PAYOUT_PREFIX}:${request.id}`, JSON.stringify(request));
    await redis.set(`${PAYOUT_STATUS_PREFIX}:${request.id}`, request.status);
    if (request.status === "sent" || request.status === "failed") {
      await redis.zrem(PENDING_ZSET, request.id);
    }
    return;
  }
  memory.pending.set(request.id, request);
}

async function claimPeerPayout(id: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      const script = redis.createScript<number[]>(CLAIM_PAYOUT_LUA);
      const result = await script.eval(
        [`${PAYOUT_STATUS_PREFIX}:${id}`],
        [],
      );
      return Number(result?.[0]) === 1;
    } catch {
      return false;
    }
  }
  const req = memory.pending.get(id);
  if (!req) return false;
  if (req.status !== "pending" && req.status !== "pending_ops") return false;
  req.status = "sending";
  memory.pending.set(id, req);
  return true;
}

/** Restore micros to peer balance after a failed send. */
export async function restorePeerUsd(
  peerId: string,
  micros: number,
): Promise<void> {
  const id = shortPeerId(peerId);
  if (!id || micros <= 0) return;
  const redis = getRedis();
  if (redis) {
    await redis.incrby(`${BALANCE_PREFIX}:${id}`, micros);
    return;
  }
  memory.balances.set(id, (memory.balances.get(id) ?? 0) + micros);
}

/**
 * Ops/canary: credit peer USD liability (same ledger as restore).
 * Returns new balance micros.
 */
export async function creditPeerUsd(
  peerId: string,
  micros: number,
): Promise<number> {
  await restorePeerUsd(peerId, micros);
  return getPeerUsdBalance(peerId);
}

export type ProcessPeerPayoutsOpts = {
  /**
   * Ops `admin-payout` process: bypass SENDA_PEER_PAYOUTS_AUTO.
   * Still honors dry-run, caps, and payer config.
   */
  force?: boolean;
};

export type ProcessPeerPayoutsResult = {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  dryRun: number;
  autoDisabled: boolean;
  wouldSend: Array<{ id: string; peerId: string; micros: number; wallet: string }>;
};

/**
 * Attempt on-chain send for pending payouts when payer secret is configured.
 * Claim lock prevents double-send across overlapping workers.
 *
 * 5.D-auto: AUTO kill switch (cron), dry-run, per-ticket / daily caps.
 */
export async function processPendingPeerPayouts(
  limit = 5,
  opts: ProcessPeerPayoutsOpts = {},
): Promise<ProcessPeerPayoutsResult> {
  const wouldSend: ProcessPeerPayoutsResult["wouldSend"] = [];
  const empty = (
    extra: Partial<ProcessPeerPayoutsResult> = {},
  ): ProcessPeerPayoutsResult => ({
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    dryRun: 0,
    autoDisabled: false,
    wouldSend,
    ...extra,
  });

  if (!opts.force && !peerPayoutsAutoEnabled()) {
    return empty({ autoDisabled: true });
  }

  const dryRun = peerPayoutDryRun();
  const maxTicket = peerPayoutMaxTicketMicros();
  const maxPeerDay = peerPayoutMaxPeerDailyMicros();
  const maxGlobalDay = peerPayoutMaxGlobalDailyMicros();
  const day = payoutUtcDayKey();

  const pending = await listPendingPeerPayouts(limit);
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let dryRunCount = 0;

  let globalSpent = await getSpentMicros(day);

  for (const req of pending) {
    if (req.status === "sending") {
      skipped += 1;
      continue;
    }
    if (req.status === "pending_ops" && !solanaPayoutsConfigured()) {
      skipped += 1;
      continue;
    }
    if (!solanaPayoutsConfigured()) {
      req.status = "pending_ops";
      await updatePeerPayout(req);
      skipped += 1;
      continue;
    }

    if (req.micros > maxTicket) {
      const claimedOver = await claimPeerPayout(req.id);
      if (!claimedOver) {
        skipped += 1;
        continue;
      }
      processed += 1;
      req.status = "failed";
      req.error = `above_ticket_cap:${req.micros}>${maxTicket}`;
      await updatePeerPayout(req);
      await restorePeerUsd(req.peerId, req.micros);
      failed += 1;
      continue;
    }

    const peerSpent = await getSpentMicros(`${day}:${req.peerId}`);
    if (
      peerSpent + req.micros > maxPeerDay ||
      globalSpent + req.micros > maxGlobalDay
    ) {
      // Leave pending for a later window / raised caps.
      skipped += 1;
      continue;
    }

    if (dryRun) {
      dryRunCount += 1;
      wouldSend.push({
        id: req.id,
        peerId: req.peerId,
        micros: req.micros,
        wallet: req.wallet,
      });
      skipped += 1;
      continue;
    }

    const claimed = await claimPeerPayout(req.id);
    if (!claimed) {
      skipped += 1;
      continue;
    }
    processed += 1;
    req.status = "sending";
    await updatePeerPayout(req);

    const result = await sendUsdc({
      destinationWallet: req.wallet,
      amountAtomic: req.micros,
    });
    if (result.ok) {
      req.status = "sent";
      req.txSignature = result.signature;
      await updatePeerPayout(req);
      await addSpentMicros(day, req.micros);
      await addSpentMicros(`${day}:${req.peerId}`, req.micros);
      globalSpent += req.micros;
      sent += 1;
    } else {
      // sendAndConfirm failed — treat as failed + restore.
      // If a future path returns "submitted_unknown", do not restore.
      req.status = "failed";
      req.error = result.error;
      await updatePeerPayout(req);
      await restorePeerUsd(req.peerId, req.micros);
      failed += 1;
    }
  }

  return {
    processed,
    sent,
    failed,
    skipped,
    dryRun: dryRunCount,
    autoDisabled: false,
    wouldSend,
  };
}

/** Sum all peer USD balances (SCAN — ops reconcile). */
export async function sumPeerUsdLiabilities(): Promise<number> {
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

export async function sumPendingPeerPayoutMicros(): Promise<number> {
  const pending = await listPendingPeerPayouts(500);
  return pending.reduce((s, p) => s + (p.micros || 0), 0);
}
