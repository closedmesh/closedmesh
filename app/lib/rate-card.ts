/**
 * Phase 5.C/5.E — customer USD rate card (rail-agnostic; settle USDC on Solana).
 *
 * Prices are micro-USD per 1M tokens. Locked 2026-07-27 from OpenRouter
 * COGS floors + ~1.3–1.5× markup (see internal/designs/phase-5ce-usdc-paid-api.md).
 *
 * Invariant (STRATEGY): for every tier,
 *   customer > peer_payout  AND  customer > external_cogs
 * (checked on both prompt and completion legs where applicable).
 */

import { getModelTier, type ModelTier } from "./model-tiers";

/** 1 USD = 1_000_000 micro-USD. */
export const USD_MICROS = 1_000_000;

export type RateCardRow = {
  tier: ModelTier;
  customer_prompt_per_mtok_usd_micros: number;
  customer_completion_per_mtok_usd_micros: number;
  /** Peer payout target on completion (5.D); bookkeeping until payouts ship. */
  peer_completion_per_mtok_usd_micros: number;
  external_cogs_prompt_per_mtok_usd_micros: number;
  external_cogs_completion_per_mtok_usd_micros: number;
};

function usd(n: number): number {
  return Math.round(n * USD_MICROS);
}

/**
 * v1 live card (ratified 2026-07-27).
 * Proxies: daily ← Qwen3-8B OR; capacity ← Llama 3.3 70B OR.
 */
export const RATE_CARD: Record<ModelTier, RateCardRow> = {
  daily_driver: {
    tier: "daily_driver",
    customer_prompt_per_mtok_usd_micros: usd(0.18),
    customer_completion_per_mtok_usd_micros: usd(0.65),
    peer_completion_per_mtok_usd_micros: usd(0.3),
    external_cogs_prompt_per_mtok_usd_micros: usd(0.12),
    external_cogs_completion_per_mtok_usd_micros: usd(0.46),
  },
  capacity: {
    tier: "capacity",
    customer_prompt_per_mtok_usd_micros: usd(0.15),
    customer_completion_per_mtok_usd_micros: usd(0.45),
    peer_completion_per_mtok_usd_micros: usd(0.2),
    external_cogs_prompt_per_mtok_usd_micros: usd(0.1),
    external_cogs_completion_per_mtok_usd_micros: usd(0.32),
  },
  experimental: {
    tier: "experimental",
    customer_prompt_per_mtok_usd_micros: usd(0.1),
    customer_completion_per_mtok_usd_micros: usd(0.3),
    peer_completion_per_mtok_usd_micros: usd(0.12),
    external_cogs_prompt_per_mtok_usd_micros: usd(0.08),
    external_cogs_completion_per_mtok_usd_micros: usd(0.2),
  },
};

/**
 * Paid debit is live by default after the 2026-07-27 rate lock.
 * Set `RATE_CARD_LIVE=0` to refuse paid paths (kill switch).
 */
export function rateCardLive(): boolean {
  const raw = process.env.RATE_CARD_LIVE?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return true;
}

/** Explicit paid-API enable (preview/prod). Defaults on when rate card is live. */
export function paidApiEnabled(): boolean {
  const raw = process.env.SENDA_PAID_API_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return rateCardLive();
}

export function getRateCardRow(modelId: string): RateCardRow {
  return RATE_CARD[getModelTier(modelId)];
}

export function assertRateCardInvariants(
  card: Record<ModelTier, RateCardRow> = RATE_CARD,
): void {
  for (const tier of Object.keys(card) as ModelTier[]) {
    const row = card[tier];
    if (
      row.customer_completion_per_mtok_usd_micros <=
      row.peer_completion_per_mtok_usd_micros
    ) {
      throw new Error(
        `rate card ${tier}: customer completion must exceed peer payout`,
      );
    }
    if (
      row.customer_completion_per_mtok_usd_micros <=
      row.external_cogs_completion_per_mtok_usd_micros
    ) {
      throw new Error(
        `rate card ${tier}: customer completion must exceed external COGS`,
      );
    }
    if (
      row.customer_prompt_per_mtok_usd_micros <=
      row.external_cogs_prompt_per_mtok_usd_micros
    ) {
      throw new Error(
        `rate card ${tier}: customer prompt must exceed external COGS`,
      );
    }
    if (row.customer_completion_per_mtok_usd_micros <= 0) {
      throw new Error(`rate card ${tier}: customer price must be positive`);
    }
  }
}

/** micro-USD cost for a token count at a per-MTok micro-USD rate. */
export function tokensCostMicros(tokens: number, perMtokMicros: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  if (!Number.isFinite(perMtokMicros) || perMtokMicros <= 0) return 0;
  return Math.ceil((tokens * perMtokMicros) / 1_000_000);
}

export function requestCostMicros(input: {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}): number {
  const row = getRateCardRow(input.modelId);
  return (
    tokensCostMicros(input.promptTokens, row.customer_prompt_per_mtok_usd_micros) +
    tokensCostMicros(
      input.completionTokens,
      row.customer_completion_per_mtok_usd_micros,
    )
  );
}

/** Headroom on reserves so prompt-estimate undercount rarely hits the cap. */
export const RESERVE_BUFFER = 1.25;

/**
 * Conservative reserve before streaming: bill prompt + max completion,
 * then × {@link RESERVE_BUFFER}. Unused reserve is released on settle;
 * settle may also pull a shortfall from remaining balance.
 */
export function estimateReserveMicros(input: {
  modelId: string;
  promptTokens: number;
  maxCompletionTokens: number;
}): number {
  const base = requestCostMicros({
    modelId: input.modelId,
    promptTokens: input.promptTokens,
    completionTokens: Math.max(0, input.maxCompletionTokens),
  });
  return Math.max(1, Math.ceil(base * RESERVE_BUFFER));
}

/** Rough prompt-token estimate when the client hasn't sent usage yet. */
export function estimatePromptTokensFromMessages(messages: unknown): number {
  try {
    const len = JSON.stringify(messages ?? []).length;
    return Math.max(1, Math.ceil(len / 4));
  } catch {
    return 256;
  }
}

export function usdToMicros(usdAmount: number): number {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return 0;
  return Math.round(usdAmount * USD_MICROS);
}

export function microsToUsd(micros: number): number {
  if (!Number.isFinite(micros)) return 0;
  return micros / USD_MICROS;
}
