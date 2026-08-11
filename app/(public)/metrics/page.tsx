"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PublicHeader } from "../../components/PublicHeader";
import { MeshLiveStatus } from "../../components/MeshLiveStatus";
import { SettlementPanel } from "../../components/SettlementPanel";
import {
  type KpiMilestone,
  type KpiSnapshot,
  snapshotQuality,
} from "../../lib/kpi-snapshot";
import type { NodeSummary } from "../../lib/use-mesh-status";
import type {
  MarginPathWindow,
  MarginWindow,
} from "../../lib/margin-accounting";

type MeshShareWindow = {
  hours: number;
  mesh: number;
  fallback: number;
  pct: number | null;
};

type KpiDashboard = {
  storeReady: boolean;
  week: string;
  previousWeek: string;
  flagship_default: string;
  latest: KpiSnapshot | null;
  previous: KpiSnapshot | null;
  lastGood: KpiSnapshot | null;
  milestones: KpiMilestone[];
  meshShare?: {
    rolling24h: MeshShareWindow;
    rolling7d: MeshShareWindow;
  };
  margin?: {
    rolling24h: MarginWindow;
    rolling7d: MarginWindow;
  };
};

type MeshStatus = {
  online: boolean;
  nodeCount: number;
  models: string[];
  nodes: NodeSummary[];
};

function prettyModel(id: string): string {
  return id
    .replace(/\.gguf$/i, "")
    .replace(/-Q\d+(_K(_[SM])?|_0|_1)?$/i, "")
    .replace(/-UD-Q\d+(_K(_[SM]|_XL))?$/i, "");
}

function backendLabel(backend: string): string {
  const map: Record<string, string> = {
    metal: "Apple Metal",
    cuda: "NVIDIA CUDA",
    rocm: "AMD ROCm",
    vulkan: "Vulkan",
    cpu: "CPU",
  };
  return map[backend] ?? backend;
}

