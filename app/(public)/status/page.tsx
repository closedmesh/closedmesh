"use client";

import { useEffect, useState } from "react";
import { PublicHeader } from "../../components/PublicHeader";
import { MeshLiveStatus } from "../../components/MeshLiveStatus";

type NodeCapability = {
  backend: string;
  vendor: string;
  computeClass: string;
  vramGb: number;
  loadedModels: string[];
};

type MeshNode = {
  id: string;
  hostname: string | null;
  isSelf: boolean;
  role: string;
  state: string;
  vramGb: number;
  servingModels: string[];
  capability: NodeCapability;
};

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

function stateColor(state: string): { dot: string; label: string } {
  if (state === "serving") return { dot: "bg-emerald-400", label: "Serving" };
  if (state === "client") return { dot: "bg-sky-400", label: "Gateway" };
  if (state === "standby") return { dot: "bg-yellow-400", label: "Standby" };
  return { dot: "bg-[var(--fg-muted)]", label: state };
}

// ---------------------------------------------------------------------------
// Node card
// ---------------------------------------------------------------------------

function NodeCard({ node }: { node: MeshNode }) {
  const hostname = prettyHostname(node.hostname);
  const isEntryNode = node.hostname?.startsWith("ip-");
  const { dot, label: stateLabel } = stateColor(node.state);
  const cap = node.capability;
  const isServing = node.servingModels.length > 0;

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
              {isEntryNode ? "mesh.closedmesh.com · always-on gateway" : `${stateLabel} · ${node.id}`}
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
  const workers = status.nodes.filter((n) => !n.isSelf && n.state === "serving").length;
  const totalNodes = status.nodes.filter((n) => !n.hostname?.startsWith("ip-")).length;
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
          {workers}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {workers === 1 ? "node serving" : "nodes serving"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function StatusPage() {
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MeshStatus;
        if (cancelled) return;
        setStatus(data);
        setLastUpdated(new Date());
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, 20_000);
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
                  <NodeCard key={node.id} node={node} />
                ))}
              </div>
            </div>

            {/* Footer note */}
            <p className="text-center text-[11px] text-[var(--fg-muted)]">
              Refreshes every 20 seconds &middot;{" "}
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
