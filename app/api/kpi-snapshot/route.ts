/**
 * Hourly mesh KPI snapshots (Upstash Redis) + read API for weekly reports.
 *
 * Cron: vercel.json → GET /api/kpi-snapshot (secured with CRON_SECRET).
 * Manual: same endpoint with Authorization: Bearer $CRON_SECRET
 *
 * Read (no auth): GET /api/kpi-snapshot?week=2026-W21
 *                 GET /api/kpi-snapshot?latest=1
 *                 GET /api/kpi-snapshot?dashboard=1
 *                 GET /api/kpi-snapshot?health=1   ← live supply health
 */

import { NextResponse } from "next/server";
import {
  buildKpiSnapshot,
  meshRuntimeToKpiInput,
  pickFlagshipModel,
  type KpiStatusInput,
  type MeshRuntimeStatus,
} from "../../lib/kpi-snapshot";
import {
  ensureKnownMilestones,
  getKpiDashboard,
  getKpiLatestWeek,
  getKpiWeek,
  getMeshHealth,
  kpiStoreReady,
  saveKpiSnapshot,
} from "../../lib/kpi-store";
import { describeMeshHealth } from "../../lib/mesh-health";
import { ingestVerificationFromPeers } from "../../lib/verification-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_FLAGSHIP =
  process.env.SENDA_KPI_FLAGSHIP_MODEL?.trim() ||
  "Qwen3-8B-Q4_K_M";

const DEFAULT_MESH_STATUS_URL =
  process.env.SENDA_KPI_STATUS_URL?.trim() ||
  "https://entry.senda.network/api/status";

function trimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value) return value;
  }
  return undefined;
}

function meshBaseUrl(): string {
  return DEFAULT_MESH_STATUS_URL.replace(/\/api\/status\/?$/, "");
}

function cronAuthorized(req: Request): boolean {
  const secret = trimmedEnv("CRON_SECRET");
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

async function fetchRoutableModels(base: string): Promise<string[]> {
  try {
    const res = await fetch(`${base}/v1/models`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchMeshKpiInput(): Promise<{
  status: KpiStatusInput;
  statusUrl: string;
  routableModels: string[];
  hostHostname: string | null;
  raw: MeshRuntimeStatus;
}> {
  const base = meshBaseUrl();
  const statusUrl = `${base}/api/status`;
  const [statusRes, routableModels] = await Promise.all([
    fetch(statusUrl, { cache: "no-store" }),
    fetchRoutableModels(base),
  ]);
  if (!statusRes.ok) {
    throw new Error(`mesh status fetch failed: ${statusRes.status}`);
  }
  const body = (await statusRes.json()) as MeshRuntimeStatus;
  const status = meshRuntimeToKpiInput(body);
  status.models = routableModels;

  const host = (body.peers ?? []).find((p) =>
    (p.role ?? "").toLowerCase().startsWith("host"),
  );

  return {
    status,
    statusUrl,
    routableModels,
    hostHostname: host?.hostname ?? null,
    raw: body,
  };
}

async function captureSnapshot(flagshipParam?: string | null) {
  const { status, statusUrl, routableModels, hostHostname, raw } =
    await fetchMeshKpiInput();
  const flagship = pickFlagshipModel(
    status.nodes,
    routableModels,
    flagshipParam,
    DEFAULT_FLAGSHIP,
  );
  const snapshot = buildKpiSnapshot(
    status,
    flagship,
    statusUrl,
    new Date(),
    routableModels,
  );
  const saved = await saveKpiSnapshot(snapshot, new Date(), { hostHostname });
  // Phase 5.B observe: persist synthetic-probe verdicts + reputation grades.
  const verifyIngest = await ingestVerificationFromPeers(raw.peers ?? []);

  // Supply health goes in the cron response (and the Vercel cron log) so a
  // degraded mesh is visible without anyone opening a dashboard.
  const health = saved.health;
  if (health && health.level !== "ok") {
    console.warn(`[kpi-snapshot] ${describeMeshHealth(health)}`);
  }

  return {
    snapshot,
    saved,
    storeReady: kpiStoreReady(),
    verifyIngest,
    health,
    healthSummary: health ? describeMeshHealth(health) : null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const week = url.searchParams.get("week");
  const latest = url.searchParams.get("latest");
  const dashboard = url.searchParams.get("dashboard");
  const seed = url.searchParams.get("seed");
  const health = url.searchParams.get("health");

  // Idempotent milestone backfill (cron or manual with secret).
  if (seed === "milestones" && cronAuthorized(req)) {
    const added = await ensureKnownMilestones();
    return NextResponse.json({ ok: true, action: "seed-milestones", added });
  }

  if (cronAuthorized(req)) {
    try {
      const flagship =
        url.searchParams.get("model")?.trim() || undefined;
      const result = await captureSnapshot(flagship);
      return NextResponse.json({
        ok: true,
        action: "capture",
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { ok: false, error: message },
        { status: 502 },
      );
    }
  }

  // Read-only supply health. Deliberately unauthenticated and cheap: it is the
  // thing you want to be able to check from anywhere, fast.
  if (health === "1" || health === "true") {
    const current = await getMeshHealth();
    if (!current) {
      return NextResponse.json(
        { error: "no health check recorded yet", storeReady: kpiStoreReady() },
        { status: 503 },
      );
    }
    return NextResponse.json({
      health: current,
      summary: describeMeshHealth(current),
    });
  }

  if (dashboard === "1" || dashboard === "true") {
    if (kpiStoreReady()) {
      await ensureKnownMilestones();
    }
    const data = await getKpiDashboard();
    return NextResponse.json({
      ...data,
      flagship_default: DEFAULT_FLAGSHIP,
    });
  }

  if (!week && !latest) {
    return NextResponse.json({
      usage: {
        capture: "Vercel Cron or GET with Authorization: Bearer $CRON_SECRET",
        read_week: "?week=2026-W21",
        read_latest: "?latest=1",
        dashboard: "?dashboard=1",
        health: "?health=1 (live supply health, no auth)",
        seed_milestones: "?seed=milestones (auth required)",
      },
      storeReady: kpiStoreReady(),
      flagship_default: DEFAULT_FLAGSHIP,
      mesh_status_url: DEFAULT_MESH_STATUS_URL,
    });
  }

  if (!kpiStoreReady()) {
    return NextResponse.json(
      {
        error: "kpi store not configured",
        hint: "Link Upstash Redis on Vercel and set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN",
      },
      { status: 503 },
    );
  }

  if (week) {
    const snapshot = await getKpiWeek(week);
    if (!snapshot) {
      return NextResponse.json({ error: "not found", week }, { status: 404 });
    }
    return NextResponse.json({ week, snapshot });
  }

  if (latest === "1" || latest === "true") {
    const snapshot = await getKpiLatestWeek();
    if (!snapshot) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ snapshot });
  }

  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function POST(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let flagship: string | undefined;
  try {
    const body = (await req.json()) as { model?: string };
    if (body.model?.trim()) flagship = body.model.trim();
  } catch {
    /* empty body is fine */
  }
  try {
    const result = await captureSnapshot(flagship);
    return NextResponse.json({ ok: true, action: "capture", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
