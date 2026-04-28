"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { MODEL_CATALOG, type CatalogModel } from "../../lib/model-catalog";
import { useMeshStatus } from "../../lib/use-mesh-status";

type LocalModel = { id: string; sizeBytes: number | null };
type ListResp =
  | { ok: true; models: LocalModel[] }
  | { ok: false; message: string; models: LocalModel[] };

type DownloadEvent =
  | { kind: "stdout" | "stderr"; text: string }
  | { kind: "progress"; percent: number; bytes: number; total: number }
  | { kind: "done"; ok: boolean; code: number }
  | { kind: "error"; message: string };

type DownloadState = {
  id: string;
  phase: "running" | "done" | "failed";
  percent: number;
  bytes: number;
  total: number;
  lastLine: string;
  error?: string;
};

const FAMILY_LABEL: Record<CatalogModel["family"], string> = {
  qwen: "Qwen",
  llama: "Llama",
  mistral: "Mistral",
  phi: "Phi",
  gemma: "Gemma",
};

const FAMILY_TINT: Record<CatalogModel["family"], string> = {
  qwen: "border-violet-400/40 bg-violet-400/10 text-violet-300",
  llama: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  mistral: "border-rose-400/40 bg-rose-400/10 text-rose-300",
  phi: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  gemma: "border-amber-400/40 bg-amber-400/10 text-amber-300",
};

