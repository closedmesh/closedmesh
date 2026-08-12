import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeFallbackBudget,
  decideFallback,
  fallbackAvailableFor,
  fallbackDailySpendCapMicros,
  fallbackGlobalHourlyMax,
  fallbackKeyConfigured,
  fallbackSpendTodayMicros,
  mapModelIdForFallback,
  recordFallbackSpend,
} from "./fallback-provider";
import { USD_MICROS } from "./rate-card";
import type { SlaEvaluation } from "./routing-sla";

function sla(overrides: Partial<SlaEvaluation>): SlaEvaluation {
  return {
    meetsSla: false,
    tier: "daily_driver",
    reason: "no-measurements",
    bestPeerTtftMs: null,
    bestPeerTps: null,
    candidatePeerCount: 0,
    creditPeerId: null,
    bestPeerNativeRatio: null,
    ...overrides,
  };
}

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  // Tests assume the key is provisioned unless they say otherwise;
  // the "no key" path has its own test below that re-sets this.
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  }
});

describe("mapModelIdForFallback", () => {
  it("maps known daily-driver models to OpenRouter slugs", () => {
    expect(mapModelIdForFallback("Qwen3-8B-Q4_K_M")).toBe("qwen/qwen3-8b");
    expect(mapModelIdForFallback("Llama-3.1-8B-Instruct-Q4_K_M")).toBe(
      "meta-llama/llama-3.1-8b-instruct",
    );
  });

  it("normalises runtime-shaped ids", () => {
    expect(mapModelIdForFallback("qwen3-8b-q4_k_m.gguf")).toBe(
      "qwen/qwen3-8b",
    );
  });

  it("returns null for unknown models", () => {
    expect(mapModelIdForFallback("some-future-model-Q4_K_M")).toBeNull();
  });

  it("maps Gemma capacity models used for no-host demo fallback", () => {
    expect(mapModelIdForFallback("Gemma-3-27B-it-Q4_K_M")).toBe(
      "google/gemma-3-27b-it",
    );
    expect(mapModelIdForFallback("google_gemma-3-27b-it-Q4_K_M")).toBe(
      "google/gemma-3-27b-it",
    );
  });

  it("returns null for unmapped capacity models", () => {
    expect(mapModelIdForFallback("DeepSeek-R1-Distill-70B-Q4_K_M")).toBeNull();
    expect(mapModelIdForFallback("Qwen3-32B-Q4_K_M")).toBeNull();
  });
});

describe("fallbackKeyConfigured / fallbackAvailableFor", () => {
  it("requires both a key AND a model mapping", () => {
    expect(fallbackKeyConfigured()).toBe(true);
    expect(fallbackAvailableFor("Qwen3-8B-Q4_K_M")).toBe(true);
    expect(fallbackAvailableFor("Gemma-3-27B-it-Q4_K_M")).toBe(true);
    expect(fallbackAvailableFor("DeepSeek-R1-Distill-70B-Q4_K_M")).toBe(false);
  });

  it("reports unavailable when the key is unset", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(fallbackKeyConfigured()).toBe(false);
    expect(fallbackAvailableFor("Qwen3-8B-Q4_K_M")).toBe(false);
  });
});

describe("decideFallback", () => {
  it("stays on mesh when SLA passes, regardless of tier", () => {
    const d = decideFallback("Qwen3-8B-Q4_K_M", sla({ meetsSla: true }));
    expect(d.useFallback).toBe(false);
    expect(d.verdict).toBe("mesh-meets-sla");
    expect(d.fallbackModelSlug).toBeNull();
  });

  it("fires fallback when SLA misses for a mapped daily-driver model", () => {
    const d = decideFallback(
      "Qwen3-8B-Q4_K_M",
      sla({ meetsSla: false, reason: "tps-too-low" }),
    );
    expect(d.useFallback).toBe(true);
    expect(d.verdict).toBe("fallback-fired");
    expect(d.fallbackModelSlug).toBe("qwen/qwen3-8b");
  });

  it("stays on mesh for capacity SLA misses when a dialable host exists", () => {
    const d = decideFallback(
      "DeepSeek-R1-Distill-70B-Q4_K_M",
      sla({
        meetsSla: false,
        tier: "capacity",
        reason: "tps-too-low",
        candidatePeerCount: 1,
      }),
    );
    expect(d.useFallback).toBe(false);
    expect(d.verdict).toBe("fallback-wrong-tier");
  });

  it("falls back for capacity when no dialable host exists (demo safety net)", () => {
    const d = decideFallback(
      "Gemma-3-27B-it-Q4_K_M",
      sla({
        meetsSla: false,
        tier: "capacity",
        reason: "no-peer-with-model",
        candidatePeerCount: 0,
      }),
    );
    expect(d.useFallback).toBe(true);
    expect(d.verdict).toBe("fallback-capacity-no-host");
    expect(d.fallbackModelSlug).toBe("google/gemma-3-27b-it");
  });

  it("stays on mesh for unmapped capacity even with zero hosts", () => {
    const d = decideFallback(
      "DeepSeek-R1-Distill-70B-Q4_K_M",
      sla({
        meetsSla: false,
        tier: "capacity",
        reason: "no-peer-with-model",
        candidatePeerCount: 0,
      }),
    );
    expect(d.useFallback).toBe(false);
    expect(d.verdict).toBe("fallback-no-mapping");
  });

  it("stays on mesh when the OpenRouter key is not configured", () => {
    delete process.env.OPENROUTER_API_KEY;
    const d = decideFallback(
      "Qwen3-8B-Q4_K_M",
      sla({ meetsSla: false, reason: "no-peer-with-model" }),
    );
    expect(d.useFallback).toBe(false);
    expect(d.verdict).toBe("fallback-disabled");
    expect(d.fallbackModelSlug).toBeNull();
  });

  it("fires fallback when no mesh peer hosts the model at all", () => {
    const d = decideFallback(
      "Qwen3-8B-Q4_K_M",
      sla({
        meetsSla: false,
        reason: "no-peer-with-model",
        candidatePeerCount: 0,
      }),
    );
    expect(d.useFallback).toBe(true);
    expect(d.verdict).toBe("fallback-fired");
  });
});

