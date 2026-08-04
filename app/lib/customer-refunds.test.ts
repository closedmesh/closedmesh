import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  creditCustomer,
  getCustomerBalance,
  resetCustomerLedgerMemory,
} from "./customer-ledger";
import {
  cancelRefund,
  listPendingRefunds,
  processPendingRefunds,
  requestCustomerRefund,
  resetRefundMemory,
} from "./customer-refunds";
import { resetPeerEarningsMemory } from "./peer-earnings";
import { MIN_WITHDRAW_USDC_ATOMIC } from "./solana-config";
import { usdToMicros } from "./rate-card";
import { sendUsdc } from "./solana-usdc-send";

vi.mock("./solana-usdc-send", () => ({
  sendUsdc: vi.fn(),
}));

const ENV = [
  "SENDA_SOLANA_TREASURY",
  "SENDA_SOLANA_PAYER_SECRET",
  "SENDA_REFUNDS_AUTO",
  "SENDA_PAYOUT_DRY_RUN",
  "SENDA_PAYOUT_MAX_TICKET_USD",
  "SENDA_PAYOUT_MAX_PEER_DAILY_USD",
  "SENDA_PAYOUT_MAX_GLOBAL_DAILY_USD",
] as const;

let saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  vi.mocked(sendUsdc).mockReset();
});

afterEach(() => {
  resetCustomerLedgerMemory();
  resetRefundMemory();
  resetPeerEarningsMemory();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("requestCustomerRefund", () => {
  it("rejects below minimum", async () => {
    await creditCustomer({
      accountId: "walletA",
      micros: usdToMicros(5),
      reason: "admin",
    });
    const result = await requestCustomerRefund({
      wallet: "walletA",
      destination: "So11111111111111111111111111111111111111112",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("below_minimum");
  });

  it("drains balance and restores on cancel", async () => {
    const wallet = "walletB";
    await creditCustomer({
      accountId: wallet,
      micros: MIN_WITHDRAW_USDC_ATOMIC,
      reason: "admin",
    });
    const result = await requestCustomerRefund({
      wallet,
      destination: "So11111111111111111111111111111111111111112",
    });
    expect(result.ok).toBe(true);
    await expect(getCustomerBalance(wallet)).resolves.toBe(0);

    if (!result.ok) return;
    const cancelled = await cancelRefund({ id: result.request.id });
    expect(cancelled.ok).toBe(true);
    await expect(getCustomerBalance(wallet)).resolves.toBe(
      MIN_WITHDRAW_USDC_ATOMIC,
    );
  });
});

describe("processPendingRefunds (Slice C)", () => {
  function enablePayer() {
    process.env.SENDA_SOLANA_TREASURY = "Treasury1111111111111111111111111111111";
    process.env.SENDA_SOLANA_PAYER_SECRET = "payer-secret-placeholder";
  }

  it("no-ops when REFUNDS_AUTO off unless force", async () => {
    enablePayer();
    delete process.env.SENDA_REFUNDS_AUTO;
    const wallet = "walletAutoOff";
    await creditCustomer({
      accountId: wallet,
      micros: MIN_WITHDRAW_USDC_ATOMIC,
      reason: "admin",
    });
    await requestCustomerRefund({
      wallet,
      destination: "So11111111111111111111111111111111111111112",
    });

    const blocked = await processPendingRefunds(5);
    expect(blocked.autoDisabled).toBe(true);
    expect(sendUsdc).not.toHaveBeenCalled();

    vi.mocked(sendUsdc).mockResolvedValue({ ok: true, signature: "rf_sig" });
    const forced = await processPendingRefunds(5, { force: true });
    expect(forced.sent).toBe(1);
    expect(sendUsdc).toHaveBeenCalledOnce();
  });

  it("dry-run does not send or claim", async () => {
    enablePayer();
    process.env.SENDA_REFUNDS_AUTO = "1";
    process.env.SENDA_PAYOUT_DRY_RUN = "1";
    const wallet = "walletDryRf";
    await creditCustomer({
      accountId: wallet,
      micros: MIN_WITHDRAW_USDC_ATOMIC,
      reason: "admin",
    });
    const created = await requestCustomerRefund({
      wallet,
      destination: "So11111111111111111111111111111111111111112",
    });
    expect(created.ok).toBe(true);

    const result = await processPendingRefunds(5);
    expect(result.dryRun).toBe(1);
    expect(sendUsdc).not.toHaveBeenCalled();
    const pending = await listPendingRefunds(10);
    expect(pending.some((r) => r.status === "pending")).toBe(true);
  });
});
