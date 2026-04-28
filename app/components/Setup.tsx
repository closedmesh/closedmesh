"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";

type LogLine =
  | { kind: "stdout" | "stderr"; text: string }
  | { kind: "done"; ok: boolean; code: number }
  | { kind: "error"; message: string };

type Phase = "idle" | "installing" | "starting" | "done" | "failed";

export function Setup({ onInstalled }: { onInstalled: () => void }) {
  const [autoStart, setAutoStart] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const install = useCallback(async () => {
    setPhase("installing");
    setLines([]);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/control/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoStart }),
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
        setError(data.message ?? `install endpoint returned ${res.status}`);
      } catch {
        setError(`install endpoint returned ${res.status}`);
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
          // ignore unparseable line
        }
      }
    }

    if (okFinal === false) {
      setPhase("failed");
      return;
    }

    setPhase("starting");
    try {
      await fetch("/api/control/start", { method: "POST" });
    } catch {
      // non-fatal — status poll catches it
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const s = await fetch("/api/control/status", { cache: "no-store" });
        const data = (await s.json()) as { available: boolean };
        if (data.available) {
          setPhase("done");
          onInstalled();
          return;
        }
      } catch {
        // transient
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    setPhase("failed");
    setError("Something went wrong. Try again.");
  }, [autoStart, onInstalled]);

  // Cover the sidebar — first-run is a focused moment, no nav until set up.
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--bg)] scrollbar-thin">
      {/* Subtle ambient gradient pinned to the orange brand accent. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, rgba(255,122,69,0.18), transparent 70%), radial-gradient(40% 30% at 100% 100%, rgba(255,122,69,0.08), transparent 70%)",
        }}
      />

      <div className="relative mx-auto flex min-h-dvh max-w-3xl flex-col items-stretch px-6 py-10 sm:py-16">
        <div className="flex items-center gap-2.5">
          <Logo size={22} />
          <div className="text-sm font-semibold tracking-tight text-[var(--fg)]">
            ClosedMesh
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
          {phase === "idle" ? (
            <Hero
              autoStart={autoStart}
              onAutoStartChange={setAutoStart}
              onInstall={install}
            />
          ) : (
            <Progress
              phase={phase}
              lines={lines}
              error={error}
              logRef={logRef}
              onRetry={install}
            />
          )}
        </div>

        <footer className="text-center text-[11px] text-[var(--fg-muted)]">
          Open source · Apache-2.0 / MIT ·{" "}
          <a href="/about" className="hover:text-[var(--fg)]">
            How it works
          </a>
        </footer>
      </div>
    </div>
  );
}

function Hero({
  autoStart,
  onAutoStartChange,
  onInstall,
}: {
  autoStart: boolean;
  onAutoStartChange: (v: boolean) => void;
  onInstall: () => void;
}) {
  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-7 rounded-3xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 shadow-[0_0_0_1px_rgba(255,122,69,0.08),0_20px_60px_-30px_rgba(255,122,69,0.6)]">
        <Logo size={56} />
      </div>

      <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
        A private LLM,
        <br />
        on your own machines.
      </h1>
      <p className="mt-5 max-w-xl text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)] sm:text-base">
        ClosedMesh runs on the hardware you already own. Pool it with your
        team and you get a fast, private AI that never sends your prompts
        to anyone else&apos;s server.
      </p>

      <div className="mt-7 flex flex-wrap justify-center gap-2 text-[11px]">
        <Pill>Your data never leaves your network</Pill>
        <Pill>No API bills</Pill>
        <Pill>Works with your team&apos;s laptops</Pill>
      </div>

      <div className="mt-10 flex w-full max-w-md flex-col items-center gap-4">
        <button
          onClick={onInstall}
          className="w-full rounded-xl bg-[var(--accent)] px-6 py-4 text-base font-semibold text-black shadow-[0_10px_30px_-12px_rgba(255,122,69,0.8)] transition hover:brightness-110"
        >
          Install ClosedMesh
        </button>
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-[var(--fg-muted)]">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => onAutoStartChange(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Start automatically when I log in
        </label>
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
      {children}
    </span>
  );
}

function Progress({
  phase,
  lines,
  error,
  logRef,
  onRetry,
}: {
  phase: Phase;
  lines: LogLine[];
  error: string | null;
  logRef: React.RefObject<HTMLPreElement | null>;
  onRetry: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  const heading =
    phase === "installing"
      ? "Installing…"
      : phase === "starting"
        ? "Starting up…"
        : phase === "done"
          ? "Ready"
          : "Something went wrong";
  const subline =
    phase === "installing"
      ? "This usually takes under a minute."
      : phase === "starting"
        ? "Almost there."
        : phase === "done"
          ? "Loading your dashboard…"
          : (error ?? "Try again.");

  return (
    <div className="flex w-full max-w-xl flex-col items-center">
      <div className="mb-7 rounded-3xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
        <Logo size={56} />
      </div>

      <div className="flex items-center gap-3">
        <PhaseDot phase={phase} />
        <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
      </div>
      <p className="mt-2 text-sm text-[var(--fg-muted)]">{subline}</p>

      <button
        onClick={() => setShowDetails((v) => !v)}
        className="mt-6 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        {showDetails ? "Hide details" : "Show details"}
      </button>

      {showDetails && (
        <pre
          ref={logRef}
          className="mt-3 w-full max-h-[360px] min-h-[180px] overflow-auto rounded-lg border border-[var(--border)] bg-black/60 p-4 text-left font-mono text-[11px] leading-5 text-[var(--fg-muted)] scrollbar-thin"
        >
{lines.length === 0
  ? "(waiting…)"
  : lines
      .map((l) =>
        l.kind === "stderr"
          ? `! ${l.text}`
          : l.kind === "done"
            ? l.ok
              ? "✓ done"
              : `✗ exit code ${l.code}`
            : l.kind === "error"
              ? `! ${l.message}`
              : l.text,
      )
      .join("\n")}
        </pre>
      )}

      {phase === "failed" && (
        <div className="mt-6">
          <button
            onClick={onRetry}
            className="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function PhaseDot({ phase }: { phase: Phase }) {
  const cls =
    phase === "done"
      ? "bg-emerald-400"
      : phase === "failed"
        ? "bg-red-400"
        : "bg-[var(--accent)]";
  return (
    <span
      className={`relative inline-block h-3 w-3 shrink-0 rounded-full ${cls}`}
    >
      {(phase === "installing" || phase === "starting") && (
        <span className={`absolute inset-0 rounded-full ${cls} pulse-soft`} />
      )}
    </span>
  );
}
