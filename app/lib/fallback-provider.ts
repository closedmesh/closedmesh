/**
 * Phase 4.C — external-supply fallback provider.
 *
 * Senda is a paid inference API (Phase 5) with two supply
 * paths: the mesh (our differentiated supply, mesh peers earn from
 * each request they serve) and an external OpenAI-compatible
 * provider (cost-of-goods that guarantees uptime so the API is
 * sellable). The per-model SLA gate in `routing-sla.ts` decides
 * which supply path each request takes. This module is the
 * external-supply path.
 *
 * Today the only concrete provider is OpenRouter; the factory
 * pattern leaves room to add Together / Groq / direct provider
 * keys later. The same provider abstraction runs on both the free
 * `senda.network/chat` testbed (today, Phase 4) and the paid API
 * surface (Phase 5) — what changes between the two is the billing
 * layer wrapping this module, not this module itself.
 *
 * Policy knobs for external supply on the free `/chat` testbed:
 *
 *   1. **Tier allowlist.** Daily-driver models may fall back on any
 *      SLA miss. Capacity-tier models stay mesh-preferred when a
 *      dialable host exists, but when `candidatePeerCount === 0`
 *      (no dialable host) they may fall back too — otherwise public
 *      demos hard-miss (Gemma/Elevens 2026-07-21). That is
 *      mesh_preferred, not mesh_or_die.
 *   2. **Mapping required.** External supply fires only for models
 *      with a concrete entry in `FALLBACK_MODEL_MAP`.
 *   3. **Per-IP per-hour budget.** Bounded usage on the free
 *      testbed (default 20/hour/IP, override via env).
 *
 * The provider activates only when `OPENROUTER_API_KEY` is set in
 * the environment. Without it, the route stays on the mesh-only
 * path and emits `x-senda-fallback-status: fallback-disabled`
 * on every response — so the code path can ship before the key is
 * provisioned and flip on by setting the env var.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getModelTier } from "./model-tiers";
import { getRedis } from "./redis";
import { USD_MICROS } from "./rate-card";
import { requestCostOfGoodsMicros } from "./margin-accounting";
import { normalizeModelId } from "./model-id";
import type { SlaEvaluation } from "./routing-sla";

/**
 * Hand-maintained map from our canonical mesh model ids to OpenRouter
 * model slugs. Daily-driver tier only.
 *
 * The matching uses `normalizeModelId` so quant suffixes and casing
 * are tolerated — `qwen3-8b-q4_k_m.gguf` resolves to the same key
 * as `Qwen3-8B-Q4_K_M`.
 *
 * Slugs targeted at 2026-05-24; if OpenRouter renames them this
 * table is the only place we need to update.
 */
const FALLBACK_MODEL_MAP: Record<string, string> = {
  "Qwen3-8B-Q4_K_M": "qwen/qwen3-8b",
  "Llama-3.1-8B-Instruct-Q4_K_M": "meta-llama/llama-3.1-8b-instruct",
  "Qwen2.5-Coder-7B-Instruct-Q4_K_M": "qwen/qwen-2.5-coder-7b-instruct",
  "DeepSeek-R1-Distill-Qwen-14B-Q4_K_M": "deepseek/deepseek-r1-distill-qwen-14b",
  "Llama-3.2-3B-Instruct-Q4_K_M": "meta-llama/llama-3.2-3b-instruct",
  // Capacity: only used when no dialable mesh host (see decideFallback).
  "Gemma-3-27B-it-Q4_K_M": "google/gemma-3-27b-it",
  "Gemma-3-12B-it-Q4_K_M": "google/gemma-3-12b-it",
};

const NORMALIZED_FALLBACK_MAP: Map<string, string> = new Map(
  Object.entries(FALLBACK_MODEL_MAP).map(([id, slug]) => [
    normalizeModelId(id),
    slug,
  ]),
);

/** Resolve a mesh model id to its OpenRouter slug, or null. */
export function mapModelIdForFallback(modelId: string): string | null {
  const n = normalizeModelId(modelId);
  const direct = NORMALIZED_FALLBACK_MAP.get(n);
  if (direct) return direct;
  // HF org-prefixed stems (`google_gemma-3-27b-it-…`) must hit catalog keys.
  for (const [key, slug] of NORMALIZED_FALLBACK_MAP) {
    if (n.endsWith("-" + key) || key.endsWith("-" + n)) return slug;
  }
  return null;
}

export function fallbackKeyConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim();
}

/**
 * True when both the key is configured AND we have an external
 * mapping for the requested model. Distinguishes "fallback not
 * provisioned" from "fallback exists but doesn't cover this model".
 */
export function fallbackAvailableFor(modelId: string): boolean {
  if (!fallbackKeyConfigured()) return false;
  return mapModelIdForFallback(modelId) !== null;
}

