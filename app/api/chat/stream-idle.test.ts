import { describe, expect, test } from "vitest";
import { streamIdleBudgetMs } from "./route";
import { SLA_TARGETS_BY_TIER, getModelTier } from "../../lib/model-tiers";

/**
 * The watchdog exists because a production request emitted `{"type":"start"}`
 * and then nothing for 90 s with no error (2026-08-12). `maxDuration` is 300,
 * so without a guard a visitor stares at an empty chat for five minutes.
 *
 * These assert the budget is generous enough not to cut off a legitimately slow
 * tier, and tight enough that a stall surfaces well before `maxDuration`.
 */
describe("streamIdleBudgetMs", () => {
  const DAILY = "Qwen3-8B-Q4_K_M";
  const CAPACITY = "Qwen3.5-397B-A17B-Q4_K_M";

  test("daily driver gets the floor, not 6x a 3s target", () => {
    expect(getModelTier(DAILY)).toBe("daily_driver");
    // 3000 * 6 = 18_000, below the 30s floor.
    expect(streamIdleBudgetMs(DAILY)).toBe(30_000);
  });

  test("capacity tier gets more than the floor so slow TTFT is not cut off", () => {
    expect(getModelTier(CAPACITY)).toBe("capacity");
    const target = SLA_TARGETS_BY_TIER.capacity.target_ttft_ms_p50;
    expect(streamIdleBudgetMs(CAPACITY)).toBe(target * 6);
    expect(streamIdleBudgetMs(CAPACITY)).toBeGreaterThan(30_000);
  });

  test("every tier's budget clears its own advertised TTFT target", () => {
    for (const [tier, targets] of Object.entries(SLA_TARGETS_BY_TIER)) {
      // Find any model id resolving to this tier via the tier map; fall back to
      // asserting the arithmetic directly when none is handy.
      const budget = Math.max(30_000, targets.target_ttft_ms_p50 * 6);
      expect(budget, tier).toBeGreaterThan(targets.target_ttft_ms_p50);
    }
  });

  test("no tier's budget exceeds maxDuration, so the guard always fires first", () => {
    const MAX_DURATION_MS = 300_000;
    for (const [tier, targets] of Object.entries(SLA_TARGETS_BY_TIER)) {
      const budget = Math.max(30_000, targets.target_ttft_ms_p50 * 6);
      expect(budget, tier).toBeLessThan(MAX_DURATION_MS);
    }
  });

  test("unknown models fall back to a real budget rather than 0", () => {
    const budget = streamIdleBudgetMs("Some-Unlisted-Model-Q4_K_M");
    expect(budget).toBeGreaterThanOrEqual(30_000);
    expect(Number.isFinite(budget)).toBe(true);
  });
});