export default function ModelsPage() {
  const mesh = useMeshStatus();
  const [local, setLocal] = useState<LocalModel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>(
    {},
  );

  const refreshLocal = useCallback(async () => {
    try {
      const res = await fetch("/api/control/models/list", {
        cache: "no-store",
      });
      const data = (await res.json()) as ListResp;
      setLocal(data.models);
      setListError(data.ok ? null : data.message);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "request failed");
    }
  }, []);

  useEffect(() => {
    refreshLocal();
    const id = setInterval(refreshLocal, 8000);
    return () => clearInterval(id);
  }, [refreshLocal]);

  const startDownload = useCallback(
    async (id: string) => {
      setDownloads((d) => ({
        ...d,
        [id]: {
          id,
          phase: "running",
          percent: 0,
          bytes: 0,
          total: 0,
          lastLine: "starting…",
        },
      }));

      const res = await fetch("/api/control/models/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });

      if (!res.ok || !res.body) {
        let message = `request returned ${res.status}`;
        try {
          const err = (await res.json()) as { message?: string };
          message = err.message ?? message;
        } catch {
          // body is the stream — already consumed
        }
        setDownloads((d) => ({
          ...d,
          [id]: { ...d[id], phase: "failed", error: message },
        }));
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
          let ev: DownloadEvent;
          try {
            ev = JSON.parse(line) as DownloadEvent;
          } catch {
            continue;
          }
          setDownloads((d) => {
            const cur = d[id];
            if (!cur) return d;
            const next: DownloadState = { ...cur };
            if (ev.kind === "progress") {
              next.percent = ev.percent;
              next.bytes = ev.bytes;
              next.total = ev.total;
            } else if (ev.kind === "stdout" || ev.kind === "stderr") {
              next.lastLine = ev.text;
            } else if (ev.kind === "done") {
              next.phase = ev.ok ? "done" : "failed";
              next.percent = ev.ok ? 100 : next.percent;
              if (!ev.ok) next.error = `Download failed (exit ${ev.code}).`;
              okFinal = ev.ok;
            } else if (ev.kind === "error") {
              next.phase = "failed";
              next.error = ev.message;
              okFinal = false;
            }
            return { ...d, [id]: next };
          });
        }
      }

      if (okFinal) {
        await refreshLocal();
      }
    },
    [refreshLocal],
  );

  const localIds = new Set((local ?? []).map((m) => m.id));
  const localCatalog = MODEL_CATALOG.filter((m) => localIds.has(m.id));
  const remoteCatalog = MODEL_CATALOG.filter((m) => !localIds.has(m.id));
  const orphans =
    local?.filter((m) => !MODEL_CATALOG.find((c) => c.id === m.id)) ?? [];

  const selfNode = mesh.nodes.find((n) => n.isSelf);
  const localVramGb = selfNode?.capability.vramGb ?? selfNode?.vramGb ?? null;
  const localBackend = selfNode?.capability.backend ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Models"
        subtitle="Download a model onto your mesh. Start small — you can always upgrade later."
      />

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
          {listError && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">
              {listError}
            </div>
          )}

          {mesh.models.length > 0 && (
            <Section
              title="Currently loaded"
              hint="In memory and ready to answer chat requests."
            >
              <ul className="divide-y divide-[var(--border)]">
                {mesh.models.map((m) => (
                  <li
                    key={m}
                    className="flex items-center justify-between py-3"
                  >
                    <span className="font-mono text-sm text-[var(--fg)]">
                      {m}
                    </span>
                    <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                      Loaded
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(localCatalog.length > 0 || orphans.length > 0) && (
            <Section
              title="On your mesh"
              hint="Already downloaded — pick one to load into chat."
            >
              <ul className="space-y-2">
                {localCatalog.map((m) => (
                  <CatalogRow
                    key={m.id}
                    model={m}
                    download={downloads[m.id] ?? null}
                    localVramGb={localVramGb}
                    localBackend={localBackend}
                    state="downloaded"
                    onDownload={() => startDownload(m.id)}
                  />
                ))}
                {orphans.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-elev-2)]/60 px-4 py-3"
                  >
                    <div>
                      <div className="font-mono text-sm">{m.id}</div>
                      <div className="text-[11px] text-[var(--fg-muted)]">
                        Custom model — not in our catalog.
                      </div>
                    </div>
                    <div className="font-mono text-[11px] text-[var(--fg-muted)]">
                      {m.sizeBytes ? formatBytes(m.sizeBytes) : "—"}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            title="Catalog"
            hint="Hand-picked models that work well on ClosedMesh. Tap Download to pull one onto this machine."
          >
            <ul className="space-y-2">
              {remoteCatalog.map((m) => (
                <CatalogRow
                  key={m.id}
                  model={m}
                  download={downloads[m.id] ?? null}
                  localVramGb={localVramGb}
                  localBackend={localBackend}
                  state="catalog"
                  onDownload={() => startDownload(m.id)}
                />
              ))}
            </ul>
          </Section>
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
          {title}
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--fg-muted)]">{hint}</div>
      </div>
      {children}
    </section>
  );
}

function CatalogRow({
  model,
  download,
  localVramGb,
  localBackend,
  state,
  onDownload,
}: {
  model: CatalogModel;
  download: DownloadState | null;
  localVramGb: number | null;
  localBackend: string | null;
  state: "downloaded" | "catalog";
  onDownload: () => void;
}) {
  const fits =
    localVramGb == null
      ? null
      : localVramGb >= model.minVramGb ||
        (model.cpuOk && (localBackend === "cpu" || localVramGb < 1));

  const downloading = download?.phase === "running";
  const downloadFailed = download?.phase === "failed";

  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev-2)]/40 p-4 transition hover:border-[var(--accent)]/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-tight text-[var(--fg)]">
              {model.name}
            </span>
            <span
              className={
                "rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                FAMILY_TINT[model.family]
              }
            >
              {FAMILY_LABEL[model.family]}
            </span>
            {model.recommended && (
              <span className="rounded-full border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                Recommended
              </span>
            )}
            {state === "downloaded" && (
              <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                On your mesh
              </span>
            )}
            {fits === false && state === "catalog" && (
              <span
                className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                title={`This Mac has ${localVramGb?.toFixed(1)} GB; this model wants ${model.minVramGb} GB.`}
              >
                Won&apos;t fit on this Mac
              </span>
            )}
            {model.cpuOk && (
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-0.5 text-[10px] font-medium text-[var(--fg-muted)]">
                CPU-friendly
              </span>
            )}
          </div>
          <div className="mt-1.5 max-w-2xl text-[13px] text-[var(--fg-muted)]">
            {model.description}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--fg-muted)]">
            <span>
              <span className="text-[var(--fg)]">{model.sizeGb} GB</span> on
              disk
            </span>
            <span aria-hidden>·</span>
            <span>
              needs <span className="text-[var(--fg)]">{model.minVramGb} GB</span>{" "}
              memory
            </span>
          </div>
        </div>

        <div className="shrink-0">
          {state === "downloaded" ? (
            <span className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
              Ready
            </span>
          ) : (
            <button
              onClick={onDownload}
              disabled={downloading}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {downloading
                ? `Downloading… ${download!.percent.toFixed(0)}%`
                : downloadFailed
                  ? "Try again"
                  : "Download"}
            </button>
          )}
        </div>
      </div>

      {download && (
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
          <div className="mb-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
            <div
              className={
                "h-full transition-all " +
                (download.phase === "failed"
                  ? "bg-red-400"
                  : download.phase === "done"
                    ? "bg-emerald-400"
                    : "bg-[var(--accent)]")
              }
              style={{ width: `${Math.max(2, download.percent)}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--fg-muted)]">
            <span className="truncate font-mono" title={download.lastLine}>
              {download.error ?? download.lastLine}
            </span>
            <span className="shrink-0 font-mono">
              {download.total > 0
                ? `${formatBytes(download.bytes)} / ${formatBytes(download.total)}`
                : `${download.percent.toFixed(0)}%`}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
