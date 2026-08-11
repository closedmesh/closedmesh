"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PublicHeader } from "../../components/PublicHeader";
import { MeshLiveStatus } from "../../components/MeshLiveStatus";
import { nodeDisplayState } from "../../lib/node-display-state";
import { nodeLooksServingButUndialable } from "../../lib/node-entry-dialability";
import { MODEL_CATALOG, type CatalogModel } from "../../lib/model-catalog";
import { modelIdsMatch } from "../../lib/model-id";
import {
  MESH_HEALTH_REASON_COPY,
  type MeshHealth,
} from "../../lib/mesh-health";
import {
  getModelTier,
  tierRank,
  TIER_LABELS,
  TIER_DESCRIPTIONS,
  type ModelTier,
} from "../../lib/model-tiers";
import type {
  NodeSummary,
  ModelAd,
  VerifyVerdict,
  Reputation,
} from "../../lib/use-mesh-status";
import {
  MIN_PIPELINE_ELECTION_PEER_VERSION,
  peerSupportsPipelineElection,
} from "../../lib/pipeline-election-version";

type MeshNode = NodeSummary;

type MeshStatus = {
  online: boolean;
  nodeCount: number;
  models: string[];
  nodes: MeshNode[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prettyHostname(raw: string | null): string {
  if (!raw) return "Unknown node";
  // Strip common suffixes like .local, .internal, ip-xxx-xxx-xxx-xxx
  if (raw.startsWith("ip-")) return "Entry node";
  return raw.replace(/\.local$/, "").replace(/\.internal$/, "");
}

function prettyModelName(id: string): string {
  return id
    .replace(/\.gguf$/i, "")
    .replace(/-Q\d+(_K(_[SM])?|_0|_1)?$/i, "")
    .replace(/-UD-Q\d+(_K(_[SM]|_XL))?$/i, "");
}

function backendLabel(backend: string, _vendor: string): string {
  const map: Record<string, string> = {
    metal: "Apple Metal",
    cuda: "NVIDIA CUDA",
    rocm: "AMD ROCm",
    vulkan: "Vulkan",
    cpu: "CPU",
  };
  return map[backend] ?? backend;
}

/**
 * Try to match a runtime-reported model id against our hand-maintained
 * catalog. The runtime stores models under the resolved Hugging Face
 * filename stem (e.g. `Mixtral-8x7B-Instruct-v0.1.q5_k_m`) while the
 * catalog uses our canonical refs (`Mixtral-8x7B-Instruct-v0.1-Q5_K_M`),
 * so go through the same normalization we use everywhere else for
 * matching. Returns null for orphan / custom models — those we just
 * can't make any fit claim about, since we have no minVramGb.
 */
function lookupCatalogModel(id: string): CatalogModel | null {
  return MODEL_CATALOG.find((m) => modelIdsMatch(m.id, id)) ?? null;
}

/**
 * What is this node trying to load, and is it actually going to fit?
 *
 * Returns `null` if the node isn't trying to load anything. Otherwise
 * returns the first servingModels entry plus a fit verdict: if we can
 * map it to a catalog entry we compute the shortfall against the host's
 * usable VRAM, and otherwise we say "unknown" so the UI can render
 * "Loading X" without making a false fit claim.
 *
 * Why a single model rather than the whole list: stuck-loading hosts
 * almost always have just one entry in `servingModels` — it's the
 * startup-config model the runtime is trying to bring up. If we ever
 * see multiple, picking the first one is a reasonable default; the
 * card layout doesn't need to fan out.
 */
type WarmingVerdict =
  | { kind: "fits"; modelId: string; displayName: string; catalog: CatalogModel; hostVramGb: number }
  | {
      kind: "pooling";
      modelId: string;
      displayName: string;
      catalog: CatalogModel;
      peerCount: number;
      pooledGb: number;
      neededGb: number;
      /**
       * How many peers in the mesh have actually committed to hosting
       * this model right now (i.e. their `hosted_models` includes it).
       * When this is 0 with `peerCount >= 2`, the mesh has the
       * capacity to serve but no peer has been elected as host yet —
       * the symptom that masquerades as "loading forever" on the
       * public page and was the actual root cause of the 5-machine
       * stall, not a memory shortfall.
       */
      hostingCount: number;
      /** Loading peers on runtimes too old for pipeline election — excluded from counts. */
      outdatedBlockers: { hostname: string; version: string | null }[];
    }
  | {
      kind: "underprovisioned";
      modelId: string;
      displayName: string;
      catalog: CatalogModel;
      hostVramGb: number;
      shortfallGb: number;
    }
  | { kind: "unknown"; modelId: string; displayName: string };

function warmingUpVerdict(
  node: NodeSummary,
  warmingPeerCountForModel = 1,
  pooledGbForModel = 0,
  hostingCountForModel = 0,
  outdatedBlockers: { hostname: string; version: string | null }[] = [],
): WarmingVerdict | null {
  const modelId = node.servingModels[0];
  if (!modelId) return null;
  const display = prettyModelName(modelId);
  const catalog = lookupCatalogModel(modelId);
  if (!catalog) return { kind: "unknown", modelId, displayName: display };
  // When multiple peers are simultaneously advertising the same model in
  // `loading`, the honest user-facing state is "the distributed group is
  // forming / recovering". A missing splitGroup snapshot during entry
  // restart or host re-election must not be rendered as four separate solo
  // capacity failures with fake per-machine shortfalls.
  if (node.state === "loading" && warmingPeerCountForModel > 1) {
    return {
      kind: "pooling",
      modelId,
      displayName: catalog.name,
      catalog,
      peerCount: warmingPeerCountForModel,
      pooledGb: pooledGbForModel,
      neededGb: catalog.minVramGb,
      hostingCount: hostingCountForModel,
      outdatedBlockers,
    };
  }
  // Use the smaller of the two reported numbers — `vramGb` (top-level)
  // is the Metal-budgeted figure for Apple Silicon (~75% of unified
  // memory) and `capability.vramGb` is sometimes the unified-memory
  // total. The conservative number is what actually constrains
  // llama-server's allocator, so it's what we should compare against
  // the catalog's minVramGb.
  //
  // When the node is in a pipeline-parallel split, the model is
  // intentionally NOT supposed to fit on a single host — the whole
  // point of the split is to pool VRAM across `splitGroup.peerIds`.
  // Use the group's pooled total if it's the larger number, so a
  // legitimate split-mode load doesn't get rendered as
  // "underprovisioned · awaiting capacity" with a "Share your machine"
  // CTA when in fact the mesh has plenty of capacity and the worker
  // just hasn't finished bringing its layers up yet.
  const soloVramGb = Math.min(
    node.vramGb || Number.POSITIVE_INFINITY,
    node.capability?.vramGb || Number.POSITIVE_INFINITY,
  );
  const groupVramGb = node.splitGroup?.totalGroupVramGb ?? 0;
  const hostVramGb = Math.max(
    groupVramGb,
    Number.isFinite(soloVramGb) ? soloVramGb : 0,
  );
  if (!Number.isFinite(hostVramGb) || hostVramGb <= 0) {
    return { kind: "unknown", modelId, displayName: display };
  }
  const shortfall = catalog.minVramGb - hostVramGb;
  // Same threshold as app/lib/mesh-fit.ts — sub-gigabyte misses are
  // measurement noise, anything bigger is a real "won't actually
  // serve" verdict.
  if (shortfall > 0.5) {
    return {
      kind: "underprovisioned",
      modelId,
      displayName: catalog.name,
      catalog,
      hostVramGb,
      shortfallGb: shortfall,
    };
  }
  return {
    kind: "fits",
    modelId,
    displayName: catalog.name,
    catalog,
    hostVramGb,
  };
}

function backendColor(backend: string): string {
  const map: Record<string, string> = {
    metal: "text-blue-400 bg-blue-400/10 border-blue-400/20",
    cuda: "text-green-400 bg-green-400/10 border-green-400/20",
    rocm: "text-orange-400 bg-orange-400/10 border-orange-400/20",
    vulkan: "text-purple-400 bg-purple-400/10 border-purple-400/20",
    cpu: "text-[var(--fg-muted)] bg-[var(--bg-elev)] border-[var(--border)]",
  };
  return map[backend] ?? "text-[var(--fg-muted)] bg-[var(--bg-elev)] border-[var(--border)]";
}

/**
 * Phase 3.1 trust badge. A peer gossips its per-model performance claims
 * (t/s, TTFT, logit fingerprint) and the entry node verifies them against
 * the owner's Ed25519 signature, node-id binding, and freshness window.
 *
 *   - `verified`  → green "signed metrics": the advertised numbers are
 *     cryptographically attributable to a real, non-revoked owner and can
 *     be revoked if the owner ever lies. This is the marketplace-honesty
 *     property Phase 3.1 buys.
 *   - any other non-`unsigned` verdict (bad signature, wrong node, stale,
 *     revoked/untrusted owner, unknown format) → amber warning: the peer
 *     IS advertising signed claims but they failed verification, so the
 *     numbers should not be trusted. This is the case worth shouting about.
 *   - `unsigned` (or absent, i.e. a pre-3.1 peer) → render nothing. Every
 *     legacy peer is unsigned by default; badging them all would be noise,
 *     not signal.
 */
const MODEL_AD_FAIL_LABELS: Record<string, string> = {
  invalid_signature: "bad signature",
  mismatched_node_id: "wrong node id",
  stale: "stale claim",
  revoked_owner: "revoked owner",
  untrusted_owner: "untrusted owner",
  unsupported_protocol: "unknown format",
};

function ModelAdBadge({ ad }: { ad: ModelAd }) {
  if (ad.status === "unsigned") return null;
  if (ad.verified) {
    const owner = ad.ownerId ? `${ad.ownerId.slice(0, 12)}…` : "unknown owner";
    return (
      <span
        className="whitespace-nowrap rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
        title={`Owner-signed metrics verified — Ed25519 signature checks out, bound to this node id, and fresh. Owner ${owner}, ${ad.modelCount} model${ad.modelCount === 1 ? "" : "s"}. The advertised numbers are cryptographically attributable to a real owner and revocable if they ever lie.`}
      >
        ✓ signed
      </span>
    );
  }
  const label = MODEL_AD_FAIL_LABELS[ad.status] ?? ad.status;
  return (
    <span
      className="whitespace-nowrap rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
      title={`This peer is advertising signed model metrics, but they did not verify (${ad.status}). Treat its advertised throughput as untrusted.`}
    >
      ⚠ {label}
    </span>
  );
}

/**
 * Phase 3.2 sample-and-verify badge. Where {@link ModelAdBadge} proves *who*
 * signed the claim, this proves the peer is *actually running the model right
 * now*: the entry node re-runs a byte-identical probe and compares logits to
 * an independently-generated reference.
 *
 * We collapse the per-model map to a single node-level badge:
 *   - any `mismatch`  → amber warning (the loud case — a peer caught lying)
 *   - else any `match` → emerald "independently verified"
 *   - only `inconclusive`/empty → render nothing (no signal, no badge)
 */
function VerifyBadge({ verifyByModel }: { verifyByModel: Record<string, VerifyVerdict> }) {
  const entries = Object.entries(verifyByModel);
  if (entries.length === 0) return null;

  const mismatched = entries.filter(([, v]) => v.verdict === "mismatch");
  if (mismatched.length > 0) {
    const models = mismatched.map(([m]) => m).join(", ");
    return (
      <span
        className="whitespace-nowrap rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
        title={`Independent verification FAILED for ${models}. The entry node re-ran a byte-identical probe against this peer's live model and the returned logits diverged from an independently-generated reference — the peer is not running the model it advertises. Treat its claims for ${models} as untrusted.`}
      >
        ⚠ verify failed
      </span>
    );
  }

  const matched = entries.filter(([, v]) => v.verdict === "match");
  if (matched.length === 0) return null;
  const models = matched.map(([m]) => m).join(", ");
  return (
    <span
      className="whitespace-nowrap rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
      title={`Independently verified — the entry node re-ran a byte-identical probe against this peer's live model${matched.length === 1 ? "" : "s"} (${models}) and the returned logits reproduced an independently-generated reference. This peer is genuinely running what it advertises, not a smaller/different model or canned output.`}
    >
      ✓ verified
    </span>
  );
}

/**
 * Phase 3.2 reputation chip. Where {@link VerifyBadge} reflects the *latest*
 * probe (1h TTL), this surfaces the entry's *durable* reputation accumulator:
 * an EWMA over every sample-and-verify verdict for the peer, persisted across
 * entry restarts. It answers "what's this peer's track record?", not just
 * "did the last probe pass?".
 *
 *   - any `watch` model (a mismatch on record, not yet recovered) → amber
 *   - else any `trusted` model → emerald chip with the aggregate score and
 *     total probe count (the detail the verify badge can't show)
 *   - else (only `unproven`, but probes exist) → muted "building" chip so the
 *     accumulator's progress is visible before it crosses the trust threshold
 *   - no probes at all → render nothing
 */
function ReputationBadge({
  reputationByModel,
}: {
  reputationByModel: Record<string, Reputation>;
}) {
  const entries = Object.entries(reputationByModel);
  if (entries.length === 0) return null;

  const totalSamples = entries.reduce((a, [, r]) => a + r.samples, 0);
  if (totalSamples === 0) return null;
  const weighted = entries.reduce((a, [, r]) => a + r.score * r.samples, 0);
  const avg = weighted / totalSamples;
  const probeLabel = `${totalSamples} probe${totalSamples === 1 ? "" : "s"}`;
  const perModel = entries
    .map(
      ([m, r]) =>
        `${m}: ${r.grade} (score ${r.score.toFixed(2)}, ${r.matches}✓/${r.mismatches}✗ over ${r.samples})`,
    )
    .join("; ");

  const watch = entries.filter(([, r]) => r.grade === "watch");
  if (watch.length > 0) {
    return (
      <span
        className="whitespace-nowrap rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
        title={`Reputation: WATCH. This peer has at least one mismatch on its accumulated record and hasn't recovered above the trust threshold. The score is an EWMA over every probe (survives entry restarts), so a single bad probe doesn't flip it — but a pattern does. Per model — ${perModel}.`}
      >
        ⚠ rep watch
      </span>
    );
  }

  const trusted = entries.filter(([, r]) => r.grade === "trusted");
  if (trusted.length > 0) {
    return (
      <span
        className="whitespace-nowrap rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
        title={`Reputation: TRUSTED. Accumulated trust score ${avg.toFixed(2)} over ${probeLabel} — the entry has independently reproduced this peer's model(s) consistently across many probes, not just once. This is the durable track record (persists across restarts), unlike the instantaneous "independently verified" badge. Per model — ${perModel}.`}
      >
        ★ rep {avg.toFixed(2)} · {probeLabel}
      </span>
    );
  }

  return (
    <span
      className="whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-0.5 text-[11px] font-medium text-[var(--fg-muted)]"
      title={`Reputation: building. The entry has probed this peer ${probeLabel} but not enough conclusive samples to mint trust yet (accumulated score ${avg.toFixed(2)}). Per model — ${perModel}.`}
    >
      rep building · {probeLabel}
    </span>
  );
}

// Color/label derivation lives in app/lib/node-display-state.ts so this
// page, the dashboard, and the local /nodes mesh table can never disagree
// about what the same node looks like at the same moment.

// ---------------------------------------------------------------------------
// Node card
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * Compare two semver-ish version strings ("0.65.7"). Returns -1 if a<b,
 * 0 if equal, 1 if a>b. Tolerant of extra suffixes ("0.65.7-rc1") which
 * are stripped before numeric comparison.
 */
function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((p) => parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * Highest runtime version observed in the current snapshot. Anything
 * below it is rendered with a small "outdated — update" hint so users
 * with stuck peers can immediately tell whether the fix is "wait for
 * the runtime" or "go update that machine". Computed across all nodes
 * (working + unavailable) so even a stuck peer has something to compare
 * against.
 */
function maxVersion(nodes: { version: string | null }[]): string | null {
  let best: string | null = null;
  for (const n of nodes) {
    if (!n.version) continue;
    if (!best || compareVersions(n.version, best) > 0) best = n.version;
  }
  return best;
}

/**
 * Median of a numeric array. Returns `null` for empty input rather than
 * 0 so the caller can distinguish "no samples" from "samples that
 * average to zero" — same convention the runtime uses for missing
 * `measured_*_p50_by_model` keys.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One row in the Catalog block on /status. Aggregates per-peer
 * measurements for `model` into the marketplace-shaped row:
 *
 *   - Contributor count = peers whose `servingModels` / `capability.loadedModels`
 *     include this model. We dedupe by node id.
 *   - Throughput = median of `measuredTpsP50ByModel[model]` across reporting
 *     peers (median of medians — fine as MVP, ranks the cohort correctly
 *     and is robust to one outlier).
 *   - Time-to-first-token = the LOWEST `measuredTtftMsP50ByModel[model]`
 *     across reporting peers. We pick the best because that's the
 *     marketplace promise — if any peer can answer fast, the router can
 *     hand you to that peer. Median-of-medians here would hide the best
 *     hardware, which is the opposite of what we want to surface.
 *   - "No measurements yet" placeholder when every reporting peer is on
 *     a pre-v0.66.42 runtime (no `measured_*` maps), or when no peer in
 *     the cohort has actually completed a local inference for this
 *     model. We deliberately don't show fake 0 t/s in that case — the
 *     whole point of the runtime distinguishing "missing entry" from
 *     "measured zero" is to let this UI tell users "we'd report it if
 *     we had it, we don't yet".
 */
/**
 * Phase 4.A — split routable models by tier first, then by topology
 * within each tier (solo above pooled-split).
 *
 * Daily-driver tier is the headline catalog. Capacity + experimental
 * are collapsed by default behind toggles in the rendering code; this
 * helper just groups so the renderer can decide what to show.
 */
function partitionCatalogModels(
  models: string[],
  nodes: MeshNode[],
): Record<ModelTier, { solo: string[]; split: string[] }> {
  const empty = () => ({ solo: [] as string[], split: [] as string[] });
  const buckets: Record<ModelTier, { solo: string[]; split: string[] }> = {
    daily_driver: empty(),
    capacity: empty(),
    experimental: empty(),
  };
  const sorted = [...models].sort(
    (a, b) => tierRank(getModelTier(a)) - tierRank(getModelTier(b)),
  );
  for (const model of sorted) {
    const tier = getModelTier(model);
    let hostCount = 0;
    let workerCount = 0;
    for (const n of nodes) {
      if (n.splitRole === "pipeline_host" && n.splitGroup?.model === model) {
        hostCount += 1;
      } else if (
        n.splitRole === "pipeline_worker" &&
        n.splitGroup?.model === model
      ) {
        workerCount += 1;
      }
    }
    if (hostCount > 0 || workerCount > 0) {
      buckets[tier].split.push(model);
    } else {
      buckets[tier].solo.push(model);
    }
  }
  return buckets;
}

/**
 * Small tier badge rendered to the right of the model name in each
 * `CatalogRow`. Colour-coded so the headline tier reads at a glance:
 * green daily-driver, amber capacity (slow-by-design), neutral
 * experimental.
 */
function TierBadge({ tier }: { tier: ModelTier }) {
  const styles: Record<ModelTier, string> = {
    daily_driver:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    capacity: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    experimental: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] ${styles[tier]}`}
    >
      {TIER_LABELS[tier]}
    </span>
  );
}

/**
 * Phase 4.A — tier-aware catalog block. Daily-driver tier renders
 * expanded; capacity and experimental tiers render collapsed behind
 * a toggle with the SLA-style copy from `TIER_DESCRIPTIONS`.
 *
 * Why daily-driver renders open and capacity does not: the
 * 5-machine DeepSeek-70B serve on 2026-05-23 measured ~1.0 tok/s
 * through the mesh entry. Putting that row at the top alongside
 * Qwen3-8B reads as "the product is slow," when the truthful framing
 * is that capacity-tier is opt-in, proof-of-capacity, expected to be
 * slow today, and not the chat default.
 */
function CatalogSection({
  models,
  nodes,
}: {
  models: string[];
  nodes: MeshNode[];
}) {
  const buckets = partitionCatalogModels(models, nodes);
  const [showCapacity, setShowCapacity] = useState(false);
  const [showExperimental, setShowExperimental] = useState(false);

  const renderRows = (tier: ModelTier) => {
    const { solo, split } = buckets[tier];
    if (solo.length === 0 && split.length === 0) return null;
    return (
      <div className="space-y-2">
        {solo.map((m) => (
          <CatalogRow key={m} model={m} nodes={nodes} />
        ))}
        {split.length > 0 && solo.length > 0 && (
          <div className="py-1 text-center text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
            — pooled splits —
          </div>
        )}
        {split.map((m) => (
          <CatalogRow key={m} model={m} nodes={nodes} />
        ))}
      </div>
    );
  };

  const tierCount = (tier: ModelTier) =>
    buckets[tier].solo.length + buckets[tier].split.length;

  const collapsedTier = (
    tier: ModelTier,
    open: boolean,
    setOpen: (next: boolean) => void,
  ) => {
    const count = tierCount(tier);
    if (count === 0) return null;
    return (
      <div className="mt-6">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-left hover:border-[var(--accent)]/40"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <TierBadge tier={tier} />
              <span className="text-[13px] font-semibold text-[var(--fg)]">
                {count} {count === 1 ? "model" : "models"}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-muted)]">
              {TIER_DESCRIPTIONS[tier]}
            </div>
          </div>
          <span className="shrink-0 text-[11px] text-[var(--fg-muted)]">
            {open ? "Hide" : "Show"}
          </span>
        </button>
        {open && <div className="mt-3">{renderRows(tier)}</div>}
      </div>
    );
  };

  const dailyCount = tierCount("daily_driver");

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
          Catalog
        </div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          Daily driver
        </div>
      </div>
      {dailyCount > 0 ? (
        <>
          <p className="mb-3 text-[11px] text-[var(--fg-muted)]">
            {TIER_DESCRIPTIONS.daily_driver}
          </p>
          {renderRows("daily_driver")}
        </>
      ) : (
        <p className="mb-3 text-[11px] text-[var(--fg-muted)]">
          No daily-driver model is currently being served by the mesh.
        </p>
      )}
      {collapsedTier("capacity", showCapacity, setShowCapacity)}
      {collapsedTier("experimental", showExperimental, setShowExperimental)}
    </div>
  );
}

function CatalogRow({ model, nodes }: { model: string; nodes: MeshNode[] }) {
  const tier = getModelTier(model);
  const contributors = nodes.filter(
    (n) =>
      n.servingModels.includes(model) ||
      (n.capability?.loadedModels?.includes(model) ?? false),
  );
  const contributorCount = contributors.length;

  // Classify the cohort by role so we can describe the topology in
  // plain English. We scope split/MoE membership to *this model*
  // because a peer's `splitRole` is per-model — a peer could be a
  // `pipeline_worker` for model A and serve model B solo at the same
  // time. The classification feeds the small line under the row title.
  let hostCount = 0;
  let workerCount = 0;
  let moeCount = 0;
  let soloCount = 0;
  for (const n of contributors) {
    if (n.splitRole === "pipeline_host" && n.splitGroup?.model === model) {
      hostCount += 1;
    } else if (
      n.splitRole === "pipeline_worker" &&
      n.splitGroup?.model === model
    ) {
      workerCount += 1;
    } else if (n.splitRole === "moe_shard" && n.moeShard?.model === model) {
      moeCount += 1;
    } else {
      soloCount += 1;
    }
  }
  const topologyParts: string[] = [];
  if (hostCount > 0 || workerCount > 0) {
    // Pipeline split is the "power-user pooled mode" (see Phase 0
    // narrative in `MeshComputer.tsx`) — label it explicitly so the
    // reader knows this row's t/s isn't single-machine performance.
    topologyParts.push(
      `${hostCount} host + ${workerCount} worker${workerCount === 1 ? "" : "s"} (pooled split)`,
    );
  }
  if (moeCount > 0) {
    topologyParts.push(
      `${moeCount} MoE shard${moeCount === 1 ? "" : "s"}`,
    );
  }
  if (soloCount > 0) {
    topologyParts.push(
      `${soloCount} solo contributor${soloCount === 1 ? "" : "s"}`,
    );
  }
  const topologyLabel = topologyParts.join(" · ");

  const tpsValues = contributors
    .map((n) => n.measuredTpsP50ByModel?.[model])
    .filter((v): v is number => typeof v === "number" && v > 0);
  const ttftValues = contributors
    .map((n) => n.measuredTtftMsP50ByModel?.[model])
    .filter((v): v is number => typeof v === "number" && v > 0);

  const medianTps = median(tpsValues);
  const lowestTtftMs = ttftValues.length > 0 ? Math.min(...ttftValues) : null;

  // Phase 3.0 benchmark honesty (runtime v0.66.49+). Each peer that
  // serves the model also runs a synthetic chat directly against its
  // own llama-server (no entry tunnel, no auth, no routing) and gossips
  // the result, so we can show the through-mesh and native numbers side
  // by side.
  //
  // We deliberately DON'T derive a single "mesh efficiency %" (through ÷
  // native) any more. That number was misleading: for a solo serve the
  // through-mesh and native paths are the *same* llama-server on the
  // *same* hardware, so the decode rate is identical by construction and
  // any gap is sampling noise, not a real penalty. The network's cost is
  // first-token latency (the entry tunnel + routing add to TTFT), not a
  // per-token throughput tax — so a throughput ratio measures the wrong
  // thing. A TTFT-based "overhead %" would be just as dishonest, because
  // native TTFT is a short synthetic probe while measured TTFT comes from
  // real, longer prompts; that gap is mostly prefill length, not mesh
  // overhead. So we show the honest raw measurements and let them speak:
  // through-mesh t/s tracks native t/s, and "fastest first token" is the
  // real, un-editorialised latency. Pooled-split serves are the one case
  // where through-mesh t/s is genuinely lower (the model is split across
  // peers over WAN); the topology label already says so.
  const nativeTpsValues = contributors
    .map((n) => n.nativeTpsP50ByModel?.[model])
    .filter((v): v is number => typeof v === "number" && v > 0);
  const medianNativeTps = median(nativeTpsValues);

  // Pooled-split is the one topology where a through-mesh throughput gap is
  // genuinely real (not a measurement artifact): the model is pipelined
  // across peers over WAN, so decode pays a cross-peer round-trip per token.
  // We surface that explicitly below. The split decode rate is reported by
  // the pipeline *host* (workers only lend their rpc-server), so we read the
  // host's measurement rather than the row-wide median — on a mixed row
  // (same model served solo by a big peer AND split by a pool) the row-wide
  // median would blend the fast solo rate with the slow split rate and tell
  // the reader nothing true.
  const isPooledSplit = hostCount > 0 || workerCount > 0;
  const splitPeerCount = hostCount + workerCount;
  const splitTpsValues = contributors
    .filter(
      (n) => n.splitRole === "pipeline_host" && n.splitGroup?.model === model,
    )
    .map((n) => n.measuredTpsP50ByModel?.[model])
    .filter((v): v is number => typeof v === "number" && v > 0);
  const splitTps = median(splitTpsValues);

  const hasMeasurements = medianTps !== null || lowestTtftMs !== null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${contributorCount > 0 ? "bg-emerald-400" : "bg-slate-500"}`}
          />
          <span className="truncate text-[14px] font-semibold text-[var(--fg)]">
            {prettyModelName(model)}
          </span>
          <TierBadge tier={tier} />
        </div>
        <div className="shrink-0 text-[11px] text-[var(--fg-muted)] tabular-nums">
          {contributorCount === 0
            ? "no peers loaded"
            : topologyLabel ||
              (contributorCount === 1
                ? "1 contributor"
                : `${contributorCount} contributors`)}
        </div>
      </div>
      {hasMeasurements ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px] text-[var(--fg-muted)]">
          {medianTps !== null && (
            <span>
              <span className="font-semibold tabular-nums text-[var(--fg)]">
                {medianTps >= 10 ? medianTps.toFixed(0) : medianTps.toFixed(1)}
              </span>{" "}
              t/s through mesh
              {tpsValues.length > 1 && (
                <span className="text-[10px] uppercase tracking-wider opacity-70">
                  {" "}
                  median of {tpsValues.length}
                </span>
              )}
            </span>
          )}
          {medianNativeTps !== null && (
            <span title="Synthetic chat against the peer's own llama-server on 127.0.0.1 — no entry tunnel, no auth, no routing. Through-mesh t/s tracks this because the network adds first-token latency, not a per-token decode penalty. (Pooled-split serves are lower: the model is split across peers over WAN.)">
              <span className="font-semibold tabular-nums text-[var(--fg)]">
                {medianNativeTps >= 10
                  ? medianNativeTps.toFixed(0)
                  : medianNativeTps.toFixed(1)}
              </span>{" "}
              t/s native
            </span>
          )}
          {lowestTtftMs !== null && (
            <span title="Median-best time to first token across serving peers — measured through the full mesh path (entry tunnel + auth + routing). This is where the network's cost shows up; decode rate is unaffected.">
              <span className="font-semibold tabular-nums text-[var(--fg)]">
                {lowestTtftMs < 1000
                  ? `${Math.round(lowestTtftMs)}ms`
                  : `${(lowestTtftMs / 1000).toFixed(1)}s`}
              </span>{" "}
              fastest first token
            </span>
          )}
        </div>
      ) : contributorCount > 0 ? (
        <div className="mt-2 text-[12px] text-[var(--fg-muted)]">
          No measurements yet — peers need to actually serve a request before
          throughput shows up here. Older runtimes (&lt; v0.66.42) won&apos;t
          report measurements at all.
        </div>
      ) : null}
      {isPooledSplit && (
        <div className="mt-2 text-[11px] leading-relaxed text-[var(--fg-muted)]">
          <span className="text-[var(--fg)]">Split tax:</span> this model is too
          large for any single peer, so it&apos;s pipelined across{" "}
          {splitPeerCount} peers over WAN — every token makes a cross-peer
          round-trip
          {splitTps !== null ? (
            <>
              , which is why it serves at just{" "}
              <span className="font-semibold tabular-nums text-[var(--fg)]">
                {splitTps >= 10 ? splitTps.toFixed(0) : splitTps.toFixed(1)} t/s
              </span>
            </>
          ) : (
            ", far below single-machine speed"
          )}
          . That gap is inherent to splitting, not mesh overhead.
          {medianNativeTps === null &&
            " There's no native baseline to compare against because a model this size doesn't fit on one machine — which is exactly why it's pooled."}
        </div>
      )}
    </div>
  );
}

