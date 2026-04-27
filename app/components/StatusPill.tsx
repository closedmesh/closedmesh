"use client";

import { useState } from "react";
import { useMeshStatus, type NodeSummary } from "../lib/use-mesh-status";

const BACKEND_LABEL: Record<string, string> = {
  metal: "Metal",
  cuda: "CUDA",
  rocm: "ROCm",
  vulkan: "Vulkan",
  cpu: "CPU",
};

const VENDOR_LABEL: Record<string, string> = {
  apple: "Apple",
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  none: "—",
};

function formatBackend(b: string): string {
  return BACKEND_LABEL[b] ?? b;
}

function formatVendor(v: string): string {
  return VENDOR_LABEL[v] ?? v;
}

function backendBadgeColor(backend: string): string {
  switch (backend) {
    case "metal":
      return "bg-amber-400/20 text-amber-300 border-amber-400/40";
    case "cuda":
      return "bg-emerald-400/20 text-emerald-300 border-emerald-400/40";
    case "rocm":
      return "bg-rose-400/20 text-rose-300 border-rose-400/40";
    case "vulkan":
      return "bg-sky-400/20 text-sky-300 border-sky-400/40";
    case "cpu":
      return "bg-zinc-400/20 text-zinc-300 border-zinc-400/40";
    default:
      return "bg-zinc-400/20 text-zinc-300 border-zinc-400/40";
  }
}

function NodeRow({ node }: { node: NodeSummary }) {
  const cap = node.capability;
  const subtitle = [formatVendor(cap.vendor), `${cap.vramGb || node.vramGb} GB`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2 last:border-b-0 last:pb-0 first:pt-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[var(--fg)]">
            {node.hostname ?? node.id.slice(0, 8)}
          </span>
          {node.isSelf && (
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-muted)]">
              you
            </span>
          )}
        </div>
        <div className="font-mono text-[10px] text-[var(--fg-muted)]">
          {subtitle}
        </div>
        {node.servingModels.length > 0 && (
          <div className="mt-1 truncate font-mono text-[10px] text-[var(--fg-muted)]">
            {node.servingModels.join(", ")}
          </div>
        )}
      </div>
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${backendBadgeColor(
          cap.backend,
        )}`}
        title={`${formatBackend(cap.backend)} · ${cap.computeClass}`}
      >
        {formatBackend(cap.backend)}
      </span>
    </div>
  );
}

export function StatusPill() {
  const status = useMeshStatus();
  const [hover, setHover] = useState(false);
  const dotColor = status.online ? "bg-emerald-400" : "bg-zinc-500";
  const label = status.online
    ? `${status.nodeCount} ${status.nodeCount === 1 ? "node" : "nodes"} online`
    : "mesh offline";
  const model = status.models[0];
  const showPanel = hover && status.online && status.nodes.length > 0;

  return (
    <div
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-[11px] text-[var(--fg-muted)]">
        <span
          className={`relative inline-block h-1.5 w-1.5 rounded-full ${dotColor}`}
        >
          {status.online && (
            <span className="absolute inset-0 rounded-full bg-emerald-400 pulse-soft" />
          )}
        </span>
        <span className="font-medium text-[var(--fg)]">{label}</span>
        {model && (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono text-[10px] tracking-tight">
              {model}
            </span>
          </>
        )}
      </div>
      {showPanel && (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[11px] shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
            <span>Mesh nodes</span>
            <span>{status.nodes.length}</span>
          </div>
          {status.nodes.map((n) => (
            <NodeRow key={n.id} node={n} />
          ))}
        </div>
      )}
    </div>
  );
}
