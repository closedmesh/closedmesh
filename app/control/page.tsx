"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMeshStatus, type NodeSummary } from "../lib/use-mesh-status";

type Status = {
  available: boolean;
  binPath: string | null;
  service:
    | { state: "running"; pid: number | null }
    | { state: "stopped" }
    | { state: "unknown"; reason: string }
    | { state: "unavailable" };
  publicDeployment: boolean;
};

type ApiResp = { ok: boolean; message: string; output?: string };

type Tab = "service" | "nodes";

export default function ControlPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("service");
  const mesh = useMeshStatus();
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        fetch("/api/control/status", { cache: "no-store" }).then(
          (r) => r.json() as Promise<Status>,
        ),
        fetch("/api/control/logs", { cache: "no-store" }).then(
          (r) =>
            r.json() as Promise<{
              ok: boolean;
              stdout?: string;
              stderr?: string;
            }>,
        ),
      ]);
      setStatus(s);
      if (l.ok) setLogs({ stdout: l.stdout ?? "", stderr: l.stderr ?? "" });
    } catch {
      // network/transient — keep last good values
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshTimer.current = setInterval(refresh, 4000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [refresh]);

  const act = async (verb: "start" | "stop") => {
    setBusy(verb);
    setToast(null);
    try {
      const res = await fetch(`/api/control/${verb}`, { method: "POST" });
      const data = (await res.json()) as ApiResp;
      setToast(data.message);
      await refresh();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  };

  if (status?.publicDeployment) {
    return <PublicNotice />;
  }
  if (status && !status.available) {
    return <NotInstalled />;
  }

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              ClosedMesh control
            </h1>
            <p className="text-sm text-[var(--fg-muted)]">
              Local LLM mesh on this Mac.
            </p>
          </div>
          <a
            href="/"
            className="text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Open chat →
          </a>
        </header>

        <nav className="mb-6 flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-1 text-sm">
          <TabButton
            active={tab === "service"}
            onClick={() => setTab("service")}
          >
            Service
          </TabButton>
          <TabButton active={tab === "nodes"} onClick={() => setTab("nodes")}>
            Nodes
            {mesh.nodes.length > 0 && (
              <span className="ml-2 rounded bg-[var(--bg-elev-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-muted)]">
                {mesh.nodes.length}
              </span>
            )}
          </TabButton>
        </nav>

        {tab === "nodes" ? (
          <NodesTab
            nodes={mesh.nodes}
            loading={mesh.loading}
            online={mesh.online}
          />
        ) : (
          <ServiceTab
            status={status}
            busy={busy}
            toast={toast}
            logs={logs}
            refresh={refresh}
            act={act}
          />
        )}

        <footer className="mt-8 text-center text-[11px] text-[var(--fg-muted)]">
          Logs from <code>~/Library/Logs/closedmesh/</code>. State refreshed
          every 4 seconds.
        </footer>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition " +
        (active
          ? "bg-[var(--bg-elev-2)] text-[var(--fg)]"
          : "text-[var(--fg-muted)] hover:text-[var(--fg)]")
      }
    >
      {children}
    </button>
  );
}

function ServiceTab({
  status,
  busy,
  toast,
  logs,
  refresh,
  act,
}: {
  status: Status | null;
  busy: "start" | "stop" | null;
  toast: string | null;
  logs: { stdout: string; stderr: string } | null;
  refresh: () => void;
  act: (verb: "start" | "stop") => void;
}) {
  const running = status?.service.state === "running";
  const stopped = status?.service.state === "stopped";
  return (
    <>
      <section className="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={
                "inline-block h-3 w-3 rounded-full " +
                (running
                  ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]"
                  : stopped
                    ? "bg-zinc-500"
                    : "bg-amber-400")
              }
            />
            <div>
              <div className="text-sm font-medium">
                {running
                  ? "Running"
                  : stopped
                    ? "Stopped"
                    : status?.service.state === "unknown"
                      ? "Unknown"
                      : "Loading…"}
              </div>
              <div className="text-xs text-[var(--fg-muted)]">
                {running && status?.service.state === "running"
                  ? `pid ${status.service.pid ?? "?"} · auto-restart on crash`
                  : status?.service.state === "unknown"
                    ? status.service.reason
                    : "Not currently serving inference."}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              disabled={busy !== null || running}
              onClick={() => act("start")}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "start" ? "Starting…" : "Start"}
            </button>
            <button
              disabled={busy !== null || stopped}
              onClick={() => act("stop")}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
          </div>
        </div>

        {toast && (
          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 text-xs text-[var(--fg-muted)]">
            {toast}
          </div>
        )}
      </section>

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label="Binary" value={status?.binPath ?? "—"} mono />
        <Stat
          label="Service label"
          value="dev.closedmesh.closedmesh"
          mono
        />
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent logs</h2>
          <button
            onClick={refresh}
            className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Refresh
          </button>
        </div>
        <LogPane title="stdout" body={logs?.stdout ?? ""} />
        <div className="mt-3" />
        <LogPane title="stderr" body={logs?.stderr ?? ""} />
      </section>
    </>
  );
}

