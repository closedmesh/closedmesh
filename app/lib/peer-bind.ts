/**
 * Secure peer → Solana wallet bind (two-step).
 *
 * 1) Desktop proves control of the iroh node key over a challenge.
 * 2) Browser (Phantom) attaches a Solana wallet to that proven challenge.
 *
 * Challenge ids are unguessable capabilities (128-bit); TTL 10 minutes.
 */

import { randomBytes } from "crypto";
import { getRedis } from "./redis";
import { shortPeerId } from "./verification-receipts";
import { setPeerPayoutWallet } from "./peer-earnings";
import {
  peerBindProveMessage,
  peerPayoutWalletMessage,
  verifyNodeSignature,
  verifyWalletSignature,
} from "./wallet-auth";

const CHALLENGE_PREFIX = "senda:peer:bind:chal";
const PUBKEY_PREFIX = "senda:peer:node-pubkey";
const CHALLENGE_TTL_SEC = 10 * 60;
const MAX_SKEW_MS = 15 * 60 * 1000;

type ChallengeRecord = {
  createdAt: number;
  /** Set after node-key proof. */
  nodePubkeyHex?: string;
  provenAt?: number;
};

const memoryChallenges = new Map<string, ChallengeRecord>();
const memoryPubkeys = new Map<string, string>();

function useMemory(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.SENDA_CUST_LEDGER_MEMORY === "1"
  );
}

export function resetPeerBindMemory(): void {
  memoryChallenges.clear();
  memoryPubkeys.clear();
}

export function peerSelfServePayoutsEnabled(): boolean {
  const raw = process.env.SENDA_PEER_PAYOUTS_SELF_SERVE?.trim();
  if (raw === "0" || raw?.toLowerCase() === "false") return false;
  return true;
}

export async function createPeerBindChallenge(): Promise<{
  challengeId: string;
  expiresAt: string;
  timestampMs: number;
}> {
  const challengeId = `pb_${randomBytes(16).toString("hex")}`;
  const timestampMs = Date.now();
  const expiresAt = new Date(
    timestampMs + CHALLENGE_TTL_SEC * 1000,
  ).toISOString();
  const record: ChallengeRecord = { createdAt: timestampMs };

  const redis = getRedis();
  if (redis) {
    await redis.set(`${CHALLENGE_PREFIX}:${challengeId}`, JSON.stringify(record), {
      ex: CHALLENGE_TTL_SEC,
    });
    return { challengeId, expiresAt, timestampMs };
  }
  if (!useMemory()) throw new Error("store_unavailable");
  memoryChallenges.set(challengeId, record);
  return { challengeId, expiresAt, timestampMs };
}

async function loadChallenge(
  challengeId: string,
): Promise<ChallengeRecord | null> {
  const id = challengeId.trim();
  if (!id.startsWith("pb_") || id.length < 10) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<string | null>(`${CHALLENGE_PREFIX}:${id}`);
      if (raw == null) return null;
      return typeof raw === "string"
        ? (JSON.parse(raw) as ChallengeRecord)
        : (raw as ChallengeRecord);
    } catch {
      return null;
    }
  }
  if (!useMemory()) return null;
  return memoryChallenges.get(id) ?? null;
}

async function saveChallenge(
  challengeId: string,
  record: ChallengeRecord,
): Promise<boolean> {
  const id = challengeId.trim();
  const redis = getRedis();
  if (redis) {
    try {
      const ttl = Math.max(
        1,
        CHALLENGE_TTL_SEC - Math.floor((Date.now() - record.createdAt) / 1000),
      );
      await redis.set(`${CHALLENGE_PREFIX}:${id}`, JSON.stringify(record), {
        ex: ttl,
      });
      return true;
    } catch {
      return false;
    }
  }
  if (!useMemory()) return false;
  memoryChallenges.set(id, record);
  return true;
}

async function deleteChallenge(challengeId: string): Promise<void> {
  const id = challengeId.trim();
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`${CHALLENGE_PREFIX}:${id}`);
    } catch {
      /* ignore */
    }
    return;
  }
  memoryChallenges.delete(id);
}

function challengeFresh(record: ChallengeRecord, nowMs: number): boolean {
  return nowMs - record.createdAt <= CHALLENGE_TTL_SEC * 1000;
}

export async function provePeerBindNode(input: {
  challengeId: string;
  nodePubkeyHex: string;
  nodeSignatureHex: string;
  timestampMs: number;
  nowMs?: number;
}): Promise<
  | { ok: true; peerId: string; challengeId: string }
  | { ok: false; error: string }
