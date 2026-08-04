import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPeerIdForWallet,
  getPeerUsdBalance,
  listPeerPayoutHistory,
  listPendingPeerPayouts,
  peerUsdForCompletion,
  processPendingPeerPayouts,
  recordPeerUsdEarnings,
  requestPeerPayout,
  resetPeerEarningsMemory,
  setPeerPayoutWallet,
  sumPaidOutPeerUsd,
  updatePeerPayout,
} from "./peer-earnings";
import { MIN_WITHDRAW_USDC_ATOMIC } from "./solana-config";
import { usdToMicros } from "./rate-card";
import { sendUsdc } from "./solana-usdc-send";

vi.mock("./solana-usdc-send", () => ({
  sendUsdc: vi.fn(),
}));

const PAYOUT_ENV = [
  "SENDA_SOLANA_TREASURY",
  "SENDA_SOLANA_PAYER_SECRET",
  "SENDA_PEER_PAYOUTS_AUTO",
  "SENDA_PAYOUT_DRY_RUN",
  "SENDA_PAYOUT_MAX_TICKET_USD",
  "SENDA_PAYOUT_MAX_PEER_DAILY_USD",
  "SENDA_PAYOUT_MAX_GLOBAL_DAILY_USD",
] as const;

let savedPayoutEnv: Partial<Record<(typeof PAYOUT_ENV)[number], string | undefined>> =
  {};

beforeEach(() => {
  savedPayoutEnv = {};
  for (const k of PAYOUT_ENV) savedPayoutEnv[k] = process.env[k];
  vi.mocked(sendUsdc).mockReset();
});

