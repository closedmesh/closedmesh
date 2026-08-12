import { getRedis, kvConfigured } from "./redis";
import {
  type KpiMilestone,
  type KpiSnapshot,
  KNOWN_MILESTONES,
  KPI_LAST_GOOD_KEY,
  KPI_LAST_GOOD_TTL_SEC,
  KPI_MILESTONES_KEY,
  KPI_MILESTONES_TTL_SEC,
  KPI_HOUR_TTL_SEC,
  KPI_WEEK_TTL_SEC,
  KPI_WEEK_PREFIX,
  isoWeekLabel,
  kpiHourKey,
  kpiWeekKey,
  mergeWeekSnapshots,
  milestoneFromSnapshot,
  previousIsoWeekLabel,
  snapshotFromMilestone,
  snapshotQuality,
} from "./kpi-snapshot";
import { getMeshShareRolling, type MeshShareWindow } from "./mesh-share";
import {
  emptyMarginWindow,
  getMarginRolling,
  type MarginWindow,
} from "./margin-accounting";
import {
  evaluateMeshHealth,
  normalizeMeshHealth,
  MESH_HEALTH_KEY,
  MESH_HEALTH_TTL_SEC,
  type MeshHealth,
} from "./mesh-health";

export async function saveKpiSnapshot(
  snapshot: KpiSnapshot,
  at = new Date(),
  opts?: { hostHostname?: string | null },
): Promise<{
  hourKey: string;
  weekKey: string;
  backend: "redis" | "none";
  weekMerged: boolean;
  milestoneAdded: string | null;
  health: MeshHealth | null;
}> {
  const hourKey = kpiHourKey(at);
  const weekKey = kpiWeekKey(at);
  const redis = getRedis();
  if (!redis) {
    return {
      hourKey,
      weekKey,
      backend: "none",
      weekMerged: false,
      milestoneAdded: null,
      health: null,
    };
  }

  const existingWeek = await redis.get<KpiSnapshot>(weekKey);
  const mergedWeek = mergeWeekSnapshots(existingWeek, snapshot);

  const writes: Promise<unknown>[] = [
    redis.set(hourKey, snapshot, { ex: KPI_HOUR_TTL_SEC }),
    redis.set(weekKey, mergedWeek, { ex: KPI_WEEK_TTL_SEC }),
  ];

  const lastGood = await redis.get<KpiSnapshot>(KPI_LAST_GOOD_KEY);
  if (!lastGood || snapshotQuality(snapshot) >= snapshotQuality(lastGood)) {
    writes.push(
      redis.set(KPI_LAST_GOOD_KEY, snapshot, { ex: KPI_LAST_GOOD_TTL_SEC }),
    );
  }

  // Health is evaluated against the live capture, never `mergedWeek` — the
  // week rollup keeps peaks, so it would report a healthy mesh all week on the
  // strength of one good hour.
  const priorHealth = await redis.get<MeshHealth>(MESH_HEALTH_KEY);
  const health = evaluateMeshHealth(snapshot, priorHealth, at);
  writes.push(
    redis.set(MESH_HEALTH_KEY, health, { ex: MESH_HEALTH_TTL_SEC }),
  );

  await Promise.all(writes);

  const milestoneAdded = await recordMilestones(snapshot, opts?.hostHostname);

  return {
    hourKey,
    weekKey,
    backend: "redis",
    weekMerged: !!existingWeek && mergedWeek !== snapshot,
    milestoneAdded,
    health,
  };
}

export async function getMeshHealth(): Promise<MeshHealth | null> {
  const redis = getRedis();
  if (!redis) return null;
  const stored = await redis.get<MeshHealth>(MESH_HEALTH_KEY);
  // Records written before `flagship_ready_contributors` existed lack it.
  return stored ? normalizeMeshHealth(stored) : null;
}

async function recordMilestones(
  snap: KpiSnapshot,
  hostHostname?: string | null,
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;

  await ensureKnownMilestones(redis);

  const auto = milestoneFromSnapshot(snap, hostHostname);
  if (!auto) return null;

  const existing = (await redis.get<KpiMilestone[]>(KPI_MILESTONES_KEY)) ?? [];
  const ids = new Set(existing.map((m) => m.id));

  // Also record per-model first-serve (dedupe by model id across weeks).
  const modelSlug = auto.model?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const stableId = modelSlug ? `first-serve-${modelSlug}` : auto.id;
  if (ids.has(stableId) || ids.has(auto.id)) return null;

  const entry: KpiMilestone = { ...auto, id: stableId };
  const next = [entry, ...existing].slice(0, 50);
  await redis.set(KPI_MILESTONES_KEY, next, { ex: KPI_MILESTONES_TTL_SEC });
  return stableId;
}