function NodeCard({
  node,
  history,
  latestVersion,
}: {
  node: MeshNode;
  history?: NodeHistory;
  latestVersion: string | null;
}) {
  const hostname = prettyHostname(node.hostname);
  const isEntryNode = node.hostname?.startsWith("ip-");
  const cap = node.capability;
  const isServing = node.state === "serving";
  const inflightRequests = node.inflightRequests ?? 0;

  // Honest display: show what the node is actually doing right now. We
  // used to "smooth" loading→standby→Ready when the node had been good
  // recently, on the theory that re-elections briefly blip nodes through
  // these states. That assumption was wrong — a node can also get *stuck*
  // in "loading" for minutes (model failing to fit in VRAM, runtime bug,
  // etc.), and the smoothing made the page lie about it ("Ready · serving
  // Qwen3" while inference 503'd because the host never finished loading).
  // Show the real state; if the user sees "Loading 30s" that's the actual
  // information they need.
  const { dot, label: stateLabel } = nodeDisplayState(node);

  // How long has this node been stuck in `loading`? `loadingSince` is
  // tracked in history and reset whenever state moves to anything other
  // than `loading`. Past ~20s it's almost certainly stuck rather than
  // genuinely re-loading.
  //
  // Pipeline workers are EXCLUDED from this timer: the runtime keeps
  // them in `state="loading"` indefinitely while they hold rpc-server
  // shards for the host. Their "loading time" would tick up forever and
  // the card would say "Stuck loading 4h" in amber — exactly the opposite
  // of what's happening (they're healthy contributors). The green
  // "Contributing" label from nodeDisplayState is the correct read.
  const isPipelineWorker = node.splitRole === "pipeline_worker";
  const loadingFor =
    node.state === "loading" && !isPipelineWorker && history?.loadingSince
      ? Date.now() - history.loadingSince
      : 0;
  const stuckLoading = loadingFor > 20_000;

  // "Online for Xm" when we have history. Tells the user this isn't a
  // flapping node — it's been in the mesh consistently for a while.
  const onlineFor =
    history && !isEntryNode
      ? formatDuration(Date.now() - history.firstSeen)
      : null;

  const undialableFromEntry = nodeLooksServingButUndialable(node);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* State indicator */}
          <span className="relative mt-0.5 inline-flex h-2.5 w-2.5 flex-shrink-0">
            {isServing && (
              <span
                aria-hidden
                className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"
              />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`} />
          </span>
          <div className="min-w-0">
            <div
              className="text-sm font-medium text-[var(--fg)] truncate"
              title={
                node.splitRole === "pipeline_worker"
                  ? `Pipeline worker for ${prettyModelName(node.splitGroup?.model ?? "a pooled model")}`
                  : node.splitRole === "pipeline_host"
                    ? `Pipeline host for ${prettyModelName(node.splitGroup?.model ?? "a pooled model")}`
                    : undefined
              }
            >
              {isEntryNode ? "Entry node" : hostname}
            </div>
            <div className="text-[11px] text-[var(--fg-muted)] truncate">
              {isEntryNode ? (
                "entry.senda.network · always-on gateway"
              ) : (
                <>
                  {/* If the node is stuck loading we make it visually
                      distinct so the user immediately sees that this peer
                      is NOT actually serving — even though the green dot
                      means it's connected to the mesh. */}
                  {stuckLoading ? (
                    <span className="text-amber-400">
                      Stuck loading {formatDuration(loadingFor)}
                    </span>
                  ) : node.state === "loading" && loadingFor > 0 ? (
                    <span className="text-amber-300">
                      {stateLabel} {formatDuration(loadingFor)}
                    </span>
                  ) : (
                    stateLabel
                  )}
                  {onlineFor ? ` · online ${onlineFor}` : null}
                  {` · ${node.id.slice(0, 10)}`}
                </>
              )}
            </div>
          </div>
        </div>
        {/* Backend chip */}
        {!isEntryNode && (
          <span
            className={`flex-shrink-0 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium ${backendColor(cap.backend)}`}
          >
            {backendLabel(cap.backend, cap.vendor)}
          </span>
        )}
      </div>

      {/* Hardware row */}
      {!isEntryNode && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--fg-muted)]">
          {cap.vramGb > 0 && (
            <span className="whitespace-nowrap">
              <span className="font-medium text-[var(--fg)]">{cap.vramGb} GB</span> VRAM
            </span>
          )}
          {cap.vramGb === 0 && cap.backend === "cpu" && (
            <span>CPU inference</span>
          )}
          {/* System RAM (v0.66.38+). Hidden for pre-v0.66.38 peers
              (systemRamBytes undefined or 0) so we don't claim a peer
              "has 0 GB RAM" when it just hasn't gossiped the field. */}
          {!!node.systemRamBytes && node.systemRamBytes > 0 && (
            <span
              className="whitespace-nowrap"
              title="Total system RAM (used by RAM-aware host election)"
            >
              <span className="font-medium text-[var(--fg)]">
                {Math.round(node.systemRamBytes / 1e9)} GB
              </span>{" "}
              RAM
            </span>
          )}
          <span
            className={`whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] ${
              inflightRequests > 0
                ? "border-sky-400/40 bg-sky-400/10 text-sky-200"
                : "border-[var(--border)] text-[var(--fg-muted)]"
            }`}
            title="Current requests this peer reports over gossip"
          >
            {inflightRequests} in flight
          </span>
          {/* Runtime version. Quietly informational for healthy peers,
              flagged amber if outdated so users can see at a glance
              that this peer needs to update before they go hunting for
              other reasons it might be misbehaving. */}
          {node.version && (() => {
            const isOutdated =
              !!latestVersion &&
              compareVersions(node.version, latestVersion) < 0;
            return (
              <span
                className={`font-mono text-[11px] tabular-nums ${
                  isOutdated ? "text-amber-400" : "text-[var(--fg-muted)]"
                }`}
                title={
                  isOutdated
                    ? `Running v${node.version} — latest is v${latestVersion}. The desktop app self-upgrades the runtime in the background.`
                    : `Runtime v${node.version}`
                }
              >
                v{node.version}
                {isOutdated ? " · outdated" : ""}
              </span>
            );
          })()}
          {node.modelAd && <ModelAdBadge ad={node.modelAd} />}
          {node.verifyByModel && (
            <VerifyBadge verifyByModel={node.verifyByModel} />
          )}
          {node.reputationByModel && (
            <ReputationBadge reputationByModel={node.reputationByModel} />
          )}
        </div>
      )}

      {/* Pipeline-degraded note. The /api/status route gates this
          server-side and applies it to BOTH host and worker peers in
          a degraded cohort — when any member of the split_group is not
          `state="serving"`, every peer in the cohort is downgraded to
          loading + cleared loadedModels + `pipelineDegraded=true`. The
          two failure shapes we want to name explicitly here:

          1. Host is up, workers are still mmap'ing weights
             (`splitRole === "pipeline_host"`). Worth surfacing the
             worker count + pooled memory so the operator knows what
             they're waiting on.

          2. No host has been elected at all — every peer in the cohort
             is Worker / loading (`splitRole === "pipeline_worker"`).
             This is the May 13 split-brain mode: nothing is going to
             come up without operator intervention. Don't pretend a
             host exists; describe the deadlock honestly. */}
      {undialableFromEntry && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200">
          <span className="font-medium text-amber-300">Not reachable for chat.</span>{" "}
          This peer advertises a loaded model, but the entry node has no dial
          path to it (RTT unknown). Requests routed here will fail until
          connectivity is restored.
        </div>
      )}

      {node.pipelineDegraded && node.splitGroup && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200">
          {node.splitRole === "pipeline_host" ? (
            <>
              <span className="font-medium text-amber-300">
                Awaiting {Math.max(0, node.splitGroup.peerIds.length - 1)}{" "}
                {node.splitGroup.peerIds.length - 1 === 1 ? "worker" : "workers"}
              </span>{" "}
              to finish loading their layer ranges. This node is the
              elected host, but the cohort can't serve until every worker
              has its layer range resident in memory.
            </>
          ) : (
            <>
              <span className="font-medium text-amber-300">
                Pipeline host not elected.
              </span>{" "}
              {node.splitGroup.peerIds.length} machines are committed to{" "}
              {node.splitGroup.model}, but none has finished claiming the
              host role yet — so there's no peer for traffic to route
              through. Usually the largest peer is still loading weights
              and will advertise itself as host once the model is
              resident. If this stays stuck for several minutes one
              contributor is likely blocking the cohort; restart the
              affected runtime to break the deadlock. (v0.66.21+
              auto-recovers from stuck hosts after a 30-second grace
              window.)
            </>
          )}
        </div>
      )}

      {/* Models. While a node is in `loading`, its `servingModels` lists
          what it's *trying* to load, not what's actually loaded — so we
          render those as muted "loading: X" rather than as ready model
          badges. Without this distinction the card would say "Qwen3-0.6B"
          in the same green pill as a fully serving node, which was the
          original "the page is lying" complaint. */}
      {node.servingModels.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {node.servingModels.map((m) => {
            const name = prettyModelName(m);
            const loading = node.state === "loading";
            return (
              <span
                key={m}
                className={`inline-flex max-w-full items-center truncate whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                  loading
                    ? "border-amber-400/30 bg-amber-400/5 text-amber-300"
                    : "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                }`}
                title={
                  loading
                    ? `${name} — loading into VRAM, not serveable yet`
                    : name
                }
              >
                {loading ? `loading ${name}` : name}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="text-[12px] text-[var(--fg-muted)]">
          {isEntryNode ? "Routes inference to worker nodes" : "No models loaded"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

/**
 * Compact, intentionally un-celebratory row for peers that are connected
 * but have never actually served anything in this session. We render
 * these in a separate "Peers having issues" section instead of giving
 * them a full participating-peer card — a stuck-loading peer is not a
 * "Connected node" in any user-meaningful sense, and showing it with the
 * same hardware-row + model-pill layout as a healthy serving peer reads
 * as misleading bragging.
 */
function IssueNodeRow({
  node,
  history,
  latestVersion,
}: {
  node: MeshNode & { _vanished?: boolean };
  history?: NodeHistory;
  /** Highest runtime version observed in the mesh; used to flag this
   *  peer as outdated if it's running an older build. */
  latestVersion: string | null;
}) {
  const hostname = prettyHostname(node.hostname);
  const loadingFor =
    node.state === "loading" && history?.loadingSince
      ? Date.now() - history.loadingSince
      : 0;
  const reason = (() => {
    if (node._vanished) return "no longer responding";
    if (node.state === "loading") {
      if (loadingFor > 60_000) return `stuck loading for ${formatDuration(loadingFor)}+`;
      if (loadingFor > 20_000) return `stuck loading ${formatDuration(loadingFor)}`;
      if (loadingFor > 0) return `loading ${formatDuration(loadingFor)}`;
      return "loading";
    }
    if (node.state === "unreachable") {
      // Slice 4: a peer that's only in our list because it phoned home
      // its audit (`meshVisibility` non-null) is in a more specific
      // failure mode than a peer that the entry simply stopped
      // hearing from — it's actively reporting in but the entry
      // can't see it. Label accordingly so operators don't conflate
      // the two while debugging.
      if (node.meshVisibility) {
        if (node.meshVisibility.state === "invisible") {
          return node.meshVisibility.softReconnectTriggered
            ? "reporting in but invisible to entry · auto-reconnecting"
            : "reporting in but invisible to entry";
        }
        if (node.meshVisibility.state === "entry_unreachable") {
          return `can't reach entry from this peer · ${node.meshVisibility.consecutiveInvisibleCount} miss(es)`;
        }
      }
      return "unreachable from entry node";
    }
    if (node.state === "offline") return "offline";
    return node.state;
  })();
  const isOutdated =
    !!node.version &&
    !!latestVersion &&
    compareVersions(node.version, latestVersion) < 0;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)]/40 px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--fg-muted)]/60" />
        <span className="truncate font-medium text-[var(--fg)]/85">{hostname}</span>
        <span className="truncate text-[var(--fg-muted)]">· {reason}</span>
      </div>
      {/* Version is the single most useful debug field for "why is my
          peer stuck". Old runtimes are a frequent cause of stuck-loading
          and host-election bugs (the v0.65.9 release fixes one such bug),
          so calling out outdated peers explicitly turns "the mesh is
          mysteriously broken" into "go update that machine". */}
      {node.version && (
        <span
          className={`flex-shrink-0 font-mono text-[11px] tabular-nums ${
            isOutdated ? "text-amber-400" : "text-[var(--fg-muted)]"
          }`}
          title={
            isOutdated
              ? `Running v${node.version} — latest in this mesh is v${latestVersion}. The desktop app auto-upgrades the runtime within ~6 hours of launch, so this should self-heal soon.`
              : `Runtime v${node.version}`
          }
        >
          v{node.version}
          {isOutdated ? " · outdated" : ""}
        </span>
      )}
    </div>
  );
}