function formatTps(v: number | null): string {
  if (v == null) return "—";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} tok/s`;
}

function formatDelta(
  cur: number | null,
  prev: number | null,
  opts?: { suffix?: string; lowerIsBetter?: boolean },
): string | null {
  if (cur == null || prev == null) return null;
  const suffix = opts?.suffix ?? "";
  if (cur === prev) return null;
  const better = opts?.lowerIsBetter ? cur < prev : cur > prev;
  const pct =
    prev !== 0 ? Math.round(((cur - prev) / Math.abs(prev)) * 100) : null;
  const arrow = better ? "↑" : "↓";
  const pctPart = pct != null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : "";
  return `${arrow} ${formatTps(cur)} from ${formatTps(prev)}${pctPart}${suffix}`;
}

function formatCountDelta(cur: number, prev: number, label: string): string | null {
  if (cur === prev) return null;
  return `${cur > prev ? "↑" : "↓"} ${prev} → ${cur} ${label}`;
}

function snapshotHasSignal(snap: KpiSnapshot | null): boolean {
  if (!snap) return false;
  return (
    snap.node_count > 0 ||
    snap.models_available > 0 ||
    snap.pooled_vram_gb > 0 ||
    snap.flagship.contributors > 0
  );
}

function StatCard({
  label,
  value,
  hint,
  delta,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--fg)]">
        {value}
      </div>
      {delta ? (
        <div className="text-[11px] text-[var(--accent)]">{delta}</div>
      ) : null}
      {hint ? (
        <div className="text-[11px] text-[var(--fg-muted)]">{hint}</div>
      ) : null}
    </div>
  );
}

function MilestoneCard({ m }: { m: KpiMilestone }) {
  return (
    <div className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/5 px-4 py-4">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
        Milestone · {new Date(m.at).toLocaleDateString()}
      </div>
      <div className="mt-1 text-[15px] font-medium text-[var(--fg)]">
        {m.title}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg-muted)]">
        {m.detail}
      </p>
      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[var(--fg-muted)]">
        {m.model ? (
          <span>{prettyModel(m.model)}</span>
        ) : null}
        {m.peer_count != null ? <span>{m.peer_count} peers</span> : null}
        {m.pooled_vram_gb != null ? (
          <span>{m.pooled_vram_gb} GB pooled</span>
        ) : null}
        {m.host_hostname ? <span>Host: {m.host_hostname}</span> : null}
        {m.measured_tps != null ? (
          <span>{m.measured_tps.toFixed(1)} tok/s (measured)</span>
        ) : null}
        {m.measured_ttft_ms != null ? (
          <span>TTFT {(m.measured_ttft_ms / 1000).toFixed(1)}s</span>
        ) : null}
      </div>
    </div>
  );
}

/** micro-USD → "$0.0123" with enough precision for per-request amounts. */
function fmtUsdMicros(micros: number | null): string {
  if (micros == null) return "—";
  const usd = micros / 1_000_000;
  const abs = Math.abs(usd);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return `${usd < 0 ? "-" : ""}$${Math.abs(usd).toFixed(digits)}`;
}

function fmtPct(pct: number | null): string {
  return pct == null ? "—" : `${pct.toFixed(1)}%`;
}

/**
 * Phase 5 exit gate 5 — gross margin per request, broken out by `served_by`.
 *
 * The point of the breakout is that the two paths have structurally different
 * economics: a mesh serve pays a contributor, a fallback serve pays an external
 * provider. Showing only a blended number would hide the single lever
 * (`mesh_share_pct`) that moves it.
 */
function MarginPanel({
  margin,
}: {
  margin: { rolling24h: MarginWindow; rolling7d: MarginWindow };
}) {
  const { rolling24h, rolling7d } = margin;
  const hasData =
    rolling24h.total.requests > 0 || rolling7d.total.requests > 0;

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
          Gross margin
        </h2>
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          per request, by served_by
        </span>
      </div>
      {!hasData ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4 text-[12px] text-[var(--fg-muted)]">
          No paid requests in the rolling window yet. When there are, this shows
          revenue minus cost of goods for each path — a mesh serve&rsquo;s cost is
          the contributor payout, a fallback serve&rsquo;s cost is what we pay an
          external provider.
        </div>
      ) : (
        <div className="space-y-3">
          <MarginWindowCard label="Last 24 hours" window={rolling24h} />
          <MarginWindowCard label="Last 7 days" window={rolling7d} />
        </div>
      )}
    </section>
  );
}

function MarginWindowCard({
  label,
  window,
}: {
  label: string;
  window: MarginWindow;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium">{label}</span>
        <span className="text-[11px] text-[var(--fg-muted)]">
          {window.total.requests} request
          {window.total.requests === 1 ? "" : "s"} ·{" "}
          {fmtUsdMicros(window.total.margin_usd_micros)} margin ·{" "}
          {fmtPct(window.total.margin_pct)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-left text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
              <th className="pb-2 font-normal">Path</th>
              <th className="pb-2 text-right font-normal">Requests</th>
              <th className="pb-2 text-right font-normal">Revenue</th>
              <th className="pb-2 text-right font-normal">Cost</th>
              <th className="pb-2 text-right font-normal">Margin/req</th>
              <th className="pb-2 text-right font-normal">Margin %</th>
            </tr>
          </thead>
          <tbody>
            <MarginRow
              name="Mesh"
              hint="pays a contributor"
              path={window.mesh}
            />
            <MarginRow
              name="Fallback"
              hint="pays an external provider"
              path={window.fallback}
            />
            <MarginRow name="Total" path={window.total} emphasis />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarginRow({
  name,
  hint,
  path,
  emphasis,
}: {
  name: string;
  hint?: string;
  path: MarginPathWindow;
  emphasis?: boolean;
}) {
  const negative = path.margin_usd_micros < 0;
  return (
    <tr
      className={
        emphasis
          ? "border-t border-[var(--border)] font-medium"
          : "text-[var(--fg-muted)]"
      }
    >
      <td className={emphasis ? "py-2" : "py-2"}>
        <span className={emphasis ? "" : "text-[var(--fg)]"}>{name}</span>
        {hint && (
          <span className="ml-1.5 text-[10px] text-[var(--fg-muted)]">
            — {hint}
          </span>
        )}
      </td>
      <td className="py-2 text-right tabular-nums">{path.requests}</td>
      <td className="py-2 text-right tabular-nums">
        {fmtUsdMicros(path.revenue_usd_micros)}
      </td>
      <td className="py-2 text-right tabular-nums">
        {fmtUsdMicros(path.cost_usd_micros)}
      </td>
      <td
        className={`py-2 text-right tabular-nums ${negative ? "text-red-400" : ""}`}
      >
        {fmtUsdMicros(path.margin_per_request_usd_micros)}
      </td>
      <td
        className={`py-2 text-right tabular-nums ${negative ? "text-red-400" : ""}`}
      >
        {fmtPct(path.margin_pct)}
      </td>
    </tr>
  );
}

function MeshSharePanel({
  meshShare,
}: {
  meshShare: { rolling24h: MeshShareWindow; rolling7d: MeshShareWindow };
}) {
  const { rolling24h, rolling7d } = meshShare;
  const total24 = rolling24h.mesh + rolling24h.fallback;
  const total7 = rolling7d.mesh + rolling7d.fallback;
  const hasData = total24 > 0 || total7 > 0;

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
          Mesh share
        </h2>
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          % served by community hardware
        </span>
      </div>
      {!hasData ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4 text-[12px] text-[var(--fg-muted)]">
          No requests in the rolling window yet. This is the fraction of API
          traffic served by community hardware — mesh peers are the network&rsquo;s
          supply, and this number grows as more capable peers come online.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <MeshShareCard label="Last 24 hours" window={rolling24h} />
          <MeshShareCard label="Last 7 days" window={rolling7d} />
        </div>
      )}
    </section>
  );
}

function MeshShareCard({
  label,
  window,
}: {
  label: string;
  window: MeshShareWindow;
}) {
  const total = window.mesh + window.fallback;
  const pct = window.pct;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-[var(--fg)]">
          {pct == null ? "—" : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`}
        </span>
        <span className="text-[11px] text-[var(--fg-muted)]">mesh</span>
      </div>
      <div className="mt-2 text-[11px] text-[var(--fg-muted)] tabular-nums">
        {total === 0
          ? "no requests recorded"
          : `${window.mesh.toLocaleString()} mesh · ${window.fallback.toLocaleString()} fallback · ${total.toLocaleString()} total`}
      </div>
    </div>
  );
}

