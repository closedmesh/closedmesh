import { afterEach, describe, expect, it } from "vitest";
import {
  adjustCustomerBalance,
  computeSettleAmounts,
  creditCustomer,
  getCustomerBalance,
  reclaimExpiredReserves,
  reserveCustomer,
  resetCustomerLedgerMemory,
  settleCustomer,
} from "./customer-ledger";
import { usdToMicros } from "./rate-card";

describe("computeSettleAmounts", () => {
  it("releases unused reserve when actual < reserved", () => {
    expect(
      computeSettleAmounts({
        reserved: 400,
        actual: 150,
        spendableBalance: 600,
      }),
    ).toEqual({
      charged: 150,
      release: 250,
      shortfallDebit: 0,
      underpaid: 0,
    });
  });

  it("pulls shortfall from spendable balance", () => {
    expect(
      computeSettleAmounts({
        reserved: 200,
        actual: 350,
        spendableBalance: 100,
      }),
    ).toEqual({
      charged: 300,
      release: 0,
      shortfallDebit: 100,
      underpaid: 50,
    });
  });
});

afterEach(() => {
  resetCustomerLedgerMemory();
});

describe("adjustCustomerBalance", () => {
  it("debits and rejects overdraft", async () => {
    await creditCustomer({
      accountId: "adj",
      micros: 1000,
      reason: "admin",
    });
    await expect(
      adjustCustomerBalance({
        accountId: "adj",
        deltaMicros: -400,
        reason: "refund_request",
      }),
    ).resolves.toEqual({ ok: true, balance: 600 });
    await expect(
      adjustCustomerBalance({
        accountId: "adj",
        deltaMicros: -700,
        reason: "refund_request",
      }),
    ).resolves.toEqual({ ok: false, error: "insufficient_balance" });
  });
});

describe("creditCustomer", () => {
  it("credits micro-USD balance", async () => {
    const result = await creditCustomer({
      accountId: "0xabc",
      micros: usdToMicros(5),
      reason: "admin",
    });
    expect(result).toEqual({ ok: true, balance: usdToMicros(5) });
    await expect(getCustomerBalance("0xabc")).resolves.toBe(usdToMicros(5));
  });

  it("is idempotent on depositId", async () => {
    const first = await creditCustomer({
      accountId: "alice",
      micros: 100,
      reason: "usdc_deposit",
      depositId: "0xtx1",
    });
    const second = await creditCustomer({
      accountId: "alice",
      micros: 100,
      reason: "usdc_deposit",
      depositId: "0xtx1",
    });
    expect(first).toEqual({ ok: true, balance: 100 });
    expect(second).toEqual({ ok: true, balance: 100 });
  });
});

describe("reserve + settle", () => {
  it("rejects reserve when underfunded", async () => {
    await creditCustomer({
      accountId: "bob",
      micros: 50,
      reason: "admin",
    });
    const result = await reserveCustomer({
      accountId: "bob",
      requestId: "req-1",
      micros: 100,
    });
    expect(result).toEqual({ ok: false, error: "insufficient_funds" });
    await expect(getCustomerBalance("bob")).resolves.toBe(50);
  });

  it("holds then settles under-reserve (releases unused)", async () => {
    await creditCustomer({
      accountId: "carol",
      micros: 1_000,
      reason: "admin",
    });
    const reserved = await reserveCustomer({
      accountId: "carol",
      requestId: "req-2",
      micros: 400,
    });
    expect(reserved).toEqual({ ok: true, balance: 600 });

    const settled = await settleCustomer({
      requestId: "req-2",
      actualMicros: 150,
    });
    expect(settled).toMatchObject({ ok: true, balance: 850, charged: 150 });
  });

  it("pulls shortfall from remaining balance beyond reserve", async () => {
    await creditCustomer({
      accountId: "dave",
      micros: 500,
      reason: "admin",
    });
    // reserve 200 → spendable 300 left
    await reserveCustomer({
      accountId: "dave",
      requestId: "req-3",
      micros: 200,
    });
    const settled = await settleCustomer({
      requestId: "req-3",
      actualMicros: 450,
    });
    // charged = 200 reserved + 250 from balance; underpaid 0; balance 50
    expect(settled).toMatchObject({
      ok: true,
      balance: 50,
      charged: 450,
    });
  });

  it("reports underpaid when shortfall exceeds spendable", async () => {
    await creditCustomer({
      accountId: "dana",
      micros: 300,
      reason: "admin",
    });
    await reserveCustomer({
      accountId: "dana",
      requestId: "req-3b",
      micros: 200,
    });
    const settled = await settleCustomer({
      requestId: "req-3b",
      actualMicros: 500,
    });
    // reserved 200 + spendable 100 = 300 charged, underpaid 200, balance 0
    expect(settled).toMatchObject({
      ok: true,
      balance: 0,
      charged: 300,
      underpaid: 200,
    });
  });

  it("rejects duplicate reserve ids", async () => {
    await creditCustomer({
      accountId: "erin",
      micros: 500,
      reason: "admin",
    });
    await reserveCustomer({
      accountId: "erin",
      requestId: "req-4",
      micros: 100,
    });
    const dup = await reserveCustomer({
      accountId: "erin",
      requestId: "req-4",
      micros: 100,
    });
    expect(dup).toEqual({ ok: false, error: "reserve_exists" });
  });

  it("settle is idempotent", async () => {
    await creditCustomer({
      accountId: "frank",
      micros: 500,
      reason: "admin",
    });
    await reserveCustomer({
      accountId: "frank",
      requestId: "req-5",
      micros: 200,
    });
    const first = await settleCustomer({
      requestId: "req-5",
      actualMicros: 50,
    });
    const second = await settleCustomer({
      requestId: "req-5",
      actualMicros: 999,
    });
    expect(first).toMatchObject({ ok: true, charged: 50, balance: 450 });
    expect(second).toMatchObject({
      ok: true,
      charged: 50,
      balance: 450,
      idempotent: true,
    });
  });

  it("reclaims expired holds back to the balance", async () => {
    await creditCustomer({
      accountId: "grace",
      micros: 1_000,
      reason: "admin",
    });
    const held = await reserveCustomer({
      accountId: "grace",
      requestId: "req-exp",
      micros: 400,
      ttlSec: 0, // expires immediately
    });
    expect(held).toEqual({ ok: true, balance: 600 });
    const reclaimed = await reclaimExpiredReserves(10);
    expect(reclaimed.reclaimed).toBeGreaterThanOrEqual(1);
    expect(reclaimed.micros).toBeGreaterThanOrEqual(400);
    await expect(getCustomerBalance("grace")).resolves.toBe(1_000);
  });
});
