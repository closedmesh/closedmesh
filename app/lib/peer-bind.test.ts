import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  attachPeerBindWallet,
  createPeerBindChallenge,
  provePeerBindNode,
  resetPeerBindMemory,
} from "./peer-bind";
import { getPeerPayoutWallet, resetPeerEarningsMemory } from "./peer-earnings";
import {
  peerBindProveMessage,
  peerPayoutWalletMessage,
} from "./wallet-auth";
import { shortPeerId } from "./verification-receipts";

afterEach(() => {
  resetPeerBindMemory();
  resetPeerEarningsMemory();
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("peer bind two-step", () => {
  it("proves node then attaches wallet", async () => {
    const seed = nacl.randomBytes(32);
    const nodeKp = nacl.sign.keyPair.fromSeed(seed);
    const nodePubkeyHex = hex(nodeKp.publicKey);
    const peerId = shortPeerId(nodePubkeyHex);
    const walletKp = Keypair.generate();
    const wallet = walletKp.publicKey.toBase58();

    const { challengeId, timestampMs } = await createPeerBindChallenge();
    const proveMsg = peerBindProveMessage({
      challengeId,
      nodePubkeyHex,
      timestampMs,
    });
    const nodeSignatureHex = hex(
      nacl.sign.detached(new TextEncoder().encode(proveMsg), nodeKp.secretKey),
    );

    const proven = await provePeerBindNode({
      challengeId,
      nodePubkeyHex,
      nodeSignatureHex,
      timestampMs,
      nowMs: timestampMs,
    });
    expect(proven).toEqual({ ok: true, peerId, challengeId });

    const attachTs = timestampMs + 1000;
    const walletMessage = peerPayoutWalletMessage(peerId, wallet, attachTs);
    const walletSignatureBase58 = bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(walletMessage),
        walletKp.secretKey,
      ),
    );

    const attached = await attachPeerBindWallet({
      challengeId,
      wallet,
      walletSignatureBase58,
      timestampMs: attachTs,
      nowMs: attachTs,
    });
    expect(attached).toEqual({ ok: true, peerId, wallet });
    await expect(getPeerPayoutWallet(peerId)).resolves.toBe(wallet);
  });

  it("rejects wallet attach before node proof", async () => {
    const { challengeId, timestampMs } = await createPeerBindChallenge();
    const walletKp = Keypair.generate();
    const wallet = walletKp.publicKey.toBase58();
    const walletMessage = peerPayoutWalletMessage(
      "deadbeef01",
      wallet,
      timestampMs,
    );
    const walletSignatureBase58 = bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(walletMessage),
        walletKp.secretKey,
      ),
    );
    const result = await attachPeerBindWallet({
      challengeId,
      wallet,
      walletSignatureBase58,
      timestampMs,
      nowMs: timestampMs,
    });
    expect(result).toEqual({ ok: false, error: "node_not_proven" });
  });

  it("rejects bad node signature", async () => {
    const seed = nacl.randomBytes(32);
    const nodeKp = nacl.sign.keyPair.fromSeed(seed);
    const nodePubkeyHex = hex(nodeKp.publicKey);
    const { challengeId, timestampMs } = await createPeerBindChallenge();
    const result = await provePeerBindNode({
      challengeId,
      nodePubkeyHex,
      nodeSignatureHex: "ab".repeat(64),
      timestampMs,
      nowMs: timestampMs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("bad_node_signature");
  });

  it("consumes challenge after attach", async () => {
    const seed = nacl.randomBytes(32);
    const nodeKp = nacl.sign.keyPair.fromSeed(seed);
    const nodePubkeyHex = hex(nodeKp.publicKey);
    const peerId = shortPeerId(nodePubkeyHex);
    const walletKp = Keypair.generate();
    const wallet = walletKp.publicKey.toBase58();
    const { challengeId, timestampMs } = await createPeerBindChallenge();
    const proveMsg = peerBindProveMessage({
      challengeId,
      nodePubkeyHex,
      timestampMs,
    });
    await provePeerBindNode({
      challengeId,
      nodePubkeyHex,
      nodeSignatureHex: hex(
        nacl.sign.detached(new TextEncoder().encode(proveMsg), nodeKp.secretKey),
      ),
      timestampMs,
      nowMs: timestampMs,
    });
    const walletMessage = peerPayoutWalletMessage(peerId, wallet, timestampMs);
    const walletSignatureBase58 = bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(walletMessage),
        walletKp.secretKey,
      ),
    );
    const first = await attachPeerBindWallet({
      challengeId,
      wallet,
      walletSignatureBase58,
      timestampMs,
      nowMs: timestampMs,
    });
    expect(first.ok).toBe(true);
    const second = await attachPeerBindWallet({
      challengeId,
      wallet,
      walletSignatureBase58,
      timestampMs,
      nowMs: timestampMs,
    });
    expect(second).toEqual({ ok: false, error: "challenge_not_found" });
  });
});