afterEach(() => {
  resetPeerEarningsMemory();
  for (const k of PAYOUT_ENV) {
    if (savedPayoutEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedPayoutEnv[k];
  }
});

async function fundAboveMin(peerId: string): Promise<number> {
  const tokensNeeded =
    Math.ceil(
      MIN_WITHDRAW_USDC_ATOMIC /
        peerUsdForCompletion({
          modelId: "Qwen3-8B-Q4_K_M",
          completionTokens: 1_000_000,
        }),
    ) * 1_000_000;
  await recordPeerUsdEarnings({
    peerId,
    modelId: "Qwen3-8B-Q4_K_M",
    completionTokens: tokensNeeded,
  });
  return getPeerUsdBalance(peerId);
}

function enablePayerConfigured() {
  // Any non-empty values — sendUsdc is mocked so secret need not decode.
  process.env.SENDA_SOLANA_TREASURY = "Treasury1111111111111111111111111111111";
  process.env.SENDA_SOLANA_PAYER_SECRET = "payer-secret-placeholder";
}

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
    const bal = await fundAboveMin(peerId);
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

describe("processPendingPeerPayouts (5.D-auto)", () => {
  it("no-ops when AUTO is off unless force", async () => {
    enablePayerConfigured();
    delete process.env.SENDA_PEER_PAYOUTS_AUTO;
    delete process.env.SENDA_PAYOUT_DRY_RUN;

    const peerId = "peerAUTOOFF";
    await setPeerPayoutWallet(
      peerId,
      "So11111111111111111111111111111111111111112",
    );
    await fundAboveMin(peerId);
    await requestPeerPayout({ peerId, payoutId: "po_auto_off" });

    const blocked = await processPendingPeerPayouts(5);
    expect(blocked.autoDisabled).toBe(true);
    expect(blocked.processed).toBe(0);
    expect(sendUsdc).not.toHaveBeenCalled();

    vi.mocked(sendUsdc).mockResolvedValue({
      ok: true,
      signature: "sig_force",
    });
    const forced = await processPendingPeerPayouts(5, { force: true });
    expect(forced.autoDisabled).toBe(false);
    expect(forced.sent).toBe(1);
    expect(sendUsdc).toHaveBeenCalledOnce();
  });

  it("dry-run does not call sendUsdc or claim tickets", async () => {
    enablePayerConfigured();
    process.env.SENDA_PEER_PAYOUTS_AUTO = "1";
    process.env.SENDA_PAYOUT_DRY_RUN = "1";

    const peerId = "peerDRYRUN1";
    await setPeerPayoutWallet(
      peerId,
      "So11111111111111111111111111111111111111112",
    );
    const bal = await fundAboveMin(peerId);
    await requestPeerPayout({ peerId, payoutId: "po_dry" });

    const result = await processPendingPeerPayouts(5);
    expect(result.dryRun).toBe(1);
    expect(result.wouldSend[0]?.id).toBe("po_dry");
    expect(result.wouldSend[0]?.micros).toBe(bal);
    expect(sendUsdc).not.toHaveBeenCalled();

    const pending = await listPendingPeerPayouts(10);
    expect(pending.some((p) => p.id === "po_dry")).toBe(true);
    expect(pending.find((p) => p.id === "po_dry")?.status).not.toBe("sent");
  });

  it("rejects tickets above max ticket cap and restores balance", async () => {
    enablePayerConfigured();
    process.env.SENDA_PEER_PAYOUTS_AUTO = "1";
    delete process.env.SENDA_PAYOUT_DRY_RUN;
    // Min withdraw is $10; cap below that so any valid ticket fails the cap.
    process.env.SENDA_PAYOUT_MAX_TICKET_USD = "5";

    const peerId = "peerCAPTICK";
    await setPeerPayoutWallet(
      peerId,
      "So11111111111111111111111111111111111111112",
    );
    const bal = await fundAboveMin(peerId);
    await requestPeerPayout({ peerId, payoutId: "po_cap" });

    const result = await processPendingPeerPayouts(5, { force: true });
    expect(result.failed).toBe(1);
    expect(sendUsdc).not.toHaveBeenCalled();
    await expect(getPeerUsdBalance(peerId)).resolves.toBe(bal);

    const pending = await listPendingPeerPayouts(10);
    expect(pending.find((p) => p.id === "po_cap")).toBeUndefined();
  });

  it("skips when daily peer cap would be exceeded (leaves pending)", async () => {
    enablePayerConfigured();
    process.env.SENDA_PEER_PAYOUTS_AUTO = "1";
    delete process.env.SENDA_PAYOUT_DRY_RUN;
    process.env.SENDA_PAYOUT_MAX_TICKET_USD = "100";
    // First ticket is ~$10.20; allow one, block the second same day.
    process.env.SENDA_PAYOUT_MAX_PEER_DAILY_USD = "15";
    process.env.SENDA_PAYOUT_MAX_GLOBAL_DAILY_USD = "1000";

    const peerId = "peerDAYCAP1";
    await setPeerPayoutWallet(
      peerId,
      "So11111111111111111111111111111111111111112",
    );
    await fundAboveMin(peerId);
    await requestPeerPayout({ peerId, payoutId: "po_day1" });
    vi.mocked(sendUsdc).mockResolvedValue({ ok: true, signature: "sig1" });
    const first = await processPendingPeerPayouts(5, { force: true });
    expect(first.sent).toBe(1);

    await fundAboveMin(peerId);
    await requestPeerPayout({ peerId, payoutId: "po_day2" });
    vi.mocked(sendUsdc).mockClear();
    const second = await processPendingPeerPayouts(5, { force: true });
    expect(second.sent).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(sendUsdc).not.toHaveBeenCalled();

    const pending = await listPendingPeerPayouts(10);
    expect(pending.some((p) => p.id === "po_day2")).toBe(true);
  });

  it("indexes payout history and paid_total on sent", async () => {
    enablePayerConfigured();
    process.env.SENDA_PEER_PAYOUTS_AUTO = "1";
    delete process.env.SENDA_PAYOUT_DRY_RUN;
    process.env.SENDA_PAYOUT_MAX_TICKET_USD = "100";
    process.env.SENDA_PAYOUT_MAX_PEER_DAILY_USD = "100";
    process.env.SENDA_PAYOUT_MAX_GLOBAL_DAILY_USD = "1000";

    const peerId = "peerHIST001";
    await setPeerPayoutWallet(
      peerId,
      "So11111111111111111111111111111111111111112",
    );
    await fundAboveMin(peerId);
    const req = await requestPeerPayout({ peerId, payoutId: "po_hist1" });
    expect(req.ok).toBe(true);

    const histPending = await listPeerPayoutHistory(peerId, 10);
    expect(histPending.some((p) => p.id === "po_hist1")).toBe(true);
    await expect(sumPaidOutPeerUsd()).resolves.toBe(0);

    vi.mocked(sendUsdc).mockResolvedValue({ ok: true, signature: "sig_hist" });
    const processed = await processPendingPeerPayouts(5, { force: true });
    expect(processed.sent).toBe(1);

    const hist = await listPeerPayoutHistory(peerId, 10);
    expect(hist[0]?.status).toBe("sent");
    expect(hist[0]?.txSignature).toBe("sig_hist");
    const paid = await sumPaidOutPeerUsd();
    expect(paid).toBeGreaterThanOrEqual(MIN_WITHDRAW_USDC_ATOMIC);

    // Idempotent paid_total on re-index
    if (hist[0]) await updatePeerPayout(hist[0]);
    await expect(sumPaidOutPeerUsd()).resolves.toBe(paid);
  });
});
