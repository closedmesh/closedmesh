"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LogLine =
  | { kind: "stdout" | "stderr"; text: string }
  | { kind: "step"; name: string; ok: boolean }
  | { kind: "done"; ok: boolean; code: number; message?: string }
  | { kind: "error"; message: string };

type Phase = "idle" | "running" | "done" | "failed";

type Backend = "auto" | "metal" | "cuda" | "rocm" | "vulkan" | "cpu";

type Form = {
  sshCommand: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  backend: Backend;
};

const DEFAULT_FORM: Form = {
  sshCommand: "",
  host: "",
  user: "root",
  port: "22",
  identityFile: "",
  backend: "auto",
};

type Mode = "paste" | "fields";

export function RemoteInstall({ onInstalled }: { onInstalled?: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("paste");
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const reset = useCallback(() => {
    setPhase("idle");
    setLines([]);
    setError(null);
  }, []);

  const install = useCallback(async () => {
    setPhase("running");
    setLines([]);
    setError(null);

    const body =
      mode === "paste"
        ? {
            sshCommand: form.sshCommand,
            backend: form.backend === "auto" ? undefined : form.backend,
          }
        : {
            host: form.host.trim(),
            user: form.user.trim() || "root",
            port: form.port ? Number(form.port) : 22,
            identityFile: form.identityFile.trim() || undefined,
            backend: form.backend === "auto" ? undefined : form.backend,
          };

    let res: Response;
    try {
      res = await fetch("/api/control/remote-install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : "request failed");
      return;
    }

    if (!res.ok || !res.body) {
      setPhase("failed");
      try {
        const data = (await res.json()) as { message?: string };
        setError(data.message ?? `request returned ${res.status}`);
      } catch {
        setError(`request returned ${res.status}`);
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let okFinal: boolean | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as LogLine;
          setLines((prev) => prev.concat(ev));
          if (ev.kind === "done") okFinal = ev.ok;
          if (ev.kind === "error") {
            okFinal = false;
            setError(ev.message);
          }
        } catch {
          // ignore malformed line
        }
      }
    }

    if (okFinal) {
      setPhase("done");
      onInstalled?.();
    } else {
      setPhase("failed");
    }
  }, [form, mode, onInstalled]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="group relative w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 text-left transition hover:border-[var(--accent)]/40"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-60 transition group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(circle, rgba(255,122,69,0.18), transparent 70%)",
          }}
        />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
              Add a remote machine
            </div>
            <div className="mt-1 text-base font-semibold tracking-tight text-[var(--fg)]">
              Install ClosedMesh on a server you rent or own
            </div>
            <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
              Paste an SSH command — we&apos;ll handle the rest.
            </div>
          </div>
          <span
            aria-hidden
            className="hidden rounded-full border border-[var(--border)] bg-[var(--bg-elev-2)] p-2 text-[var(--accent)] sm:block"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 3.5v9M3.5 8h9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </div>
      </button>
    );
  }

  const canSubmit =
    phase !== "running" &&
    (mode === "paste"
      ? form.sshCommand.trim().length > 0
      : form.host.trim().length > 0);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(255,122,69,0.14), transparent 70%)",
        }}
      />
      <div className="relative mb-4 flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
            Add a remote machine
          </div>
          <div className="mt-0.5 text-base font-semibold tracking-tight text-[var(--fg)]">
            Install ClosedMesh on a server you rent or own
          </div>
        </div>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
          disabled={phase === "running"}
        >
          Close
        </button>
      </div>

      {phase === "idle" && (
        <div className="relative space-y-4">
          <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] p-1 text-xs">
            <ModeButton
              active={mode === "paste"}
              onClick={() => setMode("paste")}
            >
              Paste SSH command
            </ModeButton>
            <ModeButton
              active={mode === "fields"}
              onClick={() => setMode("fields")}
            >
              Fill in fields
            </ModeButton>
          </div>

          {mode === "paste" ? (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
                SSH command
              </label>
              <textarea
                value={form.sshCommand}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sshCommand: e.target.value }))
                }
                placeholder="ssh -p 22 user@host -i ~/.ssh/id_ed25519"
                rows={2}
                className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 font-mono text-xs text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:border-[var(--accent)]/60 focus:outline-none"
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Host"
                placeholder="example.com"
                value={form.host}
                onChange={(v) => setForm((f) => ({ ...f, host: v }))}
              />
              <Field
                label="User"
                placeholder="root"
                value={form.user}
                onChange={(v) => setForm((f) => ({ ...f, user: v }))}
              />
              <Field
                label="Port"
                placeholder="22"
                value={form.port}
                onChange={(v) => setForm((f) => ({ ...f, port: v }))}
              />
              <Field
                label="Identity file (path)"
                placeholder="~/.ssh/id_ed25519"
                value={form.identityFile}
                onChange={(v) => setForm((f) => ({ ...f, identityFile: v }))}
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
              Backend (override)
            </label>
            <select
              value={form.backend}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  backend: e.target.value as Backend,
                }))
              }
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-1.5 text-xs text-[var(--fg)] focus:border-[var(--accent)]/60 focus:outline-none"
            >
              <option value="auto">auto-detect</option>
              <option value="cuda">CUDA (NVIDIA)</option>
              <option value="rocm">ROCm (AMD)</option>
              <option value="vulkan">Vulkan</option>
              <option value="metal">Metal (Apple)</option>
              <option value="cpu">CPU only</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              onClick={install}
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              Install + join mesh
            </button>
          </div>
        </div>
      )}

      {phase !== "idle" && (
        <RemoteProgress
          phase={phase}
          lines={lines}
          error={error}
          logRef={logRef}
          onClose={() => {
            setOpen(false);
            reset();
          }}
          onRetry={() => reset()}
        />
      )}
    </section>
  );
}