> {
  if (!peerSelfServePayoutsEnabled()) {
    return { ok: false, error: "self_serve_disabled" };
  }
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: "invalid_timestamp" };
  }
  if (Math.abs(now - input.timestampMs) > MAX_SKEW_MS) {
    return { ok: false, error: "timestamp_expired" };
  }

  const nodePubkeyHex = input.nodePubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nodePubkeyHex)) {
    return { ok: false, error: "invalid_node_pubkey" };
  }
  const peerId = shortPeerId(nodePubkeyHex);

  const record = await loadChallenge(input.challengeId);
  if (!record) return { ok: false, error: "challenge_not_found" };
  if (!challengeFresh(record, now)) {
    await deleteChallenge(input.challengeId);
    return { ok: false, error: "challenge_expired" };
  }
  if (record.nodePubkeyHex) {
    return { ok: false, error: "challenge_already_proven" };
  }

  const message = peerBindProveMessage({
    challengeId: input.challengeId.trim(),
    nodePubkeyHex,
    timestampMs: input.timestampMs,
  });
  const nodeOk = verifyNodeSignature({
    nodePubkeyHex,
    message,
    signatureHex: input.nodeSignatureHex,
  });
  if (!nodeOk.ok) return nodeOk;

  const saved = await saveChallenge(input.challengeId.trim(), {
    ...record,
    nodePubkeyHex,
    provenAt: now,
  });
  if (!saved) return { ok: false, error: "store_unavailable" };
  return { ok: true, peerId, challengeId: input.challengeId.trim() };
}

export async function attachPeerBindWallet(input: {
  challengeId: string;
  wallet: string;
  walletSignatureBase58: string;
  timestampMs: number;
  nowMs?: number;
}): Promise<
  | { ok: true; peerId: string; wallet: string }
  | { ok: false; error: string }
> {
  if (!peerSelfServePayoutsEnabled()) {
    return { ok: false, error: "self_serve_disabled" };
  }
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: "invalid_timestamp" };
  }
  if (Math.abs(now - input.timestampMs) > MAX_SKEW_MS) {
    return { ok: false, error: "timestamp_expired" };
  }

  const record = await loadChallenge(input.challengeId);
  if (!record) return { ok: false, error: "challenge_not_found" };
  if (!challengeFresh(record, now)) {
    await deleteChallenge(input.challengeId);
    return { ok: false, error: "challenge_expired" };
  }
  if (!record.nodePubkeyHex) {
    return { ok: false, error: "node_not_proven" };
  }

  const peerId = shortPeerId(record.nodePubkeyHex);
  const wallet = input.wallet.trim();
  const walletMessage = peerPayoutWalletMessage(
    peerId,
    wallet,
    input.timestampMs,
  );
  const walletOk = verifyWalletSignature({
    wallet,
    message: walletMessage,
    signatureBase58: input.walletSignatureBase58,
    timestampMs: input.timestampMs,
    nowMs: now,
  });
  if (!walletOk.ok) return walletOk;

  // Consume challenge before writing wallet (best-effort atomicity).
  await deleteChallenge(input.challengeId);

  const set = await setPeerPayoutWallet(peerId, wallet);
  if (!set.ok) return { ok: false, error: set.error };
  await setPeerNodePubkey(peerId, record.nodePubkeyHex);
  return { ok: true, peerId, wallet };
}

export async function getPeerBindChallengeStatus(
  challengeId: string,
): Promise<
  | {
      ok: true;
      status: "pending_node" | "pending_wallet" | "expired";
      peerId?: string;
      expiresAt: string;
    }
  | { ok: false; error: string }
> {
  const record = await loadChallenge(challengeId);
  if (!record) return { ok: false, error: "challenge_not_found" };
  const expiresAt = new Date(
    record.createdAt + CHALLENGE_TTL_SEC * 1000,
  ).toISOString();
  if (!challengeFresh(record, Date.now())) {
    return { ok: true, status: "expired", expiresAt };
  }
  if (record.nodePubkeyHex) {
    return {
      ok: true,
      status: "pending_wallet",
      peerId: shortPeerId(record.nodePubkeyHex),
      expiresAt,
    };
  }
  return { ok: true, status: "pending_node", expiresAt };
}

async function setPeerNodePubkey(
  peerId: string,
  nodePubkeyHex: string,
): Promise<void> {
  const id = shortPeerId(peerId);
  const hex = nodePubkeyHex.trim().toLowerCase();
  if (!id || !/^[0-9a-f]{64}$/.test(hex)) return;
  const redis = getRedis();
  if (redis) {
    await redis.set(`${PUBKEY_PREFIX}:${id}`, hex);
    return;
  }
  if (useMemory()) memoryPubkeys.set(id, hex);
}

export async function getPeerNodePubkey(
  peerId: string,
): Promise<string | null> {
  const id = shortPeerId(peerId);
  if (!id) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const v = await redis.get<string | null>(`${PUBKEY_PREFIX}:${id}`);
      return v?.trim() || null;
    } catch {
      return null;
    }
  }
  return memoryPubkeys.get(id) ?? null;
}