/** One-time idempotent seed for milestones before automated capture existed. */
export async function ensureKnownMilestones(
  redis = getRedis(),
): Promise<number> {
  if (!redis) return 0;
  const existing = (await redis.get<KpiMilestone[]>(KPI_MILESTONES_KEY)) ?? [];
  const ids = new Set(existing.map((m) => m.id));
  const toAdd = KNOWN_MILESTONES.filter((m) => !ids.has(m.id));
  if (toAdd.length > 0) {
    const next = [...toAdd, ...existing].slice(0, 50);
    await redis.set(KPI_MILESTONES_KEY, next, { ex: KPI_MILESTONES_TTL_SEC });
  }
  await ensureLastGoodBackfill(redis);
  return toAdd.length;
}

async function ensureLastGoodBackfill(redis: NonNullable<ReturnType<typeof getRedis>>) {
  const lastGood = await redis.get<KpiSnapshot>(KPI_LAST_GOOD_KEY);
  if (lastGood && snapshotQuality(lastGood) > 5_000) return;

  const backfill = KNOWN_MILESTONES.map(snapshotFromMilestone).sort(
    (a, b) => snapshotQuality(b) - snapshotQuality(a),
  )[0];
  if (!backfill) return;

  await redis.set(KPI_LAST_GOOD_KEY, backfill, { ex: KPI_LAST_GOOD_TTL_SEC });

  const weekKey = kpiWeekKey(new Date(backfill.captured_at));
  const existingWeek = await redis.get<KpiSnapshot>(weekKey);
  await redis.set(
    weekKey,
    mergeWeekSnapshots(existingWeek, backfill),
    { ex: KPI_WEEK_TTL_SEC },
  );
}

export async function appendMilestone(
  milestone: KpiMilestone,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const existing = (await redis.get<KpiMilestone[]>(KPI_MILESTONES_KEY)) ?? [];
  if (existing.some((m) => m.id === milestone.id)) return false;
  const next = [milestone, ...existing].slice(0, 50);
  await redis.set(KPI_MILESTONES_KEY, next, { ex: KPI_MILESTONES_TTL_SEC });
  return true;
}

export async function getKpiWeek(
  week: string,
): Promise<KpiSnapshot | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get<KpiSnapshot>(`${KPI_WEEK_PREFIX}${week}`);
}

export async function getKpiLatestWeek(): Promise<KpiSnapshot | null> {
  return getKpiWeek(isoWeekLabel(new Date()));
}

export async function getKpiLastGood(): Promise<KpiSnapshot | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get<KpiSnapshot>(KPI_LAST_GOOD_KEY);
}

export async function getKpiMilestones(): Promise<KpiMilestone[]> {
  const redis = getRedis();
  if (!redis) return [...KNOWN_MILESTONES];
  await ensureKnownMilestones(redis);
  return (await redis.get<KpiMilestone[]>(KPI_MILESTONES_KEY)) ?? KNOWN_MILESTONES;
}

export function kpiStoreReady(): boolean {
  return kvConfigured();
}

export type KpiDashboardPayload = {
  storeReady: boolean;
  week: string;
  previousWeek: string;
  latest: KpiSnapshot | null;
  previous: KpiSnapshot | null;
  lastGood: KpiSnapshot | null;
  milestones: KpiMilestone[];
  meshShare: {
    rolling24h: MeshShareWindow;
    rolling7d: MeshShareWindow;
  };
  /** Live supply health from the most recent capture; null before first cron. */
  health: MeshHealth | null;
  /** Phase 5 gate 5 — realised gross margin broken out by `served_by`. */
  margin: {
    rolling24h: MarginWindow;
    rolling7d: MarginWindow;
  };
};

export async function getKpiDashboard(
  at = new Date(),
): Promise<KpiDashboardPayload> {
  const week = isoWeekLabel(at);
  const previousWeek = previousIsoWeekLabel(at);

  if (!kvConfigured()) {
    return {
      storeReady: false,
      week,
      previousWeek,
      latest: null,
      previous: null,
      lastGood: null,
      milestones: KNOWN_MILESTONES,
      meshShare: {
        rolling24h: { hours: 24, mesh: 0, fallback: 0, pct: null },
        rolling7d: { hours: 168, mesh: 0, fallback: 0, pct: null },
      },
      health: null,
      margin: {
        rolling24h: emptyMarginWindow(24),
        rolling7d: emptyMarginWindow(168),
      },
    };
  }

  const [
    latest,
    previous,
    lastGood,
    milestones,
    rolling24h,
    rolling7d,
    health,
    margin24h,
    margin7d,
  ] = await Promise.all([
    getKpiWeek(week),
    getKpiWeek(previousWeek),
    getKpiLastGood(),
    getKpiMilestones(),
    getMeshShareRolling(24, at),
    getMeshShareRolling(168, at),
    getMeshHealth(),
    getMarginRolling(24, at),
    getMarginRolling(168, at),
  ]);

  return {
    storeReady: true,
    week,
    previousWeek,
    latest,
    previous,
    lastGood,
    milestones,
    meshShare: { rolling24h, rolling7d },
    health,
    margin: { rolling24h: margin24h, rolling7d: margin7d },
  };
}
