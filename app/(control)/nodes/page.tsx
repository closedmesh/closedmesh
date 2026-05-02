"use client";

import { PageHeader } from "../../components/PageHeader";
import { RemoteInstall } from "../../components/RemoteInstall";
import { useMeshStatus, type NodeSummary } from "../../lib/use-mesh-status";
import { nodeDisplayState } from "../../lib/node-display-state";

const BACKEND_LABEL: Record<string, string> = {
  metal: "Apple Metal",
  cuda: "NVIDIA CUDA",
  rocm: "AMD ROCm",
  vulkan: "Vulkan",
  cpu: "CPU",
};

export default function NodesPage() {
  const mesh = useMeshStatus();

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Mesh"
        subtitle="Every machine sharing capacity with you."
      />

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
          <RemoteInstall />

          <NodesTable
            nodes={mesh.nodes}
            loading={mesh.loading}
            online={mesh.online}
          />
        </div>
      </main>
    </div>
  );
}

function NodesTable({
  nodes,
  loading,
  online,
}: {
  nodes: NodeSummary[];
  loading: boolean;
  online: boolean;
}) {
  if (loading) {
    return (
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-8 text-center text-sm text-[var(--fg-muted)]">
        Loading mesh…
      </section>
    );
  }
  if (!online || nodes.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-elev)]/50 p-10 text-center">
        <div className="text-base font-semibold tracking-tight text-[var(--fg)]">
          No machines connected yet
        </div>
        <div className="mx-auto mt-1.5 max-w-md text-sm text-[var(--fg-muted)]">
          Start ClosedMesh on this Mac from the Dashboard, or add a remote
          machine above.
        </div>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)]">
      <div className="border-b border-[var(--border)] px-5 py-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
          Connected machines
        </div>
        <div className="text-sm font-semibold tracking-tight text-[var(--fg)]">
          {nodes.length} {nodes.length === 1 ? "machine" : "machines"} online
        </div>
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {nodes.map((n) => (
          <NodeRow key={n.id} node={n} />
        ))}
      </ul>
    </section>
  );
}

function NodeRow({ node }: { node: NodeSummary }) {
  const isEntry = node.hostname?.startsWith("ip-") ?? false;
  const cap = node.capability;
  const backend = BACKEND_LABEL[cap.backend] ?? cap.backend;
  const vram = cap.vramGb || node.vramGb;
  const models = node.servingModels;
  const display = nodeDisplayState(node);
  const stateLabel = display.label;
  const stateColor = display.badge;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--fg)]">
            {isEntry ? "Entry node" : (node.hostname ?? node.id.slice(0, 10))}
          </span>
          {node.isSelf && (
            <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev-2)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--fg-muted)]">
              this Mac
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
          {isEntry
            ? "mesh.closedmesh.com · always-on gateway"
            : `${backend} · ${vram ? `${vram.toFixed(1)} GB memory` : "memory unknown"}`}
          {/* Runtime version — same rationale as on the public status
              page. Knowing the version is the difference between "the
              runtime is broken" and "this peer just needs to update". */}
          {node.version && (
            <span className="ml-2 font-mono text-[10px] tabular-nums">
              · v{node.version}
            </span>
          )}
        </div>
        {!isEntry && models.length > 0 && (
          <div className="mt-1 truncate font-mono text-[10px] text-[var(--fg-muted)]">
            {models.join(", ")}
          </div>
        )}
      </div>
      <span
        className={
          "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium " +
          stateColor
        }
      >
        {stateLabel}
      </span>
    </li>
  );
}
