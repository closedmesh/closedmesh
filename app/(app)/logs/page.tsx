"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";

type LogsResp = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
};

type Stream = "stdout" | "stderr";

export default function LogsPage() {
  const [logs, setLogs] = useState<{ stdout: string; stderr: string }>({
    stdout: "",
    stderr: "",
  });
  const [stream, setStream] = useState<Stream>("stdout");
  const [autoFollow, setAutoFollow] = useState(true);
  const paneRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/control/logs", { cache: "no-store" });
      const data = (await res.json()) as LogsResp;
      if (data.ok) {
        setLogs({
          stdout: data.stdout ?? "",
          stderr: data.stderr ?? "",
        });
      }
    } catch {
      // transient
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!autoFollow) return;
    const el = paneRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, stream, autoFollow]);

  const body = stream === "stdout" ? logs.stdout : logs.stderr;
  const errorCount = countLines(logs.stderr);

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Activity"
        subtitle="What ClosedMesh is doing on this machine — handy if something looks off."
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-elev)] px-6 py-2.5">
          <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-1 text-xs">
            <StreamButton
              active={stream === "stdout"}
              onClick={() => setStream("stdout")}
              badge={null}
            >
              Activity
            </StreamButton>
            <StreamButton
              active={stream === "stderr"}
              onClick={() => setStream("stderr")}
              badge={errorCount > 0 ? errorCount : null}
            >
              Errors
            </StreamButton>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
            <input
              type="checkbox"
              checked={autoFollow}
              onChange={(e) => setAutoFollow(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Follow latest
          </label>
        </div>

        <pre
          ref={paneRef}
          className="flex-1 overflow-auto bg-black/60 px-6 py-4 font-mono text-[11px] leading-5 text-[var(--fg-muted)] scrollbar-thin"
        >
{body ||
  (stream === "stdout"
    ? "Quiet so far. Activity will show up here as the mesh runs."
    : "No errors. That's good.")}
        </pre>
      </main>
    </div>
  );
}

function StreamButton({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge: number | null;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded px-3 py-1 transition " +
        (active
          ? "bg-[var(--bg-elev-2)] text-[var(--fg)]"
          : "text-[var(--fg-muted)] hover:text-[var(--fg)]")
      }
    >
      <span>{children}</span>
      {badge !== null && (
        <span
          className={
            "rounded-full px-1.5 py-0.5 text-[9px] font-medium " +
            (active
              ? "bg-red-500/20 text-red-300"
              : "bg-[var(--border)] text-[var(--fg-muted)]")
          }
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}