/**
 * Why a request did (or did not) get routed to fallback. Surfaced
 * as the value of the `x-senda-fallback-status` response
 * header so we can debug routing decisions without server logs.
 */
export type FallbackVerdict =
  | "mesh-meets-sla"
  | "fallback-disabled"
  | "fallback-no-mapping"
  | "fallback-wrong-tier"
  | "fallback-rate-limited"
  /** Daily external-provider spend ceiling reached — distinct from a per-IP
   *  rate limit, and the one worth alerting on. */
  | "fallback-spend-capped"
  /** Global hourly request ceiling reached (burst guard). */
  | "fallback-global-limited"
  | "vision-mesh-only"
  | "fallback-fired"
  | "fallback-capacity-no-host";

export type FallbackDecision = {
  /** True iff the chat route should send the request to the fallback provider. */
  useFallback: boolean;
  verdict: FallbackVerdict;
  /** Resolved OpenRouter slug when `useFallback`; null otherwise. */
  fallbackModelSlug: string | null;
};

/**
 * Pure decision function. Does NOT consume the rate-limit budget —
 * that's a separate Redis-touching call. This lets us test the
 * decision matrix without mocking Redis.
 *
 * Decision precedence:
 *  1. If the SLA gate passes, the request streams from the mesh.
 *  2. Daily-driver SLA miss → fallback when mapped + keyed.
 *  3. Capacity (or other) with **zero dialable candidates** → fallback
 *     when mapped + keyed (`fallback-capacity-no-host`). Mesh stays
 *     preferred when any dialable host exists.
 *  4. Otherwise stay on mesh (wrong tier / no mapping / no key).
 */
export function decideFallback(
  modelId: string,
  sla: SlaEvaluation,
): FallbackDecision {
  if (sla.meetsSla) {
    return {
      useFallback: false,
      verdict: "mesh-meets-sla",
      fallbackModelSlug: null,
    };
  }
  const tier = getModelTier(modelId);
  const noDialableHost = sla.candidatePeerCount === 0;
  const tierAllowsFallback =
    tier === "daily_driver" || (tier === "capacity" && noDialableHost);
  if (!tierAllowsFallback) {
    return {
      useFallback: false,
      verdict: "fallback-wrong-tier",
      fallbackModelSlug: null,
    };
  }
  const slug = mapModelIdForFallback(modelId);
  if (!slug) {
    return {
      useFallback: false,
      verdict: "fallback-no-mapping",
      fallbackModelSlug: null,
    };
  }
  if (!fallbackKeyConfigured()) {
    return {
      useFallback: false,
      verdict: "fallback-disabled",
      fallbackModelSlug: null,
    };
  }
  return {
    useFallback: true,
    verdict:
      tier === "capacity" ? "fallback-capacity-no-host" : "fallback-fired",
    fallbackModelSlug: slug,
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

type OpenRouterProvider = ReturnType<typeof createOpenAICompatible>;

let cachedProvider: OpenRouterProvider | null = null;

export function getOpenRouterProvider(): OpenRouterProvider | null {
  if (!fallbackKeyConfigured()) return null;
  if (cachedProvider) return cachedProvider;
  cachedProvider = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY!.trim(),
    includeUsage: true,
    headers: {
      "HTTP-Referer": "https://senda.network",
      "X-Title": "Senda",
    },
  });
  return cachedProvider;
}

// ---------------------------------------------------------------------------
// Per-IP per-hour budget
// ---------------------------------------------------------------------------

function fallbackHourlyBudget(): number {
  const raw = process.env.SENDA_FALLBACK_HOURLY_BUDGET?.trim();
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 20;
  return parsed;
}

function currentHourBucket(at = new Date()): string {
  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}${String(at.getUTCDate()).padStart(2, "0")}T${String(at.getUTCHours()).padStart(2, "0")}`;
}

function budgetKey(clientIp: string, hour = currentHourBucket()): string {
  return `senda:fallback:budget:${clientIp}:${hour}`;
}

// ---------------------------------------------------------------------------
// Global caps
// ---------------------------------------------------------------------------
//
// The per-IP counter above bounds one visitor; it does not bound *us*. With N
// unique IPs the exposure is N x budget, unbounded, and every request is billed
// to our provider account. That is the wrong shape for an announcement, where
// traffic is exactly what we are trying to cause.
//
// Two ceilings, because they fail differently:
//
//   - **Daily spend** is the meaningful one — long prompts cost far more than
//     short ones, so a request count is a poor proxy for money. Priced with the
//     same `requestCostOfGoodsMicros` the margin ledger uses, so the cap and the
//     reporting can never disagree about what a fallback request cost.
//   - **Global hourly requests** bounds the burst. Spend can only be recorded
//     *after* a request completes, so a concurrent spike can all clear the spend
//     pre-check together. This is the guard for that race.
//
// Neither replaces a hard credit limit on the provider key itself: that one does
// not depend on this code being correct.

const DEFAULT_DAILY_SPEND_USD = 25;
const DEFAULT_GLOBAL_HOURLY_MAX = 500;

export function fallbackDailySpendCapMicros(): number {
  const raw = process.env.SENDA_FALLBACK_DAILY_SPEND_USD?.trim();
  const usd = raw ? Number.parseFloat(raw) : NaN;
  const effective =
    Number.isFinite(usd) && usd > 0 ? usd : DEFAULT_DAILY_SPEND_USD;
  return Math.round(effective * USD_MICROS);
}

export function fallbackGlobalHourlyMax(): number {
  const raw = process.env.SENDA_FALLBACK_GLOBAL_HOURLY_MAX?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GLOBAL_HOURLY_MAX;
}

function currentDayBucket(at = new Date()): string {
  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}${String(at.getUTCDate()).padStart(2, "0")}`;
}