// ---------------------------------------------------------------------------
// Global caps
// ---------------------------------------------------------------------------
//
// The per-IP counter bounds one visitor, not us: with N unique IPs the exposure
// is N x budget, unbounded, every request billed to our provider account. These
// cover the ceilings added for launch week.

describe("global fallback caps", () => {
  const ORIGINAL_SPEND = process.env.SENDA_FALLBACK_DAILY_SPEND_USD;
  const ORIGINAL_GLOBAL = process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX;

  afterEach(() => {
    if (ORIGINAL_SPEND === undefined) delete process.env.SENDA_FALLBACK_DAILY_SPEND_USD;
    else process.env.SENDA_FALLBACK_DAILY_SPEND_USD = ORIGINAL_SPEND;
    if (ORIGINAL_GLOBAL === undefined) delete process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX;
    else process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX = ORIGINAL_GLOBAL;
  });

  it("defaults to a real spend ceiling, never unlimited", () => {
    delete process.env.SENDA_FALLBACK_DAILY_SPEND_USD;
    const cap = fallbackDailySpendCapMicros();
    expect(cap).toBeGreaterThan(0);
    expect(Number.isFinite(cap)).toBe(true);
    expect(cap).toBe(25 * USD_MICROS);
  });

  it("honours an explicit dollar ceiling, including fractional", () => {
    process.env.SENDA_FALLBACK_DAILY_SPEND_USD = "5";
    expect(fallbackDailySpendCapMicros()).toBe(5 * USD_MICROS);
    process.env.SENDA_FALLBACK_DAILY_SPEND_USD = "2.50";
    expect(fallbackDailySpendCapMicros()).toBe(2_500_000);
  });

  it("falls back to the default on junk or non-positive input", () => {
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      process.env.SENDA_FALLBACK_DAILY_SPEND_USD = bad;
      expect(fallbackDailySpendCapMicros(), bad).toBe(25 * USD_MICROS);
    }
  });

  it("defaults the global hourly burst ceiling and honours overrides", () => {
    delete process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX;
    expect(fallbackGlobalHourlyMax()).toBe(500);
    process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX = "50";
    expect(fallbackGlobalHourlyMax()).toBe(50);
    process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX = "-1";
    expect(fallbackGlobalHourlyMax()).toBe(500);
  });

  it("global ceiling is stricter than one IP could reach alone", () => {
    // Sanity: the burst guard must sit above a single IP's allowance, or it
    // would deny before the per-IP limit ever applied.
    delete process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX;
    delete process.env.SENDA_FALLBACK_HOURLY_BUDGET;
    expect(fallbackGlobalHourlyMax()).toBeGreaterThan(20);
  });

  it("reports zero spend when Redis is unconfigured rather than throwing", async () => {
    await expect(fallbackSpendTodayMicros()).resolves.toBe(0);
  });

  it("recording spend without Redis is a no-op, not an error", async () => {
    await expect(
      recordFallbackSpend({
        modelId: "Qwen3-8B-Q4_K_M",
        promptTokens: 1000,
        completionTokens: 500,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows the request when Redis is unconfigured (local dev)", async () => {
    const res = await consumeFallbackBudget("1.2.3.4");
    expect(res.allowed).toBe(true);
  });
});
