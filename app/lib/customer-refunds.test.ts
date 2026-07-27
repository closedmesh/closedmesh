import { afterEach, describe, expect, it } from "vitest";
import {
  creditCustomer,
  getCustomerBalance,
  resetCustomerLedgerMemory,
} from "./customer-ledger";
import {
  cancelRefund,
  requestCustomerRefund,
  resetRefundMemory,
} from "./customer-refunds";
import { MIN_WITHDRAW_USDC_ATOMIC } from "./solana-config";
import { usdToMicros } from "./rate-card";

afterEach(() => {
  resetCustomerLedgerMemory();
  resetRefundMemory();
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
