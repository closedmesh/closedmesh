/**
 * Supply health gate for the hourly KPI cron.
 *
 * W33 (2026-08-11) exposed the gap this closes: contributor supply slid for
 * three weeks and the mesh lost the ability to serve its own advertised daily
 * driver, and nothing surfaced it — the weekly rollup is a *peak* merge
 * (`mergeWeekSnapshots`), so by design it hides a mesh that is empty right now
 * behind the best hour of the week.
 *
 * So this evaluates the **live capture**, never the merged rollup, and tracks
 * how long the condition has persisted so a one-hour blip reads differently
 * from a seven-day outage.
 *
 * Deliberately self-contained: a flag in Redis that `/status` renders. No
 * outbound webhook, no new secret, no external service.
 */

import type { KpiSnapshot } from "./kpi-snapshot";

export type MeshHealthLevel = "ok" | "degraded" | "down";

export type MeshHealthReason =
  | "mesh_empty"
  | "nothing_routable"
  | "flagship_not_routable"
  | "flagship_no_contributors";

export type MeshHealth = {
  level: MeshHealthLevel;
  checked_at: string;
  /** First check in the current unbroken not-ok run; null while ok. */
  degraded_since: string | null;
  /** Whole hours the mesh has been continuously not-ok. 0 while ok. */
  degraded_hours: number;
  reasons: MeshHealthReason[];
  flagship_model: string;
  flagship_routable: boolean;
  /** Peers participating in serving the flagship (includes split workers still
   *  loading). Supply, not availability. */
  flagship_contributors: number;
  /** Peers that can answer a request for the flagship right now. This is the
   *  number to quote — `flagship_contributors` counts peers still pulling
   *  weights, which cannot serve anyone. */
  flagship_ready_contributors: number;
  routable_models: string[];
  node_count: number;
};

export const MESH_HEALTH_KEY = "mesh:health";
export const MESH_HEALTH_TTL_SEC = 400 * 24 * 60 * 60;

/** Human-readable, honest phrasing for each reason. Used by `/status`. */
export const MESH_HEALTH_REASON_COPY: Record<MeshHealthReason, string> = {
  mesh_empty: "No peers are connected to the mesh.",
  nothing_routable: "No models are routable — the mesh cannot serve requests.",
  flagship_not_routable:
    "The default chat model is not routable on the mesh right now.",
  flagship_no_contributors:
    "No peer is currently serving the default chat model.",
};

function hoursBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  const ms = to.getTime() - from;
  return ms > 0 ? Math.floor(ms / 3_600_000) : 0;
}

/**
 * Classify a single live capture.
 *
 * `down` means the mesh can serve nothing at all; `degraded` means it is up but
 * cannot serve what the site advertises as the default. That distinction
 * matters because only the first is an outage — the second is the failure we
 * actually shipped for a week without noticing.
 */
export function evaluateMeshHealth(
  snapshot: KpiSnapshot,
  prior: MeshHealth | null,
  now = new Date(),
): MeshHealth {
  const routable = snapshot.routable_models ?? [];
  const flagshipRoutable = routable.includes(snapshot.flagship_model);
  const contributors = snapshot.flagship.contributors;
  // Availability is judged on peers that can actually answer, not on peers that
  // merely advertise the model. A mesh whose only flagship peer is still
  // `loading` is degraded, however healthy the contributor count looks.
  const readyContributors = snapshot.flagship.ready_contributors ?? contributors;

  const reasons: MeshHealthReason[] = [];
  let level: MeshHealthLevel = "ok";

  if (snapshot.node_count <= 0) {
    reasons.push("mesh_empty");
    level = "down";
  } else if (routable.length === 0) {
    reasons.push("nothing_routable");
    level = "down";
  } else {
    if (!flagshipRoutable) {
      reasons.push("flagship_not_routable");
      level = "degraded";
    }
    if (readyContributors <= 0) {
      reasons.push("flagship_no_contributors");
      level = "degraded";
    }
  }

  const checkedAt = now.toISOString();

  // A recovered check clears the run. Any not-ok check either opens a new run
  // or extends the existing one — including a `degraded` that follows a `down`,
  // since the mesh has not been healthy in between.
  const priorNotOk = prior && prior.level !== "ok" ? prior : null;
  const degradedSince =
    level === "ok" ? null : (priorNotOk?.degraded_since ?? checkedAt);

  return {
    level,
    checked_at: checkedAt,
    degraded_since: degradedSince,
    degraded_hours: degradedSince ? hoursBetween(degradedSince, now) : 0,
    reasons,
    flagship_model: snapshot.flagship_model,
    flagship_routable: flagshipRoutable,
    flagship_contributors: contributors,
    flagship_ready_contributors: readyContributors,
    routable_models: routable,
    node_count: snapshot.node_count,
  };
}

/**
 * Records persisted before `flagship_ready_contributors` existed read back from
 * Redis without it. Normalize on read — rendering a stored record straight from
 * the store produced "undefined peer(s) serving" on the live endpoint.
 */
export function normalizeMeshHealth(health: MeshHealth): MeshHealth {
  return {
    ...health,
    flagship_ready_contributors:
      health.flagship_ready_contributors ?? health.flagship_contributors ?? 0,
    flagship_contributors: health.flagship_contributors ?? 0,
    reasons: health.reasons ?? [],
  };
}

/** One-line summary for logs, the cron response, and the `/status` banner. */
export function describeMeshHealth(input: MeshHealth): string {
  const health = normalizeMeshHealth(input);
  if (health.level === "ok") {
    const ready = health.flagship_ready_contributors;
    // Clamp: a stored record could carry ready > contributors across a schema
    // change, and "-1 more loading" is worse than saying nothing.
    const warming = Math.max(0, health.flagship_contributors - ready);
    const warmingNote = warming > 0 ? ` (${warming} more loading)` : "";
    return `Mesh healthy — ${ready} peer(s) serving ${health.flagship_model}${warmingNote}.`;
  }
  const detail = health.reasons
    .map((r) => MESH_HEALTH_REASON_COPY[r])
    .join(" ");
  const duration =
    health.degraded_hours >= 24
      ? ` Ongoing for ${Math.floor(health.degraded_hours / 24)} day(s).`
      : health.degraded_hours >= 1
        ? ` Ongoing for ${health.degraded_hours} hour(s).`
        : "";
  return `Mesh ${health.level} — ${detail}${duration}`;
}
