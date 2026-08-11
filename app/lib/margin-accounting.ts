/**
 * Phase 5 exit gate 5 — gross-margin-per-request, broken out by `served_by`.
 *
 * `mesh-share.ts` answers "what fraction of requests did community hardware
 * serve"; this answers "what did each of those two paths actually earn us".
 * They are deliberately separate modules: mesh share is a ratio of counts,
 * this is money, and conflating them is how you end up reporting a margin you
 * cannot substantiate.
 *
 * The rate card already *guarantees* a positive margin structurally
 * (`assertRateCardInvariants`: customer > peer payout AND customer > external
 * COGS, per tier). That is a promise about prices. This module measures the
 * realised mix — which is a different and more useful number, because the
 * mesh/fallback split moves it request by request.
 *
 * Cost, per path:
 *
 *   mesh     → Peer USD liability (`peerUsdForCompletion`), i.e. what we owe a
 *              contributor. Zero when the customer underpaid, because
 *              `accrueMeshCredits` is called with `skipPeerUsd` and no
 *              liability is actually created — booking a cost there would
 *              understate margin against money we never owe.
 *   fallback → external-provider COGS on both prompt and completion legs.
 *
 * Storage (Upstash Redis), one key per hour per `served_by`:
 *
 *   senda:margin:n:<served_by>:<YYYYMMDDTHH>     -> request count
 *   senda:margin:rev:<served_by>:<YYYYMMDDTHH>   -> micro-USD charged
 *   senda:margin:cost:<served_by>:<YYYYMMDDTHH>  -> micro-USD cost
 *
 * Counts are tracked here as well as in `mesh-share.ts` so a margin window is
 * internally consistent (n, revenue and cost are written in one place from one
 * set of inputs). If the two ever disagree that is a signal worth reading, not
 * a bug to paper over.
 *
 * All amounts are integer micro-USD. No floats in the ledger path.
 */

import { getRedis } from "./redis";
import { peerUsdForCompletion } from "./peer-earnings";
import {
  getRateCardRow,
  microsToUsd,
  tokensCostMicros,
} from "./rate-card";
import type { ServedBy } from "./mesh-share";

const MARGIN_PREFIX = "senda:margin";
/** Matches `mesh-share.ts` so both windows age out together. */
const BUCKET_TTL_SEC = 35 * 24 * 3600;

type MarginField = "n" | "rev" | "cost";

function hourBucketLabel(at: Date): string {
  return (
    String(at.getUTCFullYear()) +
    String(at.getUTCMonth() + 1).padStart(2, "0") +
    String(at.getUTCDate()).padStart(2, "0") +
    "T" +
    String(at.getUTCHours()).padStart(2, "0")
  );
}

function bucketKey(
  field: MarginField,
  servedBy: ServedBy,
  hour: string,
): string {
  return `${MARGIN_PREFIX}:${field}:${servedBy}:${hour}`;
}

/**
 * Cost of serving one request on a given path, in micro-USD.
 *
 * Exported because it is the honest definition of COGS for this business and
 * belongs under test, not buried in a write path.
 */
export function requestCostOfGoodsMicros(input: {
  servedBy: ServedBy;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Customer shortfall in micro-USD; suppresses peer liability when > 0. */
  underpaid?: number;
}): number {
  if (input.servedBy === "mesh") {
    // Mirrors `finalizeMeshAccrual`'s `skipPeerUsd: underpaid > 0`.
    if ((input.underpaid ?? 0) > 0) return 0;
    return peerUsdForCompletion({
      modelId: input.modelId,
      completionTokens: input.completionTokens,
    });
  }
  const row = getRateCardRow(input.modelId);
  return (
    tokensCostMicros(
      input.promptTokens,
      row.external_cogs_prompt_per_mtok_usd_micros,
    ) +
    tokensCostMicros(
      input.completionTokens,
      row.external_cogs_completion_per_mtok_usd_micros,
    )
  );
}

/**
 * Fire-and-forget margin write. Callers must NOT await this on the request hot
 * path — same contract as `recordServedByDecision`, and for the same reason:
 * bookkeeping must never be able to fail a request the customer paid for.
 */
