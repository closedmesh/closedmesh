/**
 * Phase 4.A — model tiers.
 *
 * Three buckets the catalog + router treat differently:
 *
 *   - `daily_driver`  — models a single solo contributor can serve at a
 *                       chat-viable latency. The default chat model on
 *                       `senda.network` is always a `daily_driver` that
 *                       at least one peer is actively serving.
 *   - `capacity`      — large models (32B–70B class) that only fit on
 *                       beefy single peers or pooled split cohorts.
 *                       Routable on `/v1/models`, visible in the
 *                       catalog, but not chat-default. Through-mesh
 *                       latency is honestly slow in this tier; the UI
 *                       surfaces the expected TTFT/tok-s so the user
 *                       opts in with eyes open.
 *   - `experimental`  — anything new or uncategorised. Functional but
 *                       not promised.
 *
 * Tier is a static property of `(model family, parameter count)` — it
 * doesn't depend on which peer is currently serving the model. That's
 * why this lives in a plain lookup, not on the runtime status payload.
 *
 * Matching uses `normalizeModelId` (same helper the catalog uses) so a
 * runtime-reported id like `qwen3-8b-q4_k_m.gguf` matches the canonical
 * `Qwen3-8B-Q4_K_M` row.
 *
 * Adding a new model: add a row to `TIER_BY_MODEL` below. If you
 * forget, `getModelTier` falls back to `experimental` and the catalog
 * renders it under the experimental section.
 */

import { normalizeModelId } from "./model-id";

export type ModelTier = "daily_driver" | "capacity" | "experimental";

/**
 * Per-tier latency expectations the routing SLA gate (Phase 4.B) reads,
 * and the catalog row uses for the "expected TTFT/tok-s" copy on the
 * capacity-tier expanded view.
 *
 * `target_ttft_ms_p50`  — request is routed to the mesh only when at
 *                          least one peer's measured TTFT p50 for this
 *                          model is below this number.
 * `target_tps_p50`       — same gate, for decode rate.
 * `min_native_ratio`     — through-mesh / native throughput floor.
 *                          Enforced in `evaluateSla`: a peer whose
 *                          measured through-mesh tok/s has degraded
 *                          below this fraction of its OWN native
 *                          baseline is demoted, so the entry routes
 *                          around it and the served through-mesh/native
 *                          ratio stays tight. Only applied when the peer
 *                          actually reports a native baseline (a solo
 *                          serve sits at ~1.0 by construction; pooled
 *                          splits and legacy peers have no baseline and
 *                          are never penalized). Until external supply
 *                          activates (Phase 5.E) a demotion changes only
 *                          the SLA verdict + bookkeeping, not what gets
 *                          served. Set a tier to 0 to disable the floor.
 *
 * Values are deliberately conservative for the daily-driver tier
 * (chat UX bar) and lenient for capacity (correctness over speed).
 */
export type TierSla = {
  target_ttft_ms_p50: number;
  target_tps_p50: number;
  min_native_ratio: number;
};

export const SLA_TARGETS_BY_TIER: Record<ModelTier, TierSla> = {
  daily_driver: {
    target_ttft_ms_p50: 3_000,
    target_tps_p50: 8,
    min_native_ratio: 0.6,
  },
  capacity: {
    target_ttft_ms_p50: 15_000,
    target_tps_p50: 0.8,
    min_native_ratio: 0.3,
  },
  experimental: {
    target_ttft_ms_p50: 30_000,
    target_tps_p50: 0.3,
    min_native_ratio: 0,
  },
};

/**
 * Canonical-id → tier table.
 *
 * Hand-maintained alongside `MODEL_CATALOG`. Anything not in this map
 * is `experimental`, which is the safe default — it doesn't promote
 * the model to chat-default and tells the user the tier is undecided.
 */
