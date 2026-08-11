/**
 * Mesh KPI snapshot — aggregates for weekly reports and historical trends.
 * Built from mesh entry `/api/status` (peers[]) or website `/api/status` (nodes[]).
 */

export type KpiSnapshot = {
  captured_at: string;
  status_url: string;
  flagship_model: string;
  online: boolean;
  node_count: number;
  backends: string[];
  pooled_vram_gb: number;
  models_available: number;
  /** Models routable on the entry `/v1/models` at capture time. */
  routable_models: string[];
  flagship: {
    contributors: number;
    tps_p50_median: number | null;
    ttft_ms_best: number | null;
    tps_sample_count: number;
    ttft_sample_count: number;
  };
};

export type KpiMilestone = {
  id: string;
  at: string;
  title: string;
  detail: string;
  model?: string;
  peer_count?: number;
  pooled_vram_gb?: number;
  host_hostname?: string;
  /** Manual or synthetic benchmark when gossip samples are missing. */
  measured_ttft_ms?: number;
  measured_tps?: number;
};

export type KpiStatusNode = {
  hostname?: string | null;
  role?: string | null;
  state?: string | null;
  servingModels: string[];
  vramGb?: number;
  capability?: {
    backend?: string;
    vramGb?: number;
    loadedModels?: string[];
  };
  measuredTpsP50ByModel?: Record<string, number>;
  measuredTtftMsP50ByModel?: Record<string, number>;
  /** Phase 3.0 native baselines — used only as a plausibility bound. */
  nativeTpsP50ByModel?: Record<string, number>;
  nativeTtftMsP50ByModel?: Record<string, number>;
};

export type KpiStatusInput = {
  online: boolean;
  nodeCount: number;
  models: string[];
  nodes: KpiStatusNode[];
};

/** Raw mesh entry `/api/status` peer (snake_case). */
export type MeshRuntimePeer = {
  id?: string;
  hostname?: string | null;
  role?: string | null;
  state?: string | null;
  vram_gb?: number;
  serving_models?: string[];
  hosted_models?: string[];
  requested_models?: string[];
  models?: string[];
  measured_tps_p50_by_model?: Record<string, number>;
  measured_ttft_ms_p50_by_model?: Record<string, number>;
  /**
   * Phase 3.0 (runtime >= v0.66.49) native baselines, measured straight against
   * the peer's own llama-server with no mesh in the path. Bounds the
   * `measured_*` (through-mesh) numbers above.
   */
  native_tps_p50_by_model?: Record<string, number>;
  native_ttft_ms_p50_by_model?: Record<string, number>;
  /** Phase 3.2 / 5.B — latest synthetic-probe verdicts (observe-mode). */
  verify_by_model?: Record<
    string,
    {
      verdict?: string;
      agreement?: number;
      compared_tokens?: number;
      mode?: string;
      reason?: string | null;
      checked_at_unix_secs?: number;
    }
  >;
  /** Phase 3.2 / 5.B — EWMA reputation grades for credit multiplier cache. */
  reputation_by_model?: Record<
    string,
    {
      grade?: string;
      score?: number;
      samples?: number;
      matches?: number;
      mismatches?: number;
      last_verdict?: string;
      updated_at_unix_secs?: number;
    }
  >;
  capability?: {
    backend?: string;
    vram_total_mb?: number;
    vram_gb?: number;
    loaded_models?: string[];
  };
};

export type MeshRuntimeStatus = {
  peers?: MeshRuntimePeer[];
  my_vram_gb?: number;
};

const ENTRY_HOST_PREFIX = "ip-";

function isEntryHostname(hostname: string | null | undefined): boolean {
  return (hostname ?? "").startsWith(ENTRY_HOST_PREFIX);
}

