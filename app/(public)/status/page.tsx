"use client";

import { useEffect, useRef, useState } from "react";
import { PublicHeader } from "../../components/PublicHeader";
import { MeshLiveStatus } from "../../components/MeshLiveStatus";
import { nodeDisplayState } from "../../lib/node-display-state";
import type { NodeSummary } from "../../lib/use-mesh-status";

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

function NodeCard({
  node,
  history,
}: {
  node: MeshNode;
  history?: NodeHistory;
}) {
  const hostname = prettyHostname(node.hostname);
  const isEntryNode = node.hostname?.startsWith("ip-");
  const cap = node.capability;
  const isServing = node.servingModels.length > 0;

  // Apply history-based smoothing: if this node was in a "good" state
  // (Ready or Serving) within the last 30 seconds, treat a transient
  // current "Loading" or "Idle" snapshot as the steady-state — re-elections
  // briefly flip nodes through these intermediate states even when they're
  // healthy.
  const recentlyGood =
    history?.lastGoodAt && Date.now() - history.lastGoodAt < 30_000;
  const smoothedNode: MeshNode =
    recentlyGood && (node.state === "loading" || node.state === "standby")
      ? {
          ...node,
          // Force Ready by ensuring servingModels is non-empty if we know it
          // was good recently. Doesn't lie about model identity — only used
          // by nodeDisplayState to pick the color.
          state: "standby",
          servingModels:
            node.servingModels.length > 0 ? node.servingModels : ["(reloading)"],
        }
      : node;
  const { dot, label: stateLabel } = nodeDisplayState(smoothedNode);

  // "Online for Xm" when we have history. Tells the user this isn't a
  // flapping node — it's been in the mesh consistently for a while.
  const onlineFor =
    history && !isEntryNode
      ? formatDuration(Date.now() - history.firstSeen)
      : null;

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
            <div className="text-sm font-medium text-[var(--fg)] truncate">
              {isEntryNode ? "Entry node" : hostname}
            </div>
            <div className="text-[11px] text-[var(--fg-muted)] truncate">
              {isEntryNode
                ? "mesh.closedmesh.com · always-on gateway"
                : onlineFor
                  ? `${stateLabel} · online ${onlineFor} · ${node.id.slice(0, 10)}`
                  : `${stateLabel} · ${node.id.slice(0, 10)}`}
            </div>
          </div>
        </div>
        {/* Backend chip */}
        {!isEntryNode && (
          <span
            className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${backendColor(cap.backend)}`}
          >
            {backendLabel(cap.backend, cap.vendor)}
          </span>
        )}
      </div>

      {/* Hardware row */}
      {!isEntryNode && (
        <div className="flex items-center gap-4 text-[12px] text-[var(--fg-muted)]">
          {cap.vramGb > 0 && (
            <span>
              <span className="font-medium text-[var(--fg)]">{cap.vramGb} GB</span> VRAM
            </span>
          )}
          {cap.vramGb === 0 && cap.backend === "cpu" && (
            <span>CPU inference</span>
          )}
        </div>
      )}

      {/* Models */}
      {node.servingModels.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {node.servingModels.map((m) => (
            <span
              key={m}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg)]"
            >
              {prettyModelName(m)}
            </span>
          ))}
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

function SummaryBar({ status }: { status: MeshStatus }) {
  // "Sharing" = any non-entry node that's connected to the mesh. Used to
  // be filtered to `state === "serving"` which only counted nodes literally
  // executing a request that millisecond — almost always 0, even on a
  // healthy mesh — making it look like nothing was happening.
  const totalNodes = status.nodes.filter((n) => !n.hostname?.startsWith("ip-")).length;
  const sharingNodes = status.nodes.filter(
    (n) =>
      !n.hostname?.startsWith("ip-") &&
      ((n.capability?.loadedModels?.length ?? 0) > 0 ||
        n.servingModels.length > 0 ||
        n.state === "serving"),
  ).length;
  const models = status.models;

  return (
    <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]">
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
 * Track per-node history across polls so we don't show a healthy node as
 * "Loading" or "Idle" just because the polling instant happened to catch
 * a transient state. The mesh is constantly re-electing hosts and reloading
 * models, so a single 20s snapshot of "Loading" or "Standby" is misleading
 * — the node may have been "Ready" for the previous 5 minutes and just
 * blipped through "Loading" for 200ms during a re-election.
 */
type NodeHistory = {
  /** First time we saw this node id since this page was opened. */
  firstSeen: number;
  /** Last poll we saw this node id at all. */
  lastSeen: number;
  /** Last time the node was in a "good" state (Ready or Serving). */
  lastGoodAt: number | null;
};

export default function StatusPage() {
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);
  const historyRef = useRef<Map<string, NodeHistory>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MeshStatus;
        if (cancelled) return;

        // Record what we just saw for each node so the per-node card can
        // distinguish "freshly joined and loading" from "been here for 5
        // minutes and currently re-loading after an election".
        const now = Date.now();
        const history = historyRef.current;
        for (const node of data.nodes) {
          const prior = history.get(node.id) ?? {
            firstSeen: now,
            lastSeen: now,
            lastGoodAt: null,
          };
          const isGood =
            node.state === "serving" ||
            (node.capability?.loadedModels?.length ?? 0) > 0 ||
            node.servingModels.length > 0;
          history.set(node.id, {
            firstSeen: prior.firstSeen,
            lastSeen: now,
            lastGoodAt: isGood ? now : prior.lastGoodAt,
          });
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

  // Sort nodes: entry node last, serving nodes first
  const sortedNodes = status
    ? [...status.nodes].sort((a, b) => {
        const aEntry = a.hostname?.startsWith("ip-") ? 1 : 0;
        const bEntry = b.hostname?.startsWith("ip-") ? 1 : 0;
        if (aEntry !== bEntry) return aEntry - bEntry;
        const aServing = a.servingModels.length > 0 ? 0 : 1;
        const bServing = b.servingModels.length > 0 ? 0 : 1;
        return aServing - bServing;
      })
    : [];

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
            Machines connected to the ClosedMesh network and the models they&apos;re currently serving.
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

        {/* Content */}
        {status && (
          <div className="space-y-6">
            <SummaryBar status={status} />

            {/* Models list */}
            {status.models.length > 0 && (
              <div>
                <div className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                  Available models
                </div>
                <div className="flex flex-wrap gap-2">
                  {status.models.map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[12px] font-medium text-[var(--fg)]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      {prettyModelName(m)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Node cards */}
            <div>
              <div className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                Connected nodes
              </div>
              <div className="space-y-3">
                {sortedNodes.map((node) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    history={historyRef.current.get(node.id)}
                  />
                ))}
              </div>
            </div>

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