function spendKey(day = currentDayBucket()): string {
  return `senda:fallback:spend:${day}`;
}

function globalCountKey(hour = currentHourBucket()): string {
  return `senda:fallback:global:${hour}`;
}

/**
 * Record what a completed fallback request actually cost us, in micro-USD.
 *
 * Fire-and-forget: never allowed to fail the response. Under-recording is the
 * safe direction — the cap simply trips a little later — whereas throwing here
 * would break a request the visitor is already reading.
 */
export async function recordFallbackSpend(input: {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const micros = requestCostOfGoodsMicros({
    servedBy: "fallback",
    modelId: input.modelId,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
  });
  if (micros <= 0) return;
  try {
    const key = spendKey();
    const total = await redis.incrby(key, micros);
    if (total === micros) {
      // First write of the day; keep two days so a UTC-boundary read is safe.
      await redis.expire(key, 2 * 24 * 3600);
    }
  } catch {
    /* bookkeeping must never break the response */
  }
}

/** Accumulated external-provider spend for the current UTC day, micro-USD. */
export async function fallbackSpendTodayMicros(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const raw = await redis.get<string | number | null>(spendKey());
    if (raw == null) return 0;
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // Fail closed would take chat down on a Redis blip; fail open and let the
    // provider-side credit limit be the backstop.
    return 0;
  }
}

export type BudgetResult =
  | { allowed: true; remaining: number }
  | {
      allowed: false;
      reason: "rate-limited" | "global-spend-cap" | "global-rate-limited";
      remaining: 0;
    };

/**
 * Atomically increment the per-IP per-hour counter on the free
 * `/chat` testbed and return whether the call is within today's
 * budget. When Redis isn't configured (local dev, tests) the call
 * is always allowed.
 *
 * Default cap 20/hour/IP, override via
 * `SENDA_FALLBACK_HOURLY_BUDGET`. Phase 5's paid API replaces
 * this counter with the customer's credit balance — the rate card
 * is constructed so each request's price covers the supply cost
 * (mesh peer payout or external-provider COGS) plus margin.
 */
export async function consumeFallbackBudget(
  clientIp: string,
): Promise<BudgetResult> {
  const redis = getRedis();
  const budget = fallbackHourlyBudget();
  if (!redis) {
    return { allowed: true, remaining: budget };
  }
  // Global ceilings are checked before the per-IP counter is consumed, so a
  // capped-out day doesn't burn a visitor's personal allowance on a request that
  // was never going to be served externally.
  const spent = await fallbackSpendTodayMicros();
  if (spent >= fallbackDailySpendCapMicros()) {
    return { allowed: false, reason: "global-spend-cap", remaining: 0 };
  }

  const globalMax = fallbackGlobalHourlyMax();
  try {
    const gKey = globalCountKey();
    const gCount = await redis.incr(gKey);
    if (gCount === 1) await redis.expire(gKey, 3700);
    if (gCount > globalMax) {
      return { allowed: false, reason: "global-rate-limited", remaining: 0 };
    }
  } catch {
    // A Redis failure here shouldn't take chat down. The daily spend cap and the
    // provider-side credit limit remain in front of real money.
  }

  const key = budgetKey(clientIp);
  const count = await redis.incr(key);
  if (count === 1) {
    // Bucket expires at the end of the hour + a small buffer so the
    // counter doesn't survive into the next clock hour.
    await redis.expire(key, 3700);
  }
  if (count > budget) {
    return { allowed: false, reason: "rate-limited", remaining: 0 };
  }
  return { allowed: true, remaining: Math.max(0, budget - count) };
}

/** Test-only escape hatch so unit tests can reset the provider cache. */
export function __resetFallbackProviderCacheForTests(): void {
  cachedProvider = null;
}