function uniqueStrings(values: (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function peerVramGb(peer: MeshRuntimePeer): number {
  if (typeof peer.vram_gb === "number" && peer.vram_gb > 0) return peer.vram_gb;
  const cap = peer.capability;
  if (typeof cap?.vram_gb === "number" && cap.vram_gb > 0) return cap.vram_gb;
  if (typeof cap?.vram_total_mb === "number" && cap.vram_total_mb > 0) {
    return cap.vram_total_mb / 1024;
  }
  return 0;
}

/** Map mesh entry status into the KPI aggregator input shape. */
export function meshRuntimeToKpiInput(body: MeshRuntimeStatus): KpiStatusInput {
  const nodes: KpiStatusNode[] = (body.peers ?? [])
    .filter((p) => !isEntryHostname(p.hostname))
    .map((peer) => {
      const loaded = peer.capability?.loaded_models ?? [];
      const servingModels = uniqueStrings([
        ...(peer.serving_models ?? []),
        ...(peer.hosted_models ?? []),
        ...(peer.requested_models ?? []),
        ...(peer.models ?? []),
        ...loaded,
      ]);
      const vramGb = peerVramGb(peer);
      return {
        hostname: peer.hostname ?? null,
        role: peer.role ?? null,
        state: peer.state ?? null,
        servingModels,
        vramGb,
        capability: {
          backend: peer.capability?.backend,
          vramGb,
          loadedModels: loaded,
        },
        measuredTpsP50ByModel: peer.measured_tps_p50_by_model,
        measuredTtftMsP50ByModel: peer.measured_ttft_ms_p50_by_model,
        nativeTpsP50ByModel: peer.native_tps_p50_by_model,
        nativeTtftMsP50ByModel: peer.native_ttft_ms_p50_by_model,
      };
    });

  return {
    online: nodes.length > 0,
    nodeCount: nodes.length,
    models: [],
    nodes,
  };
}

function servesModel(node: KpiStatusNode, model: string): boolean {
  const loaded = node.capability?.loadedModels ?? [];
  return node.servingModels.includes(model) || loaded.includes(model);
}

/**
 * Through-mesh numbers are physically bounded by the same peer's native
 * baseline: the mesh adds a tunnel + routing hop, so it can never decode
 * faster (or reach first token sooner) than the peer does talking straight to
 * its own llama-server. A `measured_*` value that beats `native_*` is a bad
 * sample, not a record — and because `mergeWeekSnapshots` keeps peaks, one bad
 * sample would otherwise latch for the whole week (W31 recorded 487 tok/s on
 * Qwen3-8B this way). Uses the peer's own native value as the bound rather than
 * a fixed ceiling, so it scales with model size and hardware. Peers that
 * gossip no native baseline (legacy <= v0.66.48, or no baseline run yet) have
 * no basis for rejection and pass through unchanged.
 */
function plausibleThroughMeshTps(
  node: KpiStatusNode,
  model: string,
): number | undefined {
  const measured = node.measuredTpsP50ByModel?.[model];
  if (typeof measured !== "number") return undefined;
  const native = node.nativeTpsP50ByModel?.[model];
  if (typeof native === "number" && native > 0 && measured > native) {
    return undefined;
  }
  return measured;
}

function plausibleThroughMeshTtftMs(
  node: KpiStatusNode,
  model: string,
): number | undefined {
  const measured = node.measuredTtftMsP50ByModel?.[model];
  if (typeof measured !== "number") return undefined;
  const native = node.nativeTtftMsP50ByModel?.[model];
  if (typeof native === "number" && native > 0 && measured < native) {
    return undefined;
  }
  return measured;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Higher = richer snapshot; used so empty offline captures don't erase peaks. */
export function snapshotQuality(snap: KpiSnapshot): number {
  return (
    snap.models_available * 10_000 +
    snap.node_count * 1_000 +
    snap.pooled_vram_gb * 10 +
    snap.flagship.contributors * 100 +
    (snap.flagship.tps_p50_median ?? 0) * 10 +
    snap.flagship.tps_sample_count * 5 +
    (snap.routable_models?.length ?? 0) * 500
  );
}

/** Normalize snapshots read from Redis (older captures may lack new fields). */
export function normalizeKpiSnapshot(snap: KpiSnapshot | null): KpiSnapshot | null {
  if (!snap) return null;
  return {
    ...snap,
    routable_models: snap.routable_models ?? [],
  };
}

/** Keep the best numbers from each capture — never regress week rollup on empty mesh. */
export function mergeWeekSnapshots(
  prev: KpiSnapshot | null,
  next: KpiSnapshot,
): KpiSnapshot {
  prev = normalizeKpiSnapshot(prev);
  if (!prev) return next;
  if (snapshotQuality(next) >= snapshotQuality(prev)) return next;

  const mergedTps =
    next.flagship.tps_p50_median != null && prev.flagship.tps_p50_median != null
      ? Math.max(next.flagship.tps_p50_median, prev.flagship.tps_p50_median)
      : (next.flagship.tps_p50_median ?? prev.flagship.tps_p50_median);

  const mergedTtft =
    next.flagship.ttft_ms_best != null && prev.flagship.ttft_ms_best != null
      ? Math.min(next.flagship.ttft_ms_best, prev.flagship.ttft_ms_best)
      : (next.flagship.ttft_ms_best ?? prev.flagship.ttft_ms_best);

  const routable = uniqueStrings([
    ...(prev.routable_models ?? []),
    ...(next.routable_models ?? []),
  ]);

  const nodeCount = Math.max(prev.node_count, next.node_count);

  return {
    ...next,
    captured_at: next.captured_at,
    // `online` must agree with the peak it is reported next to. Taking it from
    // `next` alone produced rollups reading `online: false` with
    // `node_count: 4` (W31, W32) — a peak week that claims the mesh was down.
    online: nodeCount > 0 ? prev.online || next.online : next.online,
    node_count: nodeCount,
    pooled_vram_gb: Math.max(prev.pooled_vram_gb, next.pooled_vram_gb),
    models_available: Math.max(prev.models_available, next.models_available),
    routable_models: routable,
    backends: uniqueStrings([...prev.backends, ...next.backends]).sort(),
    flagship: {
      contributors: Math.max(prev.flagship.contributors, next.flagship.contributors),
      tps_p50_median: mergedTps,
      ttft_ms_best: mergedTtft,
      tps_sample_count: Math.max(
        prev.flagship.tps_sample_count,
        next.flagship.tps_sample_count,
      ),
      ttft_sample_count: Math.max(
        prev.flagship.ttft_sample_count,
        next.flagship.ttft_sample_count,
      ),
    },
  };
}

/** Pick the headline model: explicit > env > routable > cohort majority > default. */
export function pickFlagshipModel(
  nodes: KpiStatusNode[],
  routableModels: string[],
  explicit?: string | null,
  envDefault?: string | null,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (envDefault?.trim()) return envDefault.trim();
  if (routableModels.length > 0) return routableModels[0]!;
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const m of n.servingModels) {
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  return "Qwen3-32B-Q4_K_M";
}

export function isoWeekLabel(d = new Date()): string {
  const utc = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function previousIsoWeekLabel(d = new Date()): string {
  const prior = new Date(d.getTime() - 7 * 86_400_000);
  return isoWeekLabel(prior);
}

export function hourKey(d = new Date()): string {
  return d.toISOString().slice(0, 13);
}

export function buildKpiSnapshot(
  status: KpiStatusInput,
  flagshipModel: string,
  statusUrl: string,
  capturedAt = new Date(),
  routableModels: string[] = status.models,
): KpiSnapshot {
  const contributors = status.nodes.filter(
    (n) => !isEntryHostname(n.hostname) && servesModel(n, flagshipModel),
  );

  const tpsVals = status.nodes
    .map((n) => plausibleThroughMeshTps(n, flagshipModel))
    .filter((v): v is number => typeof v === "number" && v > 0);

  const ttftVals = status.nodes
    .map((n) => plausibleThroughMeshTtftMs(n, flagshipModel))
    .filter((v): v is number => typeof v === "number" && v > 0);

  const backends = [
    ...new Set(
      status.nodes
        .map((n) => n.capability?.backend)
        .filter((b): b is string => !!b),
    ),
  ].sort();

  const pooledVramGb = status.nodes
    .filter((n) => !isEntryHostname(n.hostname))
    .reduce(
      (sum, n) => sum + (n.capability?.vramGb ?? n.vramGb ?? 0),
      0,
    );

  const modelsAvailable = Math.max(
    routableModels.length,
    status.models?.length ?? 0,
  );

  return {
    captured_at: capturedAt.toISOString(),
    status_url: statusUrl,
    flagship_model: flagshipModel,
    online: status.online,
    node_count: status.nodeCount,
    backends,
    pooled_vram_gb: Math.round(pooledVramGb * 10) / 10,
    models_available: modelsAvailable,
    routable_models: routableModels,
    flagship: {
      contributors: contributors.length,
      tps_p50_median: median(tpsVals),
      ttft_ms_best: ttftVals.length > 0 ? Math.min(...ttftVals) : null,
      tps_sample_count: tpsVals.length,
      ttft_sample_count: ttftVals.length,
    },
  };
}

/** Build a KPI snapshot from a recorded milestone (backfill when cron missed the window). */
export function snapshotFromMilestone(m: KpiMilestone): KpiSnapshot {
  const model = m.model ?? "DeepSeek-R1-Distill-70B-Q4_K_M";
  return {
    captured_at: m.at,
    status_url: "https://entry.senda.network/api/status",
    flagship_model: model,
    online: true,
    node_count: m.peer_count ?? 0,
    backends: ["cuda", "metal"],
    pooled_vram_gb: m.pooled_vram_gb ?? 0,
    models_available: 1,
    routable_models: [model],
    flagship: {
      contributors: m.peer_count ?? 0,
      tps_p50_median: null,
      ttft_ms_best: null,
      tps_sample_count: 0,
      ttft_sample_count: 0,
    },
  };
}

/** Idempotent backfill for milestones we know happened before KPI storage was fixed. */
export const KNOWN_MILESTONES: KpiMilestone[] = [
  {
    id: "deepseek-70b-first-heterogeneous-serve",
    at: "2026-05-23T23:49:00.000Z",
    title: "First DeepSeek R1 70B on the public mesh",
    detail:
      "Heterogeneous split pipeline elected LYU (RTX 4080 SUPER) as Host with four workers (Mac Metal + CUDA + vast.ai RTX 3060). /v1/models listed DeepSeek-R1-Distill-70B-Q4_K_M; end-to-end chat completed (latency unusable ~1 tok/s class).",
    model: "DeepSeek-R1-Distill-70B-Q4_K_M",
    peer_count: 5,
    pooled_vram_gb: 66,
    host_hostname: "LYU",
  },
  {
    id: "deepseek-70b-first-through-mesh-benchmark",
    at: "2026-05-24T07:38:00.000Z",
    title: "First measured DeepSeek 70B through-mesh latency",
    detail:
      "Streaming chat via mesh entry (5-peer split, LYU Host + vast.ai RTX 3060 worker): median TTFT ~9.7 s, decode ~1.0 tok/s (~41 s for 39 tokens). Confirms split-over-WAN is not chat-viable at this cohort size.",
    model: "DeepSeek-R1-Distill-70B-Q4_K_M",
    peer_count: 5,
    pooled_vram_gb: 66,
    host_hostname: "LYU",
    measured_ttft_ms: 9700,
    measured_tps: 1.0,
  },
];

/** Redis keys for KPI history. */
export const KPI_HOUR_PREFIX = "kpi:snapshot:";
export const KPI_WEEK_PREFIX = "kpi:week:";
export const KPI_LAST_GOOD_KEY = "kpi:last-good";
export const KPI_MILESTONES_KEY = "kpi:milestones";

export const KPI_HOUR_TTL_SEC = 90 * 24 * 60 * 60;
export const KPI_WEEK_TTL_SEC = 400 * 24 * 60 * 60;
export const KPI_LAST_GOOD_TTL_SEC = 400 * 24 * 60 * 60;
export const KPI_MILESTONES_TTL_SEC = 400 * 24 * 60 * 60;

export function kpiHourKey(at = new Date()): string {
  return `${KPI_HOUR_PREFIX}${hourKey(at)}`;
}

export function kpiWeekKey(at = new Date()): string {
  return `${KPI_WEEK_PREFIX}${isoWeekLabel(at)}`;
}

export function milestoneFromSnapshot(
  snap: KpiSnapshot,
  hostHostname?: string | null,
): KpiMilestone | null {
  if ((snap.routable_models?.length ?? 0) === 0 && snap.models_available === 0) {
    return null;
  }
  const model = snap.routable_models?.[0] ?? snap.flagship_model;
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    id: `first-serve-${slug}-${isoWeekLabel(new Date(snap.captured_at))}`,
    at: snap.captured_at,
    title: `Model live on mesh: ${model}`,
    detail: `${snap.node_count} peer(s), ${snap.pooled_vram_gb} GB pooled, ${snap.flagship.contributors} contributor(s) on ${model}.`,
    model,
    peer_count: snap.node_count,
    pooled_vram_gb: snap.pooled_vram_gb,
    host_hostname: hostHostname ?? undefined,
  };
}
