/**
 * Solana wallet message auth for /buy key mint + balance reads.
 * Message format is fixed so Phantom `signMessage` can prove ownership.
 */

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const MAX_SKEW_MS = 15 * 60 * 1000;

export function mintKeyMessage(wallet: string, timestampMs: number): string {
  return `Senda API key mint\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

export function balanceMessage(wallet: string, timestampMs: number): string {
  return `Senda balance read\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

export function refundListMessage(wallet: string, timestampMs: number): string {
  return `Senda refund list\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

export function depositSyncMessage(wallet: string, timestampMs: number): string {
  return `Senda deposit sync\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

export function listKeysMessage(wallet: string, timestampMs: number): string {
  return `Senda API key list\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

export function revokeKeyMessage(
  wallet: string,
  prefix: string,
  timestampMs: number,
): string {
  return `Senda API key revoke\nWallet: ${wallet}\nPrefix: ${prefix}\nTs: ${timestampMs}`;
}

export function refundMessage(
  wallet: string,
  destination: string,
  timestampMs: number,
): string {
  return `Senda API balance refund\nWallet: ${wallet}\nDestination: ${destination}\nTs: ${timestampMs}`;
}

export function peerPayoutWalletMessage(
  peerId: string,
  wallet: string,
  timestampMs: number,
): string {
  return `Senda peer payout wallet\nPeer: ${peerId}\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

export function peerPayoutRequestMessage(
  peerId: string,
  wallet: string,
  timestampMs: number,
): string {
  return `Senda peer payout request\nPeer: ${peerId}\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

/** Phantom sign-in for the public earner dashboard (/earn). */
export function earnerDashboardMessage(
  wallet: string,
  timestampMs: number,
): string {
  return `Senda earner dashboard\nWallet: ${wallet}\nTs: ${timestampMs}`;
}

/** Node-key proof that this challenge belongs to this peer (step 1). */
export function peerBindProveMessage(input: {
  challengeId: string;
  nodePubkeyHex: string;
  timestampMs: number;
}): string {
  return [
    "Senda peer bind prove",
    `Challenge: ${input.challengeId}`,
    `Node: ${input.nodePubkeyHex}`,
    `Ts: ${input.timestampMs}`,
  ].join("\n");
}

/**
 * Verify an ed25519 detached signature from the iroh/node key.
 * `nodePubkeyHex` = 64 lowercase hex chars (full EndpointId).
 * `signatureHex` = 128 hex chars (64-byte sig).
 */
export function verifyNodeSignature(input: {
  nodePubkeyHex: string;
  message: string;
  signatureHex: string;
}): { ok: true } | { ok: false; error: string } {
  const pubHex = input.nodePubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubHex)) {
    return { ok: false, error: "invalid_node_pubkey" };
  }
  const sigHex = input.signatureHex.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sigHex)) {
    return { ok: false, error: "invalid_node_signature_encoding" };
  }

  const pubkey = hexToBytes(pubHex);
  const sig = hexToBytes(sigHex);
  const msg = new TextEncoder().encode(input.message);
  const ok = nacl.sign.detached.verify(msg, sig, pubkey);
  if (!ok) return { ok: false, error: "bad_node_signature" };
  return { ok: true };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function verifyWalletSignature(input: {
  wallet: string;
  message: string;
  /** base58 signature from Phantom signMessage */
  signatureBase58: string;
  timestampMs: number;
  nowMs?: number;
}): { ok: true } | { ok: false; error: string } {
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: "invalid_timestamp" };
  }
  if (Math.abs(now - input.timestampMs) > MAX_SKEW_MS) {
    return { ok: false, error: "timestamp_expired" };
  }

  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(input.wallet.trim());
  } catch {
    return { ok: false, error: "invalid_wallet" };
  }

  let sig: Uint8Array;
  try {
    sig = bs58.decode(input.signatureBase58.trim());
  } catch {
    return { ok: false, error: "invalid_signature_encoding" };
  }

  const msg = new TextEncoder().encode(input.message);
  const ok = nacl.sign.detached.verify(msg, sig, pubkey.toBytes());
  if (!ok) return { ok: false, error: "bad_signature" };
  return { ok: true };
}
