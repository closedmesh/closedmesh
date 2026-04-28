"use client";

import { useEffect, useState } from "react";

type Status = {
  online: boolean;
  models: string[];
};

type Phase = "loading" | "online" | "offline";

/**
 * Tiny live indicator that polls the public `/api/status` endpoint and
 * renders the mesh's current state. The endpoint already exists and is the
 * same one the desktop controller uses — on the public deployment it
 * proxies through the Vercel function to the Railway entry node, which
 * answers `/v1/models` from whichever peers are advertising right now.
 *
 * Design choices:
 * - Polls every 30s. The mesh state changes on tens-of-seconds time scale
 *   (peers come and go), and faster polling adds load with no UX gain.
 * - Doesn't claim a peer count, because the public entry node only
 *   exposes the OpenAI-compatible API; the privileged "how many peers"
 *   admin endpoint isn't proxied. We surface the *model* list instead,
 *   which is more useful proof-of-life anyway ("the mesh is currently
 *   serving Qwen3-8B" reads as more concrete than "12 peers online").
 * - On error we degrade to a quiet "offline" pill rather than disappearing
 *   so a broken backend doesn't look like a broken page.
 */
export function MeshLiveStatus({
  variant = "inline",
}: {
  variant?: "inline" | "header";
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as Status;
        if (cancelled) return;
        if (data.online) {
          setPhase("online");
          setModels(data.models ?? []);
        } else {
          setPhase("offline");
          setModels([]);
        }
      } catch {
        if (!cancelled) {
          setPhase("offline");
          setModels([]);
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, 30_000);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (variant === "header") {
    // Compact pill that lives in the page header.
    const dot =
      phase === "online"
        ? "bg-emerald-400"
        : phase === "loading"
          ? "bg-[var(--fg-muted)]"
          : "bg-red-400";
    const label =
      phase === "online"
        ? `Mesh online · ${models.length} model${models.length === 1 ? "" : "s"}`
        : phase === "loading"
          ? "Checking mesh…"
          : "Mesh unreachable";
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-[11px] text-[var(--fg-muted)]">
        <span className="relative inline-flex h-2 w-2">
          {phase === "online" && (
            <span
              aria-hidden
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"
            />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
        </span>
        {label}
      </span>
    );
  }

  // Inline (homepage) variant — quietly readable line of model names.
  if (phase === "loading") {
    return (
      <div className="text-[12px] text-[var(--fg-muted)]">
        Checking the mesh…
      </div>
    );
  }
  if (phase === "offline") {
    return (
      <div className="text-[12px] text-[var(--fg-muted)]">
        The mesh is currently unreachable. Try again in a moment.
      </div>
    );
  }
  if (models.length === 0) {
    return (
      <div className="text-[12px] text-[var(--fg-muted)]">
        Mesh online · no models advertised right now.
      </div>
    );
  }

  // Show up to 3 model names then "+N more" so the line stays short.
  const head = models.slice(0, 3).map(prettyModelName);
  const rest = models.length - head.length;
  const tail = rest > 0 ? `, +${rest} more` : "";
  return (
    <div className="inline-flex items-center gap-2 text-[12px] text-[var(--fg-muted)]">
      <span className="relative inline-flex h-2 w-2">
        <span
          aria-hidden
          className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"
        />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      <span>
        Right now the mesh is serving{" "}
        <span className="text-[var(--fg)]">{head.join(", ")}</span>
        {tail}.
      </span>
    </div>
  );
}

/**
 * Trim quantization suffixes ("-Q4_K_M", ".gguf", etc.) from runtime model
 * IDs so the homepage shows clean names like "Qwen3-8B" instead of
 * "Qwen3-8B-Q4_K_M". The runtime IDs include quant info because peers
 * advertise the exact file they hold; visitors don't need that detail.
 */
function prettyModelName(id: string): string {
  return id
    .replace(/\.gguf$/i, "")
    .replace(/-Q\d+(_K(_[SM])?|_0|_1)?$/i, "")
    .replace(/-UD-Q\d+(_K(_[SM]|_XL))?$/i, "")
    .replace(/-instruct$/i, " (Instruct)");
}
