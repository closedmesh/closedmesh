import { describe, expect, test } from "vitest";
import {
  computeMarginFromCounters,
  emptyMarginWindow,
  requestCostOfGoodsMicros,
  type MarginCounters,
} from "./margin-accounting";
import { getRateCardRow, requestCostMicros, USD_MICROS } from "./rate-card";
import { peerUsdForCompletion } from "./peer-earnings";

const DAILY = "Qwen3-8B-Q4_K_M"; // daily_driver tier
const NOW = new Date("2026-08-11T15:30:00.000Z");

describe("requestCostOfGoodsMicros", () => {
  test("mesh cost is the peer payout liability", () => {
    const cost = requestCostOfGoodsMicros({
      servedBy: "mesh",
      modelId: DAILY,
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(cost).toBe(
      peerUsdForCompletion({ modelId: DAILY, completionTokens: 500 }),
    );
  });

  test("mesh cost ignores prompt tokens — peers are paid on completion", () => {
    const a = requestCostOfGoodsMicros({
      servedBy: "mesh",
      modelId: DAILY,
      promptTokens: 10,
      completionTokens: 500,
    });
    const b = requestCostOfGoodsMicros({
      servedBy: "mesh",
      modelId: DAILY,
      promptTokens: 100_000,
      completionTokens: 500,
    });
    expect(a).toBe(b);
  });

  test("underpaid mesh request books no cost, matching skipPeerUsd", () => {
    const cost = requestCostOfGoodsMicros({
      servedBy: "mesh",
      modelId: DAILY,
      promptTokens: 1000,
      completionTokens: 500,
      underpaid: 42,
    });
    expect(cost).toBe(0);
  });

  test("fallback cost charges external COGS on both legs", () => {
    const row = getRateCardRow(DAILY);
    const cost = requestCostOfGoodsMicros({
      servedBy: "fallback",
      modelId: DAILY,
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBe(
      row.external_cogs_prompt_per_mtok_usd_micros +
        row.external_cogs_completion_per_mtok_usd_micros,
    );
  });

  test("underpaid does not suppress external COGS — we still owe the provider", () => {
    const cost = requestCostOfGoodsMicros({
      servedBy: "fallback",
      modelId: DAILY,
      promptTokens: 1000,
      completionTokens: 500,
      underpaid: 42,
    });
    expect(cost).toBeGreaterThan(0);
  });

  test("both paths stay below what the customer is charged", () => {
    // The rate-card invariant, exercised through the realised cost path.
    for (const servedBy of ["mesh", "fallback"] as const) {
      const revenue = requestCostMicros({
        modelId: DAILY,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      });
      const cost = requestCostOfGoodsMicros({
        servedBy,
        modelId: DAILY,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      });
      expect(cost).toBeLessThan(revenue);
    }
  });
});

describe("computeMarginFromCounters", () => {
  const hour = "20260811T15";
  const k = (f: string, p: string) => `senda:margin:${f}:${p}:${hour}`;

  test("splits margin by served_by and totals both", () => {
    const counters: MarginCounters = {
      [k("n", "mesh")]: 10,
      [k("rev", "mesh")]: 1_000_000,
      [k("cost", "mesh")]: 400_000,
      [k("n", "fallback")]: 5,
      [k("rev", "fallback")]: 500_000,
      [k("cost", "fallback")]: 350_000,
    };
    const w = computeMarginFromCounters(counters, 24, NOW);

    expect(w.mesh.requests).toBe(10);
    expect(w.mesh.margin_usd_micros).toBe(600_000);
    expect(w.mesh.margin_pct).toBeCloseTo(60, 5);
    expect(w.mesh.margin_per_request_usd_micros).toBe(60_000);

    expect(w.fallback.margin_usd_micros).toBe(150_000);
    expect(w.fallback.margin_pct).toBeCloseTo(30, 5);
    expect(w.fallback.margin_per_request_usd_micros).toBe(30_000);

    expect(w.total.requests).toBe(15);
    expect(w.total.revenue_usd_micros).toBe(1_500_000);
    expect(w.total.margin_usd_micros).toBe(750_000);
    expect(w.total.margin_pct).toBeCloseTo(50, 5);
  });

  test("mesh margin beats fallback at equal volume — the whole thesis", () => {
    // Same tokens, same revenue; only the cost side differs by path.
    const tokens = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    const revenue = requestCostMicros({ modelId: DAILY, ...tokens });
    const meshCost = requestCostOfGoodsMicros({
      servedBy: "mesh",
      modelId: DAILY,
      ...tokens,
    });
    const fallbackCost = requestCostOfGoodsMicros({
      servedBy: "fallback",
      modelId: DAILY,
      ...tokens,
    });

    const counters: MarginCounters = {
      [k("n", "mesh")]: 1,
      [k("rev", "mesh")]: revenue,
      [k("cost", "mesh")]: meshCost,
      [k("n", "fallback")]: 1,
      [k("rev", "fallback")]: revenue,
      [k("cost", "fallback")]: fallbackCost,
    };
    const w = computeMarginFromCounters(counters, 24, NOW);
    expect(w.mesh.margin_per_request_usd_micros).toBeGreaterThan(
      w.fallback.margin_per_request_usd_micros!,
    );
  });

  test("no data reports null, never 0%", () => {
    const w = computeMarginFromCounters({}, 168, NOW);
    expect(w.total.requests).toBe(0);
    expect(w.total.margin_pct).toBeNull();
    expect(w.total.margin_per_request_usd_micros).toBeNull();
    expect(w.mesh.margin_pct).toBeNull();
  });

  test("negative margin is reported, not clamped", () => {
    const counters: MarginCounters = {
      [k("n", "fallback")]: 2,
      [k("rev", "fallback")]: 100_000,
      [k("cost", "fallback")]: 250_000,
    };
    const w = computeMarginFromCounters(counters, 24, NOW);
    expect(w.fallback.margin_usd_micros).toBe(-150_000);
    expect(w.fallback.margin_pct).toBeCloseTo(-150, 5);
    expect(w.fallback.margin_per_request_usd_micros).toBe(-75_000);
  });

  test("buckets outside the window are excluded", () => {
    const stale = "senda:margin:rev:mesh:20260801T00";
    const w = computeMarginFromCounters({ [stale]: 999 * USD_MICROS }, 24, NOW);
    expect(w.mesh.revenue_usd_micros).toBe(0);
  });

  test("emptyMarginWindow preserves the requested horizon", () => {
    expect(emptyMarginWindow(168).hours).toBe(168);
  });
});
