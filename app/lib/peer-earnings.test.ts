import { afterEach, describe, expect, it } from "vitest";
import {
  getPeerIdForWallet,
  getPeerUsdBalance,
  peerUsdForCompletion,
  recordPeerUsdEarnings,
  requestPeerPayout,
  resetPeerEarningsMemory,
  setPeerPayoutWallet,
} from "./peer-earnings";
import { MIN_WITHDRAW_USDC_ATOMIC } from "./solana-config";
import { usdToMicros } from "./rate-card";

afterEach(() => {
  resetPeerEarningsMemory();
});

describe("peerUsdForCompletion", () => {
  it("prices daily-driver completion at peer rate", () => {
    // $0.30 / MTok → 1M tokens = 300_000 micros; 1000 tokens = 300 micros
    expect(
      peerUsdForCompletion({
        modelId: "Qwen3-8B-Q4_K_M",
        completionTokens: 1000,
      }),
    ).toBe(300);
  });
});

describe("recordPeerUsdEarnings", () => {
  it("accrues micro-USD on paid mesh serves", async () => {
    const next = await recordPeerUsdEarnings({
      peerId: "abcdefghij123",
      modelId: "Qwen3-8B-Q4_K_M",
      completionTokens: 1_000_000,
    });
    expect(next).toBe(usdToMicros(0.3));
    await expect(getPeerUsdBalance("abcdefghij123")).resolves.toBe(
      usdToMicros(0.3),
    );
  });

  it("is idempotent per requestId", async () => {
    const peerId = "idempeer01";
    const a = await recordPeerUsdEarnings({
      peerId,
      modelId: "Qwen3-8B-Q4_K_M",
      completionTokens: 1_000_000,
      requestId: "req-1",
    });
    const b = await recordPeerUsdEarnings({
      peerId,
      modelId: "Qwen3-8B-Q4_K_M",
      completionTokens: 1_000_000,
      requestId: "req-1",
    });
    expect(a).toBe(usdToMicros(0.3));
    expect(b).toBe(0);
    await expect(getPeerUsdBalance(peerId)).resolves.toBe(usdToMicros(0.3));
  });
});

describe("wallet → peer reverse index", () => {
  it("resolves peer id from payout wallet after bind", async () => {
    const wallet = "So11111111111111111111111111111111111111112";
    await setPeerPayoutWallet("peerWALLET1", wallet);
    await expect(getPeerIdForWallet(wallet)).resolves.toBe(
      "peerWALLET1".slice(0, 10),
    );
  });

  it("moves reverse index on rebind", async () => {
    const a = "So11111111111111111111111111111111111111112";
    const b = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    await setPeerPayoutWallet("peerREBIND1", a);
    await setPeerPayoutWallet("peerREBIND1", b);
    await expect(getPeerIdForWallet(a)).resolves.toBeNull();
    await expect(getPeerIdForWallet(b)).resolves.toBe(
      "peerREBIND1".slice(0, 10),
    );
  });
});

describe("requestPeerPayout", () => {
  it("rejects below minimum", async () => {
    await setPeerPayoutWallet("peerAAAAAA", "11111111111111111111111111111111");
    await recordPeerUsdEarnings({
      peerId: "peerAAAAAA",
      modelId: "Qwen3-8B-Q4_K_M",
      completionTokens: 1000,
    });
    const result = await requestPeerPayout({
      peerId: "peerAAAAAA",
      payoutId: "po_test1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("below_minimum");
  });

  it("drains balance into a payout ticket", async () => {
    const peerId = "peerBBBBBB";
    await setPeerPayoutWallet(
      peerId,
      "So11111111111111111111111111111111111111112",
    );
    // Accrue above $10 minimum via many large chunks.
    const tokensNeeded =
      Math.ceil(MIN_WITHDRAW_USDC_ATOMIC / peerUsdForCompletion({
        modelId: "Qwen3-8B-Q4_K_M",
        completionTokens: 1_000_000,
      })) * 1_000_000;
    await recordPeerUsdEarnings({
      peerId,
      modelId: "Qwen3-8B-Q4_K_M",
      completionTokens: tokensNeeded,
    });
    const bal = await getPeerUsdBalance(peerId);
    expect(bal).toBeGreaterThanOrEqual(MIN_WITHDRAW_USDC_ATOMIC);

    const result = await requestPeerPayout({
      peerId,
      payoutId: "po_test2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.micros).toBe(bal);
      expect(["pending", "pending_ops"]).toContain(result.request.status);
    }
    await expect(getPeerUsdBalance(peerId)).resolves.toBe(0);
  });
});