/**
 * Card for a peer that has committed to a model and is currently
 * bringing it up. Replaces the previous "Be the first to share" empty
 * state + collapsed accordion combo, which left the public page
 * reporting "0 machines / 0 models" while a contributor was actively
 * loading — sometimes a model that the host couldn't fit on its own
 * and would never finish bringing online.
 *
 * Two variants driven by `verdict.kind`:
 *
 *   - `underprovisioned`: amber treatment with an "Awaiting capacity"
 *     label and a plain-language explanation of the pooled-memory
 *     shortfall, plus a "Share your machine →" CTA. We deliberately
 *     keep the copy neutral and product-y here — this surface is
 *     public, so no jargon ("mmap", "GGUF", "thrash") and no
 *     defeatist phrasing ("won't load", "will time out"); the user
 *     just needs to know that the mesh is waiting on more memory.
 *
 *   - `pooling`: multiple peers are warming the same model, but the
 *     splitGroup snapshot is not stable yet. Show recovery/loading copy
 *     instead of per-machine solo-capacity math.
 *
 *   - `fits` / `unknown`: muted "Loading X — usually takes 30 s to
 *     2 min" line. Legitimate transient case where the model does fit
 *     and just hasn't finished bringing up yet.
 */
function WarmingUpCard({
  node,
  verdict,
  history,
}: {
  node: MeshNode & { _vanished?: boolean };
  verdict: WarmingVerdict;
  history?: NodeHistory;
}) {
  const hostname = prettyHostname(node.hostname);
  const loadingFor =
    node.state === "loading" && history?.loadingSince
      ? Date.now() - history.loadingSince
      : 0;
  const awaiting = verdict.kind === "underprovisioned";
  // What this machine actually contributes to the pool — the smaller of
  // the two reported numbers, mirroring the verdict math. Surfacing this
  // per-card is what turns "5 machines, no idea why it isn't loading"
  // into "5 machines, here are their budgets, here is the gap".
  const nodeVramGb = Math.min(
    node.vramGb || Number.POSITIVE_INFINITY,
    node.capability?.vramGb || Number.POSITIVE_INFINITY,
  );
  const nodeVramLabel = Number.isFinite(nodeVramGb) && nodeVramGb > 0
    ? `${nodeVramGb.toFixed(nodeVramGb >= 10 ? 0 : 1)} GB`
    : null;
  const pooledShort =
    verdict.kind === "pooling" && verdict.pooledGb < verdict.neededGb;
  const pooledOk =
    verdict.kind === "pooling" && verdict.pooledGb >= verdict.neededGb;
  // Pool large enough but nobody has actually committed to hosting:
  // the election-stall signal that explains "5 machines loading forever".
  const hostStalled =
    verdict.kind === "pooling" &&
    pooledOk &&
    verdict.hostingCount === 0 &&
    verdict.peerCount >= 2;
  return (
    <div
      className={
        "rounded-xl border p-5 " +
        (awaiting
          ? "border-amber-400/40 bg-amber-400/5"
          : "border-[var(--border)] bg-[var(--bg-elev)]")
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={
              "mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full " +
              (awaiting ? "bg-amber-400" : "bg-amber-300")
            }
          />
          <div className="min-w-0">
            <div
              className={
                "text-[10px] uppercase tracking-[0.18em] " +
                (awaiting ? "text-amber-300" : "text-[var(--fg-muted)]")
              }
            >
              {awaiting ? "Awaiting capacity" : "Loading"}
            </div>
            <div className="mt-0.5 text-sm font-semibold tracking-tight text-[var(--fg)]">
              {hostname}
              {nodeVramLabel && (
                <span className="ml-2 text-[11px] font-normal text-[var(--fg-muted)]">
                  · {nodeVramLabel} usable
                </span>
              )}
            </div>
            <div className="mt-1 font-mono text-[12px] text-[var(--fg)]/85">
              {verdict.displayName}
              {loadingFor > 0 && !awaiting && (
                <span className="ml-2 text-[11px] text-[var(--fg-muted)]">
                  · {formatDuration(loadingFor)}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[12px] text-[var(--fg-muted)]">
              {verdict.kind === "underprovisioned" ? (
                <>
                  Needs about{" "}
                  <span className="font-semibold text-[var(--fg)]">
                    {verdict.catalog.minVramGb} GB
                  </span>{" "}
                  of pooled memory to serve. This machine offers{" "}
                  <span className="font-semibold text-[var(--fg)]">
                    {verdict.hostVramGb.toFixed(0)} GB
                  </span>{" "}
                  on its own — additional contributors are needed to pool the
                  remaining{" "}
                  <span className="font-semibold text-[var(--fg)]">
                    ~{Math.ceil(verdict.shortfallGb)} GB
                  </span>{" "}
                  before the model can come online.
                </>
              ) : verdict.kind === "pooling" ? (
                <>
                  {verdict.peerCount} machines advertising this model, pooling{" "}
                  <span
                    className={
                      "font-semibold " +
                      (pooledShort ? "text-amber-300" : "text-[var(--fg)]")
                    }
                  >
                    {verdict.pooledGb.toFixed(0)} GB
                  </span>{" "}
                  against a{" "}
                  <span className="font-semibold text-[var(--fg)]">
                    {verdict.neededGb} GB
                  </span>{" "}
                  requirement.{" "}
                  {pooledShort ? (
                    <>
                      Short by{" "}
                      <span className="font-semibold text-amber-300">
                        ~{Math.ceil(verdict.neededGb - verdict.pooledGb)} GB
                      </span>
                      {" "}— the model won&apos;t finish loading until more
                      capacity joins the mesh.
                    </>
                  ) : verdict.outdatedBlockers.length > 0 ? (
                    <>
                      <span className="font-semibold text-amber-300">
                        {verdict.outdatedBlockers.length === 1
                          ? `${verdict.outdatedBlockers[0]!.hostname} (v${verdict.outdatedBlockers[0]!.version ?? "?"})`
                          : `${verdict.outdatedBlockers.length} outdated peers`}
                      </span>{" "}
                      {verdict.outdatedBlockers.length === 1 ? "is" : "are"}{" "}
                      on a runtime below v
                      {MIN_PIPELINE_ELECTION_PEER_VERSION} and are excluded
                      from pipeline election. The other{" "}
                      {verdict.peerCount} machine
                      {verdict.peerCount === 1 ? "" : "s"} can elect a host
                      without {verdict.outdatedBlockers.length === 1 ? "them" : "those peers"}
                      once everyone on current runtimes restarts or auto-upgrades.
                    </>
                  ) : hostStalled ? (
                    <>
                      Capacity fits, but{" "}
                      <span className="font-semibold text-amber-300">
                        no peer has been elected as host
                      </span>
                      . Every machine is waiting on another to lead the
                      serve — usually a transient state during peer
                      re-link, but if it persists for more than a minute
                      the mesh is stuck in an election loop and the model
                      can&apos;t come online.
                    </>
                  ) : pooledOk ? (
                    <>Capacity is sufficient; waiting for host election and
                      worker links to settle.</>
                  ) : (
                    <>Waiting for host election and peer links to settle.</>
                  )}
                </>
              ) : verdict.kind === "fits" ? (
                <>
                  Loading model into memory. This usually takes 30 s to 2 min
                  for models in this size range.
                </>
              ) : (
                <>Loading model into memory. This usually takes 30 s to 2 min.</>
              )}
            </div>
          </div>
        </div>
        {awaiting && (
          <a
            href="/download"
            className="shrink-0 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-400/20"
          >
            Share your machine →
          </a>
        )}
      </div>
    </div>
  );
}

function SummaryBar({
  status,
  workingPeerCount,
  pooledGb,
  loadingPeerCount,
}: {
  status: MeshStatus;
  /**
   * Non-entry peers that are either currently useful or have been at some
   * point this session — i.e. NOT counted as "having issues". Used as
   * the "machines" headline number so the summary matches the cards
   * shown below: machines == cards in the "Connected nodes" section.
   */
  workingPeerCount: number;
  /** Total usable memory across all non-entry peers right now. */
  pooledGb: number;
  /** Non-entry peers currently in `loading`. */
  loadingPeerCount: number;
}) {
  // "Sharing" = a non-entry node genuinely contributing capacity *right
  // now*. Excludes nodes stuck in `loading` (they self-report a model in
  // `serving_models` while still bringing it up — that's how the page
  // used to claim "1 node sharing GPU" while inference 503'd) and excludes
  // pure clients that aren't serving anything.
  //
  // EXCEPT: `splitRole === "pipeline_worker"` peers ARE sharing GPU
  // (they're running rpc-server holding model layers for the host),
  // they just have `state="loading"` because no local llama-server is
  // accepting requests. Counting them as not-sharing was the same lie
  // that hid 3 of 4 contributors from the headline number on May 18 2026.
  const sharingNodes = status.nodes.filter(
    (n) =>
      !n.hostname?.startsWith("ip-") &&
      n.state !== "unreachable" &&
      n.state !== "offline" &&
      (n.splitRole === "pipeline_worker" ||
        (n.state !== "loading" &&
          ((n.capability?.loadedModels?.length ?? 0) > 0 ||
            n.servingModels.length > 0 ||
            n.state === "serving" ||
            n.state === "standby"))),
  ).length;
  const models = status.models;
  // Cards shown in "Available machines": everyone we recognise, plus
  // the peers stuck loading whose own card we surface above the empty
  // state. Without including the latter, the page shows "5 machines"
  // in the cards but "0 machines" in the summary — the exact mismatch
  // that prompted this change.
  const totalNodes = Math.max(workingPeerCount, loadingPeerCount);
  const pooledLabel = pooledGb > 0
    ? `${pooledGb >= 100 ? Math.round(pooledGb) : pooledGb.toFixed(0)} GB`
    : "—";

  return (
    <div className="grid grid-cols-4 divide-x divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]">
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-[var(--fg)]">
          {totalNodes}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {totalNodes === 1 ? "machine" : "machines"}
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-[var(--fg)]">
          {pooledLabel}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">pooled memory</div>
      </div>
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-[var(--fg)]">
          {models.length}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {models.length === 1 ? "model available" : "models available"}
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-emerald-400">
          {sharingNodes}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {sharingNodes === 1 ? "node sharing GPU" : "nodes sharing GPU"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Track per-node history across polls. Used for honest UX signals only —
 * we explicitly do NOT smooth `state` (we used to, and it caused the page
 * to display "Ready · serving Qwen3" for nodes that had been stuck
 * `state="loading"` for minutes, while every chat request 503'd).
 *
 * Fields:
 *   - `firstSeen`: when this node id first appeared in our polls; used to
 *     render the "online for Xm" badge.
 *   - `lastSeen`: most recent poll the node id appeared in; used (in
 *     future) to grey out cards for nodes that have just dropped off.
 *   - `loadingSince`: when state first transitioned to "loading" without
 *     subsequently leaving it. Surfaced as "Loading 30s" on the card so
 *     the user can see whether a node is genuinely loading or stuck.
 *   - `everUseful`: true once we've observed this node in a state that
 *     could actually serve a request (state=serving, OR has loaded models
 *     and isn't loading). Used to demote peers that have *never* served
 *     anything in this session into a separate "having issues" section,
 *     instead of giving them a full participating-peer card. A node that
 *     joined 90 seconds ago and has been stuck loading the entire time
 *     is functionally broken; treating it the same as a healthy serving
 *     peer in the UI was the user-visible lie.
 */
type NodeHistory = {
  firstSeen: number;
  lastSeen: number;
  loadingSince: number | null;
  everUseful: boolean;
};

/**
 * Supply health banner.
 *
 * Says plainly when the mesh can't serve the model the site advertises as its
 * default, and for how long. The honest framing matters here: a visitor reading
 * `/status` should learn this from us rather than by sending a prompt and
 * getting nothing, and W33 (three weeks of quiet decline) is exactly the case
 * where a page full of green cards would have been misleading.
 */
function SupplyHealthBanner({ health }: { health: MeshHealth }) {
  if (health.level === "ok") return null;

  const down = health.level === "down";
  const tone = down
    ? {
        border: "border-red-500/25",
        bg: "bg-red-500/5",
        fg: "text-red-400",
        label: "Mesh unable to serve",
      }
    : {
        border: "border-amber-500/25",
        bg: "bg-amber-500/5",
        fg: "text-amber-400",
        label: "Reduced capacity",
      };

  const duration =
    health.degraded_hours >= 48
      ? `${Math.floor(health.degraded_hours / 24)} days`
      : health.degraded_hours >= 1
        ? `${health.degraded_hours} hour${health.degraded_hours === 1 ? "" : "s"}`
        : null;

  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} p-4`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`text-sm font-medium ${tone.fg}`}>{tone.label}</span>
        {duration && (
          <span className="text-[12px] text-[var(--fg-muted)]">
            for the past {duration}
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-1 text-[12px] text-[var(--fg-muted)]">
        {health.reasons.map((reason) => (
          <li key={reason}>{MESH_HEALTH_REASON_COPY[reason]}</li>
        ))}
      </ul>
      {health.routable_models.length > 0 && (
        <div className="mt-2 text-[12px] text-[var(--fg-muted)]">
          Routable right now:{" "}
          <span className="text-[var(--fg)]">
            {health.routable_models.join(", ")}
          </span>
          .
        </div>
      )}
      <div className="mt-2 text-[12px] text-[var(--fg-muted)]">
        Capacity comes from volunteered hardware, so it moves with who is
        online.{" "}
        <Link href="/contribute" className="underline hover:text-[var(--fg)]">
          Run a peer →
        </Link>
      </div>
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);
  const [health, setHealth] = useState<MeshHealth | null>(null);
  const historyRef = useRef<Map<string, NodeHistory>>(new Map());
  // Most recent snapshot we saw for each node id. Lets us keep rendering
  // a node for ~30s after it vanishes from the entry node's view, so a
  // flapping peer doesn't cause cards/counts to flicker in and out.
  const lastSnapshotByIdRef = useRef<Map<string, MeshNode>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MeshStatus;
        if (cancelled) return;

        // Record per-node history for honest UX badges (online-for, stuck
        // loading detection, "have we ever seen this node actually work?")
        // and snapshot the current state so we can keep rendering
        // briefly-vanished peers across polling gaps.
        const now = Date.now();
        const history = historyRef.current;
        const lastSnapshot = lastSnapshotByIdRef.current;
        for (const node of data.nodes) {
          const prior = history.get(node.id) ?? {
            firstSeen: now,
            lastSeen: now,
            loadingSince: null,
            everUseful: false,
          };
          const loadingSince =
            node.state === "loading"
              ? (prior.loadingSince ?? now)
              : null;
          // "Useful" = could actually serve a request right now. Loading
          // peers don't qualify even if they advertise serving_models —
          // that field lists what they're trying to load, not what's
          // actually loaded.
          const isUsefulNow =
            node.state === "serving" ||
            (node.state !== "loading" &&
              ((node.capability?.loadedModels?.length ?? 0) > 0 ||
                node.servingModels.length > 0));
          history.set(node.id, {
            firstSeen: prior.firstSeen,
            lastSeen: now,
            loadingSince,
            everUseful: prior.everUseful || isUsefulNow,
          });
          lastSnapshot.set(node.id, node);
        }

        // Drop snapshots for peers we haven't seen in over 60s. The
        // render-time grace window is 30s but we keep the snapshot
        // around a bit longer so a peer that briefly comes back inside
        // the window doesn't get a fresh history. After this we treat
        // them as truly gone.
        for (const [id, h] of history.entries()) {
          if (now - h.lastSeen > 60_000) {
            history.delete(id);
            lastSnapshot.delete(id);
          }
        }

        setStatus(data);
        setLastUpdated(new Date());
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) {
          // Poll faster (5s) so we catch the steady-state more often than
          // we catch transient "Loading" states during host re-elections.
          timer = window.setTimeout(tick, 5_000);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Supply health is written by the hourly KPI cron, so it needs nowhere near
  // the 5s cadence of the live status poll. Kept as its own fetch rather than
  // folded into /api/status: that endpoint is hit on every poll by every
  // viewer, and this doesn't need to ride along.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tickHealth() {
      try {
        const res = await fetch("/api/kpi-snapshot?health=1", {
          cache: "no-store",
        });
        // 503 just means no capture has run yet — not an error worth showing.
        if (res.ok) {
          const data = (await res.json()) as { health?: MeshHealth };
          if (!cancelled && data.health) setHealth(data.health);
        }
      } catch {
        /* health is advisory; a failed read shouldn't disturb the page */
      } finally {
        if (!cancelled) timer = window.setTimeout(tickHealth, 300_000);
      }
    }

    tickHealth();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Categorize nodes for rendering. Two design goals:
  //
  //   1. The main "Connected nodes" list should only show machines that are
  //      actually useful — nothing that's just sitting in `loading`. Showing
  //      a never-served peer alongside a healthy one was the original lie.
  //
  //   2. Disappearance/reappearance of unstable peers must NOT cause
  //      visible flicker. We keep nodes in the "render set" for ~30s after
  //      we last saw them in a poll, so a peer that flaps in and out of
  //      the entry node's view every few seconds doesn't yank cards around.
  //
  // Categories:
  //   - "working": peer is currently useful, OR has been useful at some
  //     point in this session, OR is the entry node. Rendered as a card.
  //   - "unavailable": peer we know about but isn't currently useful and
  //     never has been (stuck loading, unreachable, offline, or recently
  //     vanished entirely). Rendered in a collapsed <details> at the
  //     bottom — present in the DOM for transparency, not in the user's
  //     face. Count is debounced via lastSeen so it doesn't flap.
  const now = Date.now();
  const VANISH_GRACE_MS = 30_000;
  const sortNodes = (a: MeshNode, b: MeshNode) => {
    const aEntry = a.hostname?.startsWith("ip-") ? 1 : 0;
    const bEntry = b.hostname?.startsWith("ip-") ? 1 : 0;
    if (aEntry !== bEntry) return aEntry - bEntry;
    const aServing = a.state === "serving" ? 0 : 1;
    const bServing = b.state === "serving" ? 0 : 1;
    return aServing - bServing;
  };

  // Build a render set that includes (a) every node in the current
  // snapshot, plus (b) any node we saw recently but is missing from THIS
  // snapshot. The (b) part is what makes flapping peers stop flickering:
  // if a peer disappears for one poll, we still render its last-known
  // state for up to 30s before actually dropping it. (Mutation of the
  // ref happens in the polling callback, not during render.)
  type RenderNode = MeshNode & { _vanished: boolean };
  const currentNodes = status?.nodes ?? [];
  const currentIds = new Set(currentNodes.map((n) => n.id));
  const lastSnapshotRef = lastSnapshotByIdRef.current;

  const renderNodes: RenderNode[] = [];
  for (const n of currentNodes) {
    renderNodes.push({ ...n, _vanished: false });
  }
  for (const [id, snap] of lastSnapshotRef.entries()) {
    if (currentIds.has(id)) continue;
    const h = historyRef.current.get(id);
    if (!h) continue;
    const goneFor = now - h.lastSeen;
    if (goneFor < VANISH_GRACE_MS) {
      renderNodes.push({ ...snap, _vanished: true });
    }
    // Past the grace window: ignore here. Cleanup of the ref happens
    // inside the poll callback when we re-process the next snapshot.
  }

  const isUnavailable = (n: RenderNode): boolean => {
    if (n.hostname?.startsWith("ip-")) return false;
    const h = historyRef.current.get(n.id);
    // A peer that has actually served in this session stays in the
    // "Available machines" list even during a transient vanish — the
    // 30s render grace handles that without yanking the card. We only
    // demote it once the grace expires and we drop it from renderNodes
    // entirely.
    if (h?.everUseful) return false;
    // Pipeline workers in an active split are contributing compute via
    // rpc-server, not "loading" — they belong in the Available list
    // alongside the host. See `nodeDisplayState` for why we treat the
    // runtime's `state="loading"` as misleading in this specific case.
    // Without this, a 4-peer Qwen3-32B split renders as "1 available,
    // 3 unavailable" on the public dashboard, which scares off
    // contributors who don't see their own machine in the list.
    if (n.splitRole === "pipeline_worker") return false;
    return (
      n._vanished ||
      n.state === "loading" ||
      n.state === "unreachable" ||
      n.state === "offline"
    );
  };
  const unavailableNodes = renderNodes.filter(isUnavailable).sort(sortNodes);
  const workingNodes = renderNodes
    .filter((n) => !isUnavailable(n))
    .sort(sortNodes);

  // Peers in the loading state that are actively trying to bring a
  // model up. We surface these as full-width cards (with a fit verdict)
  // above the empty state, so the public page actually reports
  // "MacBook-Air-de-al-2 is warming up Mixtral 8x7B — won't actually
  // load on its own, needs 24 GB more memory" instead of the previous
  // "Be the first to share" lie + collapsed accordion.
  const warmingPeerCountsByModel = new Map<string, number>();
  const pooledGbByModel = new Map<string, number>();
  const outdatedBlockersByModel = new Map<
    string,
    { hostname: string; version: string | null }[]
  >();
  // Per-model: how many peers across the whole mesh — warming AND
  // working — have hosted_models actually pointing at this model.
  // Zero means election is stuck; this is the deadlock signal that
  // hides behind "5 machines loading forever".
  const hostingCountByModel = new Map<string, number>();
  for (const n of renderNodes) {
    for (const m of n.capability?.loadedModels ?? []) {
      if (n.state === "serving" || (n.capability?.loadedModels?.length ?? 0) > 0) {
        hostingCountByModel.set(m, (hostingCountByModel.get(m) ?? 0) + 1);
      }
    }
  }
  for (const n of unavailableNodes) {
    if (n.state !== "loading") continue;
    const modelId = n.servingModels[0];
    if (!modelId) continue;
    if (!peerSupportsPipelineElection(n.version)) {
      const blockers = outdatedBlockersByModel.get(modelId) ?? [];
      blockers.push({
        hostname: prettyHostname(n.hostname),
        version: n.version,
      });
      outdatedBlockersByModel.set(modelId, blockers);
      continue;
    }
    warmingPeerCountsByModel.set(
      modelId,
      (warmingPeerCountsByModel.get(modelId) ?? 0) + 1,
    );
    // Use the smaller of vramGb / capability.vramGb so the pooled figure
    // reflects what each peer can actually contribute, not whichever of
    // the two reported numbers is larger.
    const nodeVramGb = Math.min(
      n.vramGb || Number.POSITIVE_INFINITY,
      n.capability?.vramGb || Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nodeVramGb) && nodeVramGb > 0) {
      pooledGbByModel.set(
        modelId,
        (pooledGbByModel.get(modelId) ?? 0) + nodeVramGb,
      );
    }
  }
  const warmingUpNodes = unavailableNodes
    .filter((n) => peerSupportsPipelineElection(n.version))
    .map((n) => ({
      node: n,
      verdict: warmingUpVerdict(
        n,
        warmingPeerCountsByModel.get(n.servingModels[0] ?? "") ?? 1,
        pooledGbByModel.get(n.servingModels[0] ?? "") ?? 0,
        hostingCountByModel.get(n.servingModels[0] ?? "") ?? 0,
        outdatedBlockersByModel.get(n.servingModels[0] ?? "") ?? [],
      ),
    }))
    .filter((x): x is { node: typeof x.node; verdict: WarmingVerdict } =>
      x.verdict !== null,
    );
  // Anything in `unavailableNodes` that ISN'T a warming-up peer (e.g.
  // unreachable, vanished, recently offline) still goes into the
  // collapsed details section below — those don't have anything
  // interesting to say to a public visitor and we don't want to fill
  // the page with broken-peer noise.
  const trulyUnavailableNodes = unavailableNodes.filter(
    (n) => !warmingUpNodes.some((w) => w.node.id === n.id),
  );
  // Highest version observed across BOTH lists. Used to flag outdated
  // peers in any section. Computed once per render so all rows agree
  // on what "latest" means.
  const latestVersion = maxVersion(renderNodes);

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader status={<MeshLiveStatus variant="header" />} />

      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        {/* Page heading */}
        <div className="mb-8">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] mb-2">
            Live mesh status
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            What&apos;s running right now
          </h1>
          <p className="mt-2 text-[14px] text-[var(--fg-muted)]">
            Machines connected to the Senda network and the models they&apos;re currently serving.{" "}
            <Link href="/metrics" className="text-[var(--accent)] hover:underline">
              Weekly metrics →
            </Link>
            {" · "}
            <Link href="/updates" className="text-[var(--accent)] hover:underline">
              Dev log →
            </Link>
            {lastUpdated && (
              <span className="ml-1">
                Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.
              </span>
            )}
          </p>
        </div>

        {/* Loading state */}
        {!status && !error && (
          <div className="space-y-4">
            <div className="h-24 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
            <div className="h-28 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
            <div className="h-28 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
            <div className="text-sm font-medium text-red-400">Mesh unreachable</div>
            <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
              Could not reach the entry node. Retrying automatically.
            </div>
          </div>
        )}

        {/* Supply health — above the cards, so a degraded mesh isn't buried
            under a page of otherwise-green detail. */}
        {health && (
          <div className="mb-6">
            <SupplyHealthBanner health={health} />
          </div>
        )}

        {/* Content */}
        {status && (
          <div className="space-y-6">
            <SummaryBar
              status={status}
              workingPeerCount={
                workingNodes.filter(
                  (n) => !n.hostname?.startsWith("ip-"),
                ).length
              }
              loadingPeerCount={
                renderNodes.filter(
                  (n) =>
                    !n.hostname?.startsWith("ip-") &&
                    n.state === "loading",
                ).length
              }
              pooledGb={renderNodes
                .filter((n) => !n.hostname?.startsWith("ip-"))
                .reduce((acc, n) => {
                  const v = Math.min(
                    n.vramGb || Number.POSITIVE_INFINITY,
                    n.capability?.vramGb || Number.POSITIVE_INFINITY,
                  );
                  return acc + (Number.isFinite(v) && v > 0 ? v : 0);
                }, 0)}
            />

            {/* Catalog view: one row per model, with measured throughput,
                first-token latency, and contributor count. This replaces
                the flat chip list because a chip just answers "is this
                model loaded somewhere?" — for the marketplace narrative
                we also need "how fast", "how responsive", "who's serving
                it". Median t/s and lowest TTFT come from per-peer
                rolling-1h samples gossiped via PeerAnnouncement
                (runtime v0.66.42+). Older peers don't gossip these and
                the row renders a "no measurements yet" line instead of
                fabricating zeros. */}
            {status.models.length > 0 && (
              <CatalogSection
                models={status.models}
                nodes={status.nodes}
              />
            )}

            {/* Working nodes — peers that are currently useful or have
                been useful at some point in this session, plus the entry
                node. */}
            <div>
              <div className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                Available machines
              </div>
              {workingNodes.some((n) => !n.hostname?.startsWith("ip-")) ? (
                <div className="space-y-3">
                  {workingNodes.map((node) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      history={historyRef.current.get(node.id)}
                      latestVersion={latestVersion}
                    />
                  ))}
                </div>
              ) : warmingUpNodes.length > 0 ? (
                // At least one peer is actively trying to bring a model
                // up. Show what they're loading and whether it'll fit
                // instead of the misleading "Be the first to share"
                // empty state — the user IS sharing, the question is
                // whether the model is actually going to load. See
                // WarmingUpCard for the underprovisioned vs fits split.
                <div className="space-y-3">
                  {warmingUpNodes.map(({ node, verdict }) => (
                    <WarmingUpCard
                      key={node.id}
                      node={node}
                      verdict={verdict}
                      history={historyRef.current.get(node.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-6 text-center">
                  <div className="text-sm font-medium text-[var(--fg)]">
                    No machines are sharing right now
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
                    The mesh is up but no peer has finished loading a model.
                    {" "}
                    <a
                      href="/download"
                      className="text-[var(--accent)] hover:underline"
                    >
                      Be the first to share →
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* Truly-broken peers — unreachable, vanished, recently
                offline. Warming-up peers no longer land here; they got
                promoted to the main "Available machines" section above
                where they belong. This stays collapsed because there's
                genuinely nothing actionable for a public visitor to do
                about a stranger's offline node. */}
            {trulyUnavailableNodes.length > 0 && (
              <details className="group rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]/40 px-4 py-3 text-[12px]">
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-[var(--fg-muted)] [&::-webkit-details-marker]:hidden">
                  <span>
                    {trulyUnavailableNodes.length} machine
                    {trulyUnavailableNodes.length === 1 ? "" : "s"} connected
                    but offline or unreachable
                  </span>
                  <span className="text-[var(--fg-muted)] transition-transform group-open:rotate-90">
                    ›
                  </span>
                </summary>
                <div className="mt-3 space-y-2">
                  {trulyUnavailableNodes.map((node) => (
                    <IssueNodeRow
                      key={node.id}
                      node={node}
                      history={historyRef.current.get(node.id)}
                      latestVersion={latestVersion}
                    />
                  ))}
                </div>
              </details>
            )}

            {/* Footer note */}
            <p className="text-center text-[11px] text-[var(--fg-muted)]">
              Refreshes every 5 seconds &middot;{" "}
              <a href="/download" className="text-[var(--accent)] hover:underline">
                Add your machine to the mesh
              </a>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