function SharingRow({ node }: { node: NodeSummary }) {
  const models = [
    ...new Set([
      ...node.servingModels,
      ...(node.capability?.loadedModels ?? []),
    ]),
  ];
  const host =
    node.hostname?.startsWith("ip-")
      ? "Entry node"
      : (node.hostname ?? node.id.slice(0, 8));
  const backend = node.capability?.backend;
  const vram = node.capability?.vramGb ?? node.vramGb;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-[12px]">
      <div>
        <span className="font-medium text-[var(--fg)]">{host}</span>
        {backend ? (
          <span className="ml-2 text-[var(--fg-muted)]">
            {backendLabel(backend)}
            {vram > 0 ? ` · ${vram} GB` : ""}
          </span>
        ) : null}
      </div>
      <div className="text-[var(--fg-muted)]">
        {models.length === 0
          ? "No models loaded"
          : models.map(prettyModel).join(", ")}
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const [dashboard, setDashboard] = useState<KpiDashboard | null>(null);
  const [live, setLive] = useState<MeshStatus | null>(null);
  const [kpiError, setKpiError] = useState(false);
  const [liveError, setLiveError] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const [kpiRes, statusRes] = await Promise.all([
          fetch("/api/kpi-snapshot?dashboard=1", { cache: "no-store" }),
          fetch("/api/status", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (kpiRes.ok) {
          setDashboard((await kpiRes.json()) as KpiDashboard);
          setKpiError(false);
        } else {
          setKpiError(true);
        }
        if (statusRes.ok) {
          setLive((await statusRes.json()) as MeshStatus);
          setLiveError(false);
        } else {
          setLiveError(true);
        }
        setUpdated(new Date());
      } catch {
        if (!cancelled) {
          setKpiError(true);
          setLiveError(true);
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, 30_000);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const weeklyDisplay = (() => {
    const latest = dashboard?.latest;
    const lastGood = dashboard?.lastGood;
    if (!latest && !lastGood) return null;
    if (!latest) return lastGood;
    if (!lastGood) return latest;
    if (
      (latest.flagship.contributors === 0 || latest.models_available === 0) &&
      (lastGood.flagship.contributors > 0 || lastGood.models_available > 0)
    ) {
      return lastGood;
    }
    if (
      snapshotQuality(lastGood) > snapshotQuality(latest) &&
      !snapshotHasSignal(latest)
    ) {
      return lastGood;
    }
    return snapshotHasSignal(latest) ? latest : lastGood;
  })();

  const flagship =
    weeklyDisplay?.flagship_model ??
    dashboard?.flagship_default ??
    "DeepSeek-R1-Distill-70B-Q4_K_M";
  const latest = weeklyDisplay;
  const prev = dashboard?.previous;
  const lf = latest?.flagship;
  const pf = prev?.flagship;

  const liveContributors = (live?.nodes ?? []).filter(
    (n) => !(n.hostname ?? "").startsWith("ip-"),
  );
  const meshLive = liveContributors.length > 0;
  const livePooled = liveContributors.reduce(
    (sum, n) => sum + (n.capability?.vramGb ?? n.vramGb ?? 0),
    0,
  );
  const liveBackends = [
    ...new Set(
      liveContributors
        .map((n) => n.capability?.backend)
        .filter((b): b is string => !!b),
    ),
  ].sort();
  const sharingNow = liveContributors.filter(
    (n) =>
      n.servingModels.length > 0 ||
      (n.capability?.loadedModels?.length ?? 0) > 0,
  );

  const milestones = dashboard?.milestones ?? [];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader status={<MeshLiveStatus variant="header" />} />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Mesh metrics
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              Capacity, speed, settlement
            </h1>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--fg-muted)]">
              Milestones and weekly KPIs from the mesh entry. Below: public USDC
              settlement aggregates (liabilities, peer payouts) for the paid API
              preview — verify individual txs on Solscan via{" "}
              <Link href="/earn" className="text-[var(--accent)] hover:underline">
                /earn
              </Link>
              .
            </p>
          </div>
          <div className="flex gap-3 text-[12px]">
            <Link
              href="/buy"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              API preview →
            </Link>
            <Link
              href="/status"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Full status →
            </Link>
            {updated ? (
              <span className="text-[var(--fg-muted)]">
                {updated.toLocaleTimeString()}
              </span>
            ) : null}
          </div>
        </div>

        {/* Milestones — always show when we have any */}
        {milestones.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
              Milestones
            </h2>
            <div className="space-y-3">
              {milestones.map((m) => (
                <MilestoneCard key={m.id} m={m} />
              ))}
            </div>
          </section>
        )}

        {/* Mesh share — the headline routable-network KPI */}
        {dashboard?.meshShare ? (
          <MeshSharePanel meshShare={dashboard.meshShare} />
        ) : null}

        {/* Gross margin — Phase 5 exit gate 5. Sits directly under mesh share
            because mesh_share_pct is the lever that moves it. */}
        {dashboard?.margin ? (
          <MarginPanel margin={dashboard.margin} />
        ) : null}

        <SettlementPanel />

        {/* Weekly KPI */}
        <section className="mb-10">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
              Weekly KPI · {dashboard?.week ?? "…"}
            </h2>
            {dashboard?.previousWeek && prev ? (
              <span className="text-[10px] text-[var(--fg-muted)]">
                vs {dashboard.previousWeek}
              </span>
            ) : null}
          </div>

          {!dashboard && !kpiError && (
            <div className="h-28 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
          )}

          {kpiError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-[12px] text-red-400">
              Could not load stored KPIs.
            </div>
          )}

          {dashboard && !dashboard.storeReady && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4 text-[12px] text-[var(--fg-muted)]">
              KPI history is not configured yet. Milestones above still show
              known wins; link Upstash Redis on Vercel for hourly capture.
            </div>
          )}

          {latest && !snapshotHasSignal(latest) && dashboard?.lastGood && (
            <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-[12px] text-amber-200/90">
              Mesh is offline — showing last peak capture (
              {new Date(dashboard.lastGood.captured_at).toLocaleString()}).
            </div>
          )}

          {latest && (
            <>
              <p className="mb-4 text-[13px] text-[var(--fg-muted)]">
                Flagship model:{" "}
                <span className="font-medium text-[var(--fg)]">
                  {prettyModel(flagship)}
                </span>
                {latest.captured_at ? (
                  <span className="ml-2 text-[11px]">
                    (snapshot {new Date(latest.captured_at).toLocaleString()})
                  </span>
                ) : null}
              </p>
              {(latest.routable_models?.length ?? 0) > 0 && (
                <p className="mb-4 text-[12px] text-[var(--fg-muted)]">
                  Routable at capture:{" "}
                  {(latest.routable_models ?? []).map(prettyModel).join(", ")}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Mesh p50 throughput"
                  value={formatTps(lf?.tps_p50_median ?? null)}
                  hint={
                    (lf?.tps_sample_count ?? 0) === 0
                      ? "Run inference on this model to measure"
                      : `${lf?.tps_sample_count ?? 0} peer(s) reporting`
                  }
                  delta={formatDelta(
                    lf?.tps_p50_median ?? null,
                    pf?.tps_p50_median ?? null,
                  )}
                />
                <StatCard
                  label="Contributors (flagship)"
                  value={String(lf?.contributors ?? 0)}
                  delta={
                    pf
                      ? formatCountDelta(
                          lf?.contributors ?? 0,
                          pf.contributors,
                          "contributors",
                        )
                      : null
                  }
                />
                <StatCard
                  label="Pooled VRAM"
                  value={`${latest.pooled_vram_gb} GB`}
                  delta={
                    prev
                      ? formatCountDelta(
                          Math.round(latest.pooled_vram_gb),
                          Math.round(prev.pooled_vram_gb),
                          "GB pooled",
                        )
                      : null
                  }
                />
                <StatCard
                  label="Mesh peers"
                  value={String(latest.node_count)}
                  hint={
                    latest.backends.length > 0
                      ? latest.backends.map(backendLabel).join(" · ")
                      : undefined
                  }
                  delta={
                    prev
                      ? formatCountDelta(
                          latest.node_count,
                          prev.node_count,
                          "peers",
                        )
                      : null
                  }
                />
              </div>
            </>
          )}
        </section>

        {/* Live now */}
        <section className="mb-10">
          <h2 className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
            Right now
          </h2>

          {liveError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-[12px] text-red-400">
              Mesh unreachable — retrying.
            </div>
          )}

          {live && !meshLive && !liveError && (
            <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4 text-[12px] text-[var(--fg-muted)]">
              No contributor machines online. Milestones and last peak above
              are unchanged — wake the cohort to refresh live stats.
            </div>
          )}

          {live && meshLive && (
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <StatCard
                label="Contributors"
                value={String(liveContributors.length)}
              />
              <StatCard
                label="Pooled VRAM"
                value={
                  livePooled >= 100
                    ? `${Math.round(livePooled)} GB`
                    : `${livePooled.toFixed(1)} GB`
                }
              />
              <StatCard
                label="Models routable"
                value={String(live.models.length)}
              />
            </div>
          )}

          {liveBackends.length > 0 && (
            <p className="mb-4 text-[12px] text-[var(--fg-muted)]">
              Backends live:{" "}
              {liveBackends.map(backendLabel).join(" · ")}
            </p>
          )}
        </section>

        {/* Sharing */}
        <section>
          <h2 className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
            Sharing now
          </h2>
          {!live && !liveError && (
            <div className="space-y-2">
              <div className="h-12 animate-pulse rounded-lg bg-[var(--bg-elev)]" />
              <div className="h-12 animate-pulse rounded-lg bg-[var(--bg-elev)]" />
            </div>
          )}
          {live && sharingNow.length === 0 && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-6 text-center text-[12px] text-[var(--fg-muted)]">
              {meshLive
                ? "Peers online but none serving a model yet."
                : "No contributors serving — see milestones for last win."}
            </div>
          )}
          {sharingNow.length > 0 && (
            <div className="space-y-2">
              {sharingNow.map((n) => (
                <SharingRow key={n.id} node={n} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
