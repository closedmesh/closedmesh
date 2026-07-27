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
