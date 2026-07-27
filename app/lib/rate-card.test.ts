import { describe, expect, it } from "vitest";
import {
  RATE_CARD,
  USD_MICROS,
  assertRateCardInvariants,
  estimatePromptTokensFromMessages,
  estimateReserveMicros,
  microsToUsd,
  requestCostMicros,
  tokensCostMicros,
  usdToMicros,
} from "./rate-card";

describe("rate card invariants", () => {
  it("satisfies customer > peer and customer > external COGS for every tier", () => {
    expect(() => assertRateCardInvariants()).not.toThrow();
  });

  it("matches the 2026-07-27 locked daily-driver prices", () => {
    expect(RATE_CARD.daily_driver.customer_prompt_per_mtok_usd_micros).toBe(
      Math.round(0.18 * USD_MICROS),
    );
    expect(RATE_CARD.daily_driver.customer_completion_per_mtok_usd_micros).toBe(
      Math.round(0.65 * USD_MICROS),
    );
    expect(RATE_CARD.daily_driver.peer_completion_per_mtok_usd_micros).toBe(
      Math.round(0.3 * USD_MICROS),
    );
  });
});

describe("tokensCostMicros", () => {
  it("ceil-bills fractional micro-USD", () => {
    expect(tokensCostMicros(1, Math.round(0.65 * USD_MICROS))).toBe(1);
  });

  it("returns 0 for empty usage", () => {
    expect(tokensCostMicros(0, 650_000)).toBe(0);
    expect(tokensCostMicros(100, 0)).toBe(0);
  });
});

describe("requestCostMicros / reserve", () => {
  it("prices a daily-driver request from model id", () => {
    const cost = requestCostMicros({
      modelId: "Qwen3-8B-Q4_K_M",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const row = RATE_CARD.daily_driver;
    expect(cost).toBe(
      row.customer_prompt_per_mtok_usd_micros +
        row.customer_completion_per_mtok_usd_micros,
    );
  });

  it("reserves prompt + max completion", () => {
    const reserve = estimateReserveMicros({
      modelId: "Qwen3-8B-Q4_K_M",
      promptTokens: 100,
      maxCompletionTokens: 256,
    });
    expect(reserve).toBe(
      requestCostMicros({
        modelId: "Qwen3-8B-Q4_K_M",
        promptTokens: 100,
        completionTokens: 256,
      }),
    );
  });
});

describe("helpers", () => {
  it("round-trips whole dollars", () => {
    expect(usdToMicros(5)).toBe(5 * USD_MICROS);
    expect(microsToUsd(5 * USD_MICROS)).toBe(5);
  });

  it("estimates prompt tokens from message JSON size", () => {
    expect(
      estimatePromptTokensFromMessages([{ role: "user", content: "hi" }]),
    ).toBeGreaterThan(0);
  });
});
