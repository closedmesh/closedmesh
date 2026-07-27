import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { mintKeyMessage, verifyWalletSignature } from "./wallet-auth";

describe("verifyWalletSignature", () => {
  it("accepts a valid Phantom-style signature", () => {
    const kp = Keypair.generate();
    const ts = Date.now();
    const message = mintKeyMessage(kp.publicKey.toBase58(), ts);
    const sig = nacl.sign.detached(
      new TextEncoder().encode(message),
      kp.secretKey,
    );
    const result = verifyWalletSignature({
      wallet: kp.publicKey.toBase58(),
      message,
      signatureBase58: bs58.encode(sig),
      timestampMs: ts,
      nowMs: ts,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects expired timestamps", () => {
    const kp = Keypair.generate();
    const ts = Date.now() - 60 * 60 * 1000;
    const message = mintKeyMessage(kp.publicKey.toBase58(), ts);
    const sig = nacl.sign.detached(
      new TextEncoder().encode(message),
      kp.secretKey,
    );
    const result = verifyWalletSignature({
      wallet: kp.publicKey.toBase58(),
      message,
      signatureBase58: bs58.encode(sig),
      timestampMs: ts,
      nowMs: Date.now(),
    });
    expect(result).toEqual({ ok: false, error: "timestamp_expired" });
  });
});