function RemoteProgress({
  phase,
  lines,
  error,
  logRef,
  onClose,
  onRetry,
}: {
  phase: Phase;
  lines: LogLine[];
  error: string | null;
  logRef: React.RefObject<HTMLPreElement | null>;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  const heading =
    phase === "running"
      ? "Installing…"
      : phase === "done"
        ? "Node added"
        : "Something went wrong";
  const subline =
    phase === "running"
      ? "This usually takes about a minute."
      : phase === "done"
        ? "The new node will appear below in a few seconds."
        : (error ?? "Try again.");

  return (
    <div className="relative">
      <div className="mb-3 flex items-center gap-3">
        <PhaseDot phase={phase} />
        <div>
          <div className="text-sm font-semibold">{heading}</div>
          <div className="text-[11px] text-[var(--fg-muted)]">{subline}</div>
        </div>
      </div>
      <button
        onClick={() => setShowDetails((v) => !v)}
        className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        {showDetails ? "Hide details" : "Show details"}
      </button>
      {showDetails && (
        <pre
          ref={logRef}
          className="mt-3 max-h-[360px] min-h-[160px] overflow-auto rounded-lg border border-[var(--border)] bg-black/60 p-4 font-mono text-[11px] leading-5 text-[var(--fg-muted)] scrollbar-thin"
        >
{lines.length === 0
  ? "(connecting…)"
  : lines
      .map((l) => {
        if (l.kind === "step") {
          return `--- ${l.name} ---`;
        }
        if (l.kind === "done") {
          return l.ok ? "✓ done" : `✗ exit code ${l.code}`;
        }
        if (l.kind === "error") {
          return `! ${l.message}`;
        }
        if (l.kind === "stderr") {
          return `! ${l.text}`;
        }
        return l.text;
      })
      .join("\n")}
        </pre>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {phase === "done" && (
          <button
            onClick={onClose}
            className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110"
          >
            Done
          </button>
        )}
        {phase === "failed" && (
          <button
            onClick={onRetry}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--border)]"
          >
            Try again
          </button>
        )}
        {phase !== "running" && (
          <button
            onClick={onClose}
            className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}

function PhaseDot({ phase }: { phase: Phase }) {
  const cls =
    phase === "done"
      ? "bg-emerald-400"
      : phase === "failed"
        ? "bg-red-400"
        : "bg-amber-400";
  return (
    <span
      className={`relative inline-block h-3 w-3 shrink-0 rounded-full ${cls}`}
    >
      {phase === "running" && (
        <span className={`absolute inset-0 rounded-full ${cls} pulse-soft`} />
      )}
    </span>
  );
}

function ModeButton({
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
        "flex-1 rounded-md px-3 py-1 transition " +
        (active
          ? "bg-[var(--bg-elev)] text-[var(--fg)]"
          : "text-[var(--fg-muted)] hover:text-[var(--fg)]")
      }
    >
      {children}
    </button>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-1.5 font-mono text-xs text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:border-[var(--accent)]/60 focus:outline-none"
      />
    </div>
  );
}