const TIER_BY_MODEL: Record<string, ModelTier> = {
  // Daily-driver tier: ~8B–14B dense models, runs solo on any modern
  // Mac (16 GB+) or a mid-range GPU (8 GB+ VRAM). These are the only
  // models that can hit the daily-driver SLA on a single peer.
  "Qwen3-8B-Q4_K_M": "daily_driver",
  "Gemma-3-12B-it-Q4_K_M": "daily_driver",
  "Qwen3.5-9B-Vision-Q4_K_M": "daily_driver",
  "Llama-3.1-8B-Instruct-Q4_K_M": "daily_driver",
  "Qwen2.5-Coder-7B-Instruct-Q4_K_M": "daily_driver",
  "DeepSeek-R1-Distill-Qwen-14B-Q4_K_M": "daily_driver",
  "Llama-3.2-3B-Instruct-Q4_K_M": "daily_driver",

  // Capacity tier: 27B–72B dense + larger MoE. Routable but slow;
  // surfaces "proof-of-capacity, not chat default" copy on the row.
  // The DeepSeek-70B served 2026-05-23 at ~1.0 tok/s lives here.
  "Gemma-3-27B-it-Q4_K_M": "capacity",
  "Qwen3.6-27B-Q4_K_M": "capacity",
  "Qwen3-30B-A3B-Q4_K_M": "capacity",
  "GLM-4.7-Flash-Q4_K_M": "capacity",
  "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M": "capacity",
  "GLM-4-32B-0414-Q4_K_M": "capacity",
  "Qwen3-32B-Q4_K_M": "capacity",
  "Qwen3.6-35B-A3B-Q4_K_M": "capacity",
  "Qwen2.5-Coder-32B-Instruct-Q4_K_M": "capacity",
  "Llama-3.3-70B-Instruct-Q4_K_M": "capacity",
  "DeepSeek-R1-Distill-70B-Q4_K_M": "capacity",
  "Qwen2.5-72B-Instruct-Q4_K_M": "capacity",
  "Qwen3-Coder-Next-Q4_K_M": "capacity",
  "Mixtral-8x22B-Instruct-Q4_K_M": "capacity",
  "Qwen3.5-122B-A10B-Q4_K_M": "capacity",
  "Qwen3-235B-A22B-Q4_K_M": "capacity",
  "Qwen3.5-397B-A17B-Q4_K_M": "capacity",

  // Smoke-test only; not a chat-default candidate even though it's
  // tiny. Useful for proving the runtime is alive end-to-end.
  "Qwen3-0.6B-Q4_K_M": "experimental",
};

const NORMALIZED_TIER_BY_MODEL: Map<string, ModelTier> = new Map(
  Object.entries(TIER_BY_MODEL).map(([id, tier]) => [normalizeModelId(id), tier]),
);

export function getModelTier(modelId: string): ModelTier {
  const n = normalizeModelId(modelId);
  const direct = NORMALIZED_TIER_BY_MODEL.get(n);
  if (direct) return direct;
  // HF org-prefixed stems (`google_gemma-3-27b-it-…`) must hit catalog tiers.
  for (const [key, tier] of NORMALIZED_TIER_BY_MODEL) {
    if (n.endsWith("-" + key) || key.endsWith("-" + n)) return tier;
  }
  return "experimental";
}

/**
 * Sort key so the catalog renders highest-priority tier first.
 * Lower number = appears earlier.
 */
export function tierRank(tier: ModelTier): number {
  switch (tier) {
    case "daily_driver":
      return 0;
    case "capacity":
      return 1;
    case "experimental":
      return 2;
  }
}

/** UI labels for the tier badge + section headers. */
export const TIER_LABELS: Record<ModelTier, string> = {
  daily_driver: "Daily driver",
  capacity: "Capacity",
  experimental: "Experimental",
};

/**
 * One-line copy under the section heading. Calibrated against the
 * May 23–24 DeepSeek 70B run (~9.7 s TTFT, ~1.0 tok/s) so the
 * capacity-tier copy doesn't surprise the user with "1 tok/s" after
 * the click.
 */
export const TIER_DESCRIPTIONS: Record<ModelTier, string> = {
  daily_driver:
    "Models a single contributor can serve at chat-viable latency. Targeted: under 3 s to first token, 8+ tok/s decode.",
  capacity:
    "Bigger models routable as a demo, not the chat default. Dense models (32B+) are slow through the mesh today — expect 10–15 s to first token and 1–2 tok/s. Expert-sharded MoEs (the 30B-A3B class) activate only ~3B params per token, so they pool across contributors and decode much faster.",
  experimental:
    "Newly added or uncategorised. Functional but not promised; behaviour and performance may change without notice.",
};

/**
 * Contribution weight per tier — how much one served token of a model in
 * this tier counts toward a contributor's credit total.
 *
 * **This is a measure of work, not a price.** Senda deliberately does NOT
 * value contribution in dollars: there is no payment rail, no treasury, and
 * no price for a token today (see `internal/STRATEGY.md` Phase 5). Instead we
 * count the one thing we can actually measure — completion tokens served —
 * and weight them by how hard the model is to serve, so a scarce capacity
 * serve is credited more than an abundant daily-driver serve.
 *
 * The weights are the ratios the old illustrative USD rate card already
 * encoded (0.05 : 0.25 : 0.02 → 1 : 5 : 0.4), normalized so a daily-driver
 * token is the base unit. Keeping the ratio means the relative economics are
 * unchanged; we've simply stopped pretending to know the dollar value.
 *
 * A "credit" is therefore just a tier-weighted token. Not a currency, not a
 * coin — a unit to track contribution until the network ships its own.
 */