function NodesTab({
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
        Loading mesh nodes…
      </section>
    );
  }
  if (!online || nodes.length === 0) {
    return (
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-8 text-center text-sm text-[var(--fg-muted)]">
        <p>No mesh nodes visible.</p>
        <p className="mt-1 text-xs">
          Start the service from the Service tab — once the runtime opens its
          admin port (default 3131), nodes appear here.
        </p>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--bg-elev-2)] text-left text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
          <tr>
            <th className="px-4 py-2">Node</th>
            <th className="px-4 py-2">Backend</th>
            <th className="px-4 py-2">VRAM</th>
            <th className="px-4 py-2">Class</th>
            <th className="px-4 py-2">Role</th>
            <th className="px-4 py-2">Models</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <NodeRow key={n.id} node={n} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

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

function NodeRow({ node }: { node: NodeSummary }) {
  const cap = node.capability;
  const vendor = VENDOR_LABEL[cap.vendor] ?? cap.vendor;
  const backend = BACKEND_LABEL[cap.backend] ?? cap.backend;
  const vram = cap.vramGb || node.vramGb;
  const models =
    node.servingModels.length > 0 ? node.servingModels.join(", ") : "—";
  return (
    <tr className="border-t border-[var(--border)] text-[var(--fg)]">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {node.hostname ?? node.id.slice(0, 8)}
          </span>
          {node.isSelf && (
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-muted)]">
              you
            </span>
          )}
        </div>
        <div className="font-mono text-[10px] text-[var(--fg-muted)]">
          {node.id.slice(0, 16)}
        </div>
      </td>
      <td className="px-4 py-2.5">
        <div className="font-mono text-xs">{backend}</div>
        <div className="text-[10px] text-[var(--fg-muted)]">{vendor}</div>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">
        {vram ? `${vram.toFixed(1)} GB` : "—"}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs uppercase">
        {cap.computeClass}
      </td>
      <td className="px-4 py-2.5 text-xs">
        <span
          className={
            "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider " +
            (node.state === "serving"
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
              : node.state === "loading"
                ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                : "border-zinc-400/40 bg-zinc-400/10 text-zinc-300")
          }
        >
          {node.role}
        </span>
      </td>
      <td className="max-w-[200px] truncate px-4 py-2.5 font-mono text-[11px] text-[var(--fg-muted)]" title={models}>
        {models}
      </td>
    </tr>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
        {label}
      </div>
      <div
        className={
          "mt-1 truncate text-sm " +
          (mono ? "font-mono text-[13px] text-[var(--fg)]" : "text-[var(--fg)]")
        }
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function LogPane({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
        {title}
      </div>
      <pre className="max-h-56 overflow-auto rounded-lg border border-[var(--border)] bg-black/40 p-3 text-[11px] leading-5 text-[var(--fg-muted)] scrollbar-thin">
{body || "(empty)"}
      </pre>
    </div>
  );
}

function PublicNotice() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-xl px-4 py-20 text-center">
        <h1 className="text-2xl font-semibold">Run it on your Mac</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          The control panel is only available when ClosedMesh is running
          locally. Install it on your Mac, then open{" "}
          <code>http://localhost:3000/control</code>.
        </p>
        <pre className="mx-auto mt-6 inline-block rounded-lg border border-[var(--border)] bg-black/40 px-4 py-3 text-left text-xs text-[var(--fg-muted)]">
          curl -fsSL https://closedmesh.com/install | sh -s -- --service
        </pre>
        <div className="mt-6">
          <a
            href="/"
            className="text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            ← back to chat
          </a>
        </div>
      </div>
    </div>
  );
}

function NotInstalled() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-xl px-4 py-20 text-center">
        <h1 className="text-2xl font-semibold">
          ClosedMesh isn&apos;t installed
        </h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          We couldn&apos;t find the <code>closedmesh</code> binary in the usual
          places (<code>~/.local/bin</code>, <code>/opt/homebrew/bin</code>,{" "}
          <code>/usr/local/bin</code>). Install it and reload this page.
        </p>
        <pre className="mx-auto mt-6 inline-block rounded-lg border border-[var(--border)] bg-black/40 px-4 py-3 text-left text-xs text-[var(--fg-muted)]">
          curl -fsSL https://closedmesh.com/install | sh -s -- --service
        </pre>
        <p className="mt-4 text-xs text-[var(--fg-muted)]">
          Or set <code>CLOSEDMESH_BIN=/path/to/closedmesh</code> if it&apos;s
          installed somewhere unusual.
        </p>
      </div>
    </div>
  );
}
