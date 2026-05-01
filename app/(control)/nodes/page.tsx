"use client";

import { useCallback, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { RemoteInstall } from "../../components/RemoteInstall";
import { useMeshStatus, type NodeSummary } from "../../lib/use-mesh-status";

const BACKEND_LABEL: Record<string, string> = {
  metal: "Apple Metal",
  cuda: "NVIDIA CUDA",
  rocm: "AMD ROCm",
  vulkan: "Vulkan",
  cpu: "CPU",
};

export default function NodesPage() {
  const mesh = useMeshStatus();
  const [busy, setBusy] = useState<"invite" | "join" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [joinToken, setJoinToken] = useState("");

  const copyInvite = useCallback(async () => {
    setBusy("invite");
    setToast(null);
    try {
      const res = await fetch("/api/control/invite", { method: "POST" });
      const data = (await res.json()) as {
        ok: boolean;
        token?: string;
        message?: string;
      };
      if (data.ok && data.token) {
        await navigator.clipboard.writeText(data.token);
        setToast("Invite copied. Send it to a teammate.");
      } else {
        setToast(data.message ?? "Couldn't create an invite.");
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const join = useCallback(async () => {
    const token = joinToken.trim();
    if (!token) return;
    setBusy("join");
    setToast(null);
    try {
      const res = await fetch("/api/control/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      setToast(data.message);
      if (data.ok) setJoinToken("");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }, [joinToken]);

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Mesh"
        subtitle="Every machine sharing capacity with you. Add more for more speed."
      />

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
          <RemoteInstall />

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <InviteCard busy={busy} onCopy={copyInvite} />
            <JoinCard
              busy={busy}
              token={joinToken}
              onTokenChange={setJoinToken}
              onJoin={join}
            />
          </section>

          {toast && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 text-xs text-[var(--fg-muted)]">
              {toast}
            </div>
          )}

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

function InviteCard({
  busy,
  onCopy,
}: {
  busy: "invite" | "join" | null;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
        Invite a teammate
      </div>
      <div className="mt-1 text-base font-semibold tracking-tight text-[var(--fg)]">
        Add their machine to your mesh
      </div>
      <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
        We&apos;ll generate a one-time link. Anyone you share it with can
        join from their own laptop or workstation.
      </p>
      <button
        onClick={onCopy}
        disabled={busy !== null}
        className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy === "invite" ? "Creating…" : "Copy invite link"}
      </button>
    </div>
  );
}

function JoinCard({
  busy,
  token,
  onTokenChange,
  onJoin,
}: {
  busy: "invite" | "join" | null;
  token: string;
  onTokenChange: (v: string) => void;
  onJoin: () => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
        Join an existing mesh
      </div>
      <div className="mt-1 text-base font-semibold tracking-tight text-[var(--fg)]">
        Got an invite from a teammate?
      </div>
      <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
        Paste their link below. This machine will start serving for their
        mesh.
      </p>
      <div className="mt-4 flex gap-2">
        <input
          type="text"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="paste invite link…"
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 font-mono text-xs text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:border-[var(--accent)]/60 focus:outline-none"
        />
        <button
          onClick={onJoin}
          disabled={busy !== null || !token.trim()}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 text-xs font-medium text-[var(--fg)] hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "join" ? "Joining…" : "Join"}
        </button>
      </div>
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
  const stateLabel =
    node.state === "serving"
      ? "Serving"
      : node.state === "loading"
        ? "Warming up"
        : node.role;
  const stateColor =
    node.state === "serving"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
      : node.state === "loading"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
        : "border-zinc-400/40 bg-zinc-400/10 text-zinc-300";

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