export const TIER_WEIGHT: Record<ModelTier, number> = {
  daily_driver: 1,
  capacity: 5,
  experimental: 0.4,
};

/** One contributor model's slice of the weekly contribution. */
export type ContributionByModel = {
  model: string;
  tier: ModelTier;
  tokens: number;
  /** Tier-weighted tokens: `tokens * TIER_WEIGHT[tier]`. */
  credits: number;
};

/** Result of {@link estimateContribution}. */
export type ContributionEstimate = {
  totalTokens: number;
  totalCredits: number;
  /** Per-model rows, sorted by credits descending (then tokens, then name). */
  perModel: ContributionByModel[];
};

/**
 * Turn a per-model served-token map (the runtime's
 * `serving_tokens_7d_by_model`) into a contribution estimate using
 * {@link TIER_WEIGHT}. Pure + deterministic so it's unit-testable and
 * identical wherever it's rendered.
 *
 * Models with zero tokens are dropped. Credits are intentionally NOT rounded
 * here — formatting is the caller's job — so the sum of the per-model rows
 * always equals `totalCredits` exactly.
 */
export function estimateContribution(
  tokensByModel: Record<string, number> | undefined | null,
): ContributionEstimate {
  const perModel: ContributionByModel[] = [];
  let totalTokens = 0;
  let totalCredits = 0;
  for (const [model, tokensRaw] of Object.entries(tokensByModel ?? {})) {
    const tokens = Number.isFinite(tokensRaw) ? Math.max(0, tokensRaw) : 0;
    if (tokens <= 0) continue;
    const tier = getModelTier(model);
    const credits = tokens * TIER_WEIGHT[tier];
    perModel.push({ model, tier, tokens, credits });
    totalTokens += tokens;
    totalCredits += credits;
  }
  perModel.sort(
    (a, b) =>
      b.credits - a.credits ||
      b.tokens - a.tokens ||
      a.model.localeCompare(b.model),
  );
  return { totalTokens, totalCredits, perModel };
}

/**
 * Canonical daily-driver model id used as the default when no other
 * daily-driver is being served. Shared by `app/api/chat/route.ts`
 * (server) and `ModelSelector.tsx` (client) so every surface agrees on
 * the same flagship and the chat default never silently lands on a
 * capacity-tier model.
 */
export const DEFAULT_DAILY_DRIVER_MODEL = "Qwen3-8B-Q4_K_M";

/**
 * Pick the default chat model from a routable model list.
 *
 * The invariant this enforces: **the chat default is always a
 * daily-driver.** A capacity-tier model (32B–70B class, ~1 tok/s
 * through-mesh) must never become the default just because it happens
 * to be the only thing currently routable — a brand-new visitor hitting
 * "Hi there" against a 70B is the exact UX failure the routable-network
 * reframe exists to avoid.
 *
 * Resolution order:
 *   1. An explicit `preferred` (operator's `SENDA_MODEL`) when it's
 *      routable — an explicit pin wins, including a capacity model.
 *   2. The canonical daily-driver if it's routable, else the first
 *      routable daily-driver.
 *   3. `DEFAULT_DAILY_DRIVER_MODEL` even when it isn't routable — so a
 *      capacity-only mesh produces an honest "no peer is serving this
 *      model" error downstream rather than a slow, surprising stream.
 *
 * Returns `undefined` only for an empty input list. Used by both
 * `app/api/chat/route.ts` server-side and `ModelSelector.tsx`
 * client-side so the default agrees across surfaces.
 */
export function pickDefaultModelByTier(
  routableModels: string[],
  preferred?: string | null,
): string | undefined {
  if (routableModels.length === 0) return undefined;
  if (preferred && routableModels.includes(preferred)) return preferred;
  const dailyDrivers = routableModels.filter(
    (m) => getModelTier(m) === "daily_driver",
  );
  if (dailyDrivers.length > 0) {
    return dailyDrivers.includes(DEFAULT_DAILY_DRIVER_MODEL)
      ? DEFAULT_DAILY_DRIVER_MODEL
      : dailyDrivers[0];
  }
  return DEFAULT_DAILY_DRIVER_MODEL;
}
