"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { Setup } from "../../components/Setup";
import { useMeshStatus, type NodeSummary } from "../../lib/use-mesh-status";

type ServiceState =
  | { state: "running"; pid: number | null }
  | { state: "stopped" }
  | { state: "unknown"; reason: string }
  | { state: "unavailable" };

type ControlStatus = {
  available: boolean;
  binPath: string | null;
  service: ServiceState;
  publicDeployment: boolean;
};

type RepairIssue = {
  kind:
    | "private-only-launchd"
    | "private-only-systemd"
    | "private-only-schtasks";
  message: string;
  unit: string;
  fixable: boolean;
};

type RepairResp = {
  ok: boolean;
  issues: RepairIssue[];
  applied?: Array<{ kind: RepairIssue["kind"]; ok: boolean; message: string }>;
};

const BACKEND_LABEL: Record<string, string> = {
  metal: "Apple Metal",
  cuda: "NVIDIA CUDA",
  rocm: "AMD ROCm",
  vulkan: "Vulkan",
  cpu: "CPU",
};

export default function DashboardPage() {
  const mesh = useMeshStatus();
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [busy, setBusy] = useState<
    "start" | "stop" | "invite" | "repair" | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const [repair, setRepair] = useState<RepairResp | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/control/status", { cache: "no-store" });
      const data = (await res.json()) as ControlStatus;
      setControl(data);
    } catch {
      // transient — keep last good
    }
  }, []);

  // Cheap diagnostic poll — runs once at mount and after every repair
  // attempt. Doesn't piggyback on /api/control/status because we don't
  // want to read the launchd plist on every 4-second tick.
  const refreshRepair = useCallback(async () => {
    try {
      const res = await fetch("/api/control/repair", { cache: "no-store" });
      const data = (await res.json()) as RepairResp;
      setRepair(data);
    } catch {
      // controller off — banner just stays hidden
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshRepair();
    refreshTimer.current = setInterval(refresh, 4000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [refresh, refreshRepair]);

  const runRepair = useCallback(async () => {
    setBusy("repair");
    setToast(null);
    try {
      const res = await fetch("/api/control/repair", { method: "POST" });
      const data = (await res.json()) as RepairResp;
      setRepair(data);
      const summary = (data.applied ?? [])
        .map((a) => a.message)
        .filter(Boolean)
        .join(" ");
      setToast(summary || "Repair complete.");
      await refresh();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const act = useCallback(
    async (verb: "start" | "stop") => {
      setBusy(verb);
      setToast(null);
      try {
        const res = await fetch(`/api/control/${verb}`, { method: "POST" });
        const data = (await res.json()) as { ok: boolean; message: string };
        setToast(data.message);
        await refresh();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "request failed");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

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
        setToast("Invite link copied. Paste it to a teammate to add their machine.");
      } else {
        setToast(data.message ?? "Couldn't create an invite. Try again in a moment.");
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const selfNode = mesh.nodes.find((n) => n.isSelf) ?? null;
  const peers = mesh.nodes.filter((n) => !n.isSelf);
  const totalVram = mesh.nodes.reduce(
    (sum, n) => sum + (n.capability.vramGb || n.vramGb || 0),
    0,
  );
  const running = control?.service.state === "running";
  const stopped = control?.service.state === "stopped";

  if (control?.publicDeployment && !mesh.online && !mesh.loading) {
    return <PublicNoMesh />;
  }
  if (control && !control.available && !control.publicDeployment) {
    return <Setup onInstalled={refresh} />;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Dashboard"
        subtitle="Your machine, the mesh, and the models you're running."
      />

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
          {repair && repair.issues.length > 0 && (
            <RepairBanner
              issues={repair.issues}
              busy={busy === "repair"}
              onRepair={runRepair}
            />
          )}

          <ThisNodeCard
            self={selfNode}
            running={running}
            stopped={stopped}
            busy={busy}
            onStart={() => act("start")}
            onStop={() => act("stop")}
          />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <SummaryStat
              label="Online machines"
              value={mesh.online ? String(mesh.nodeCount) : "0"}
              hint={
                peers.length > 0
                  ? `${peers.length} teammate${peers.length === 1 ? "" : "s"} sharing capacity`
                  : "you're alone — invite someone to join"
              }
              href="/nodes"
            />
            <SummaryStat
              label="Pooled memory"
              value={totalVram > 0 ? `${totalVram.toFixed(1)} GB` : "—"}
              hint="across every online machine"
              href="/nodes"
            />
            <SummaryStat
              label="Models loaded"
              value={String(mesh.models.length)}
              hint={
                mesh.models[0] ? mesh.models[0] : "no models loaded yet"
              }
              href="/models"
            />
          </div>

          <QuickActions
            running={running}
            busy={busy}
            onCopyInvite={copyInvite}
            toast={toast}
          />

          {peers.length > 0 && <PeersPreview peers={peers} />}
        </div>
      </main>
    </div>
  );
}

function RepairBanner({
  issues,
  busy,
  onRepair,
}: {
  issues: RepairIssue[];
  busy: boolean;
  onRepair: () => void;
}) {
  const fixable = issues.some((i) => i.fixable);
  return (
    <section className="rounded-2xl border border-amber-400/40 bg-amber-400/5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <div className="text-[10px] uppercase tracking-[0.16em] text-amber-300">
            Heads-up — autostart needs a fix
          </div>
          <ul className="mt-1.5 space-y-1.5 text-sm text-[var(--fg)]">
            {issues.map((i) => (
              <li key={i.kind}>
                <span>{i.message}</span>
                <span className="ml-1 font-mono text-[11px] text-[var(--fg-muted)]">
                  ({i.unit})
                </span>
              </li>
            ))}
          </ul>
        </div>
        {fixable && (
          <button
            onClick={onRepair}
            disabled={busy}
            className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Repairing…" : "Repair now"}
          </button>
        )}
      </div>
    </section>
  );
}

function ThisNodeCard({
  self,
  running,
  stopped,
  busy,
  onStart,
  onStop,
}: {
  self: NodeSummary | null;
  running: boolean;
  stopped: boolean;
  busy: "start" | "stop" | "invite" | "repair" | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const cap = self?.capability;
  const backend = cap ? BACKEND_LABEL[cap.backend] ?? cap.backend : null;
  const vram = cap?.vramGb ?? self?.vramGb ?? 0;
  const loaded = cap?.loadedModels ?? [];

  // The runtime can be "running" without actually serving traffic — that
  // happens when the autostart unit boots `closedmesh serve --auto` but
  // no model is configured in ~/.closedmesh/config.toml yet. Surface that
  // state honestly instead of telling the user they're "sharing" when
  // they aren't yet.
  const statusText = running
    ? loaded.length > 0
      ? "Sharing this machine with your mesh"
      : "Running, but no model loaded yet — pick one from Models"
    : stopped
      ? "Not running. Start to share this machine."
      : "Checking status…";

  return (
    <section className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(255,122,69,0.18), transparent 70%)",
        }}
      />
      <div className="relative flex flex-wrap items-start justify-between gap-5">
        <div className="flex items-start gap-3.5">
          <span
            className={
              "mt-1 inline-block h-3 w-3 rounded-full " +
              (running
                ? "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.7)]"
                : stopped
                  ? "bg-zinc-500"
                  : "bg-amber-400")
            }
          />
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
              This machine
            </div>
            <div className="mt-0.5 text-xl font-semibold tracking-tight">
              {self?.hostname ?? "Your computer"}
            </div>
            <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
              {statusText}
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          {running ? (
            <button
              disabled={busy !== null || stopped}
              onClick={onStop}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-2 text-sm font-medium text-[var(--fg)] transition hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "stop" ? "Stopping…" : "Stop sharing"}
            </button>
          ) : (
            <button
              disabled={busy !== null || running}
              onClick={onStart}
              className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "start" ? "Starting…" : "Start sharing"}
            </button>
          )}
        </div>
      </div>

      <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Hardware" value={backend ?? "—"} accent={!!backend} />
        <Stat
          label="Memory"
          value={vram ? `${vram.toFixed(1)} GB` : "—"}
        />
        <Stat
          label="Models loaded"
          value={loaded.length > 0 ? String(loaded.length) : "0"}
        />
      </div>

      {loaded.length > 0 && (
        <div className="relative mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
            Currently loaded
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {loaded.map((m) => (
              <span
                key={m}
                className="rounded-full border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2 py-0.5 font-mono text-[11px] text-[var(--accent)]"
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryStat({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 transition hover:border-[var(--accent)]/40 hover:bg-[var(--bg-elev-2)]"
    >
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-[var(--fg)]">
        {value}
      </div>
      <div className="mt-1 truncate text-[11px] text-[var(--fg-muted)] group-hover:text-[var(--fg)]">
        {hint}
      </div>
    </Link>
  );
}

function QuickActions({
  running,
  busy,
  onCopyInvite,
  toast,
}: {
  running: boolean;
  busy: "start" | "stop" | "invite" | "repair" | null;
  onCopyInvite: () => void;
  toast: string | null;
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="mb-3 text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
        What now?
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ActionButton
          onClick={onCopyInvite}
          disabled={!running || busy !== null}
          title={
            running
              ? "Copy a join link to share with a teammate"
              : "Start sharing first"
          }
        >
          {busy === "invite" ? "Creating…" : "Invite a teammate"}
        </ActionButton>
        <ActionLink href="/chat">Open chat</ActionLink>
        <ActionLink href="/models">Browse models</ActionLink>
        <ActionLink href="/nodes">Add a remote machine</ActionLink>
      </div>
      {toast && (
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 text-xs text-[var(--fg-muted)]">
          {toast}
        </div>
      )}
    </section>
  );
}

function ActionButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5 text-xs font-medium text-[var(--fg)] transition hover:border-[var(--accent)]/40 hover:bg-[var(--bg-elev)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ActionLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5 text-center text-xs font-medium text-[var(--fg)] transition hover:border-[var(--accent)]/40 hover:bg-[var(--bg-elev)]"
    >
      {children}
    </Link>
  );
}

function PeersPreview({ peers }: { peers: NodeSummary[] }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
          Sharing with
        </div>
        <Link
          href="/nodes"
          className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          View all →
        </Link>
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {peers.slice(0, 4).map((p) => (
          <li key={p.id} className="flex items-center justify-between py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-[var(--fg)]">
                {p.hostname ?? p.id.slice(0, 12)}
              </div>
              <div className="text-[11px] text-[var(--fg-muted)]">
                {(BACKEND_LABEL[p.capability.backend] ?? p.capability.backend) +
                  " · " +
                  (p.capability.vramGb || p.vramGb).toFixed(1) +
                  " GB"}
              </div>
            </div>
            <span
              className={
                "rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                (p.state === "serving"
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                  : "border-zinc-400/40 bg-zinc-400/10 text-zinc-300")
              }
            >
              {p.state === "serving" ? "Serving" : p.role}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
        {label}
      </div>
      <div
        className={
          "mt-0.5 truncate text-sm font-medium " +
          (accent ? "text-[var(--accent)]" : "text-[var(--fg)]")
        }
      >
        {value}
      </div>
    </div>
  );
}

function PublicNoMesh() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--bg)] p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, rgba(255,122,69,0.18), transparent 70%)",
        }}
      />
      <div className="relative max-w-lg text-center">
        <h1 className="text-balance text-3xl font-semibold tracking-tight">
          You don&apos;t have a mesh yet.
        </h1>
        <p className="mt-3 text-pretty text-sm text-[var(--fg-muted)]">
          ClosedMesh runs on machines you own. Install the desktop app and
          this dashboard lights up — chat, mesh, models, all in one place.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/download"
            className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)]"
          >
            Download
          </Link>
          <Link
            href="/about"
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-2.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-elev-2)]"
          >
            How it works
          </Link>
        </div>
      </div>
    </div>
  );
}