export async function recordRequestMargin(input: {
  servedBy: ServedBy;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Micro-USD actually charged (post-settle). */
  chargedMicros: number;
  underpaid?: number;
  at?: Date;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const cost = requestCostOfGoodsMicros(input);
  const revenue = Math.max(0, Math.round(input.chargedMicros || 0));
  const hour = hourBucketLabel(input.at ?? new Date());

  const nKey = bucketKey("n", input.servedBy, hour);
  const revKey = bucketKey("rev", input.servedBy, hour);
  const costKey = bucketKey("cost", input.servedBy, hour);

  try {
    const n = await redis.incr(nKey);
    await Promise.all([
      revenue > 0 ? redis.incrby(revKey, revenue) : Promise.resolve(0),
      cost > 0 ? redis.incrby(costKey, cost) : Promise.resolve(0),
    ]);
    // Set TTLs once, on bucket creation. `incrby` on a missing key creates it
    // without a TTL, so expire all three rather than only the counter.
    if (n === 1) {
      await Promise.all([
        redis.expire(nKey, BUCKET_TTL_SEC),
        redis.expire(revKey, BUCKET_TTL_SEC),
        redis.expire(costKey, BUCKET_TTL_SEC),
      ]);
    }
  } catch {
    // Swallowed for the same reason as the mesh-share counter: the response is
    // the product, this is bookkeeping.
  }
}

export type MarginPathWindow = {
  requests: number;
  revenue_usd_micros: number;
  cost_usd_micros: number;
  margin_usd_micros: number;
  /** Gross margin as a share of revenue. Null when no revenue recorded. */
  margin_pct: number | null;
  /** Micro-USD margin per request. Null when no requests recorded. */
  margin_per_request_usd_micros: number | null;
};

export type MarginWindow = {
  hours: number;
  mesh: MarginPathWindow;
  fallback: MarginPathWindow;
  /** Both paths combined — the headline gross margin. */
  total: MarginPathWindow;
};

function emptyPath(): MarginPathWindow {
  return {
    requests: 0,
    revenue_usd_micros: 0,
    cost_usd_micros: 0,
    margin_usd_micros: 0,
    margin_pct: null,
    margin_per_request_usd_micros: null,
  };
}

function buildPath(
  requests: number,
  revenue: number,
  cost: number,
): MarginPathWindow {
  const margin = revenue - cost;
  return {
    requests,
    revenue_usd_micros: revenue,
    cost_usd_micros: cost,
    margin_usd_micros: margin,
    // Null rather than 0 so "not measured" never renders as "0% margin".
    margin_pct: revenue > 0 ? (margin / revenue) * 100 : null,
    margin_per_request_usd_micros:
      requests > 0 ? Math.round(margin / requests) : null,
  };
}

export function emptyMarginWindow(hours: number): MarginWindow {
  return {
    hours,
    mesh: emptyPath(),
    fallback: emptyPath(),
    total: emptyPath(),
  };
}

/**
 * Sum the last `hours` hourly buckets into a margin window.
 *
 * One `MGET` per (field, path) pair — 6 round-trips regardless of `hours`,
 * same approach as `getMeshShareRolling`.
 */
export async function getMarginRolling(
  hours: number,
  now: Date = new Date(),
): Promise<MarginWindow> {
  const redis = getRedis();
  if (!redis || hours <= 0) return emptyMarginWindow(hours);

  const hourLabels: string[] = [];
  for (let i = 0; i < hours; i++) {
    hourLabels.push(hourBucketLabel(new Date(now.getTime() - i * 3600_000)));
  }

  const paths: ServedBy[] = ["mesh", "fallback"];
  const fields: MarginField[] = ["n", "rev", "cost"];

  try {
    const reads = await Promise.all(
      paths.flatMap((path) =>
        fields.map(async (field) => {
          const keys = hourLabels.map((h) => bucketKey(field, path, h));
          const vals = await redis.mget<(string | number | null)[]>(...keys);
          return { path, field, sum: sumCounters(vals) };
        }),
      ),
    );

    const pick = (path: ServedBy, field: MarginField) =>
      reads.find((r) => r.path === path && r.field === field)?.sum ?? 0;

    const mesh = buildPath(
      pick("mesh", "n"),
      pick("mesh", "rev"),
      pick("mesh", "cost"),
    );
    const fallback = buildPath(
      pick("fallback", "n"),
      pick("fallback", "rev"),
      pick("fallback", "cost"),
    );
    const total = buildPath(
      mesh.requests + fallback.requests,
      mesh.revenue_usd_micros + fallback.revenue_usd_micros,
      mesh.cost_usd_micros + fallback.cost_usd_micros,
    );

    return { hours, mesh, fallback, total };
  } catch {
    return emptyMarginWindow(hours);
  }
}

function sumCounters(vals: (string | number | null)[] | null): number {
  if (!vals) return 0;
  let sum = 0;
  for (const v of vals) {
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
    if (!Number.isNaN(n)) sum += n;
  }
  return sum;
}

/** Test seam mirroring `computeMeshShareFromCounters`. */
export type MarginCounters = Record<string, number>;

export function computeMarginFromCounters(
  counters: MarginCounters,
  hours: number,
  now: Date,
): MarginWindow {
  const read = (field: MarginField, path: ServedBy) => {
    let sum = 0;
    for (let i = 0; i < hours; i++) {
      const hour = hourBucketLabel(new Date(now.getTime() - i * 3600_000));
      sum += counters[bucketKey(field, path, hour)] ?? 0;
    }
    return sum;
  };

  const mesh = buildPath(read("n", "mesh"), read("rev", "mesh"), read("cost", "mesh"));
  const fallback = buildPath(
    read("n", "fallback"),
    read("rev", "fallback"),
    read("cost", "fallback"),
  );
  const total = buildPath(
    mesh.requests + fallback.requests,
    mesh.revenue_usd_micros + fallback.revenue_usd_micros,
    mesh.cost_usd_micros + fallback.cost_usd_micros,
  );
  return { hours, mesh, fallback, total };
}

/** Display helper: micro-USD → USD, for the `/metrics` cards. */
export function marginUsd(micros: number | null): number | null {
  return micros == null ? null : microsToUsd(micros);
}
