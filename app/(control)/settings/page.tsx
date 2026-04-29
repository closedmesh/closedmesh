"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { MODEL_CATALOG } from "../../lib/model-catalog";

type Backend = "auto" | "metal" | "cuda" | "rocm" | "vulkan" | "cpu";

type Settings = {
  defaultModel: string | null;
  backend: Backend;
  publicOrigins: string[];
  inviteOnly: boolean;
  keepMeshRunningAfterQuit: boolean;
};

type LocalModel = { id: string };

type Save = "idle" | "saving" | "saved" | "error";

const BACKEND_LABEL: Record<Backend, string> = {
  auto: "Auto-detect (recommended)",
  metal: "Apple Metal",
  cuda: "NVIDIA CUDA",
  rocm: "AMD ROCm",
  vulkan: "Vulkan",
  cpu: "CPU only",
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [save, setSave] = useState<Save>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const dirty = useRef(false);

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const [sRes, aRes, mRes] = await Promise.all([
          fetch("/api/control/settings", { cache: "no-store" }),
          fetch("/api/control/service/status", { cache: "no-store" }),
          fetch("/api/control/models/list", { cache: "no-store" }),
        ]);
        const sData = (await sRes.json()) as { ok: boolean; settings?: Settings };
        const aData = (await aRes.json()) as { ok: boolean; autostart?: boolean };
        const mData = (await mRes.json()) as {
          ok: boolean;
          models: { id: string }[];
        };
        if (sData.ok && sData.settings) setSettings(sData.settings);
        if (aData.ok) setAutostart(Boolean(aData.autostart));
        if (mData.models) setLocalModels(mData.models);
      } catch (e) {
        setSaveMsg(e instanceof Error ? e.message : "couldn't load settings");
        setSave("error");
      }
    })();
  }, []);

  const update = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      dirty.current = true;
      setSettings((cur) => (cur ? { ...cur, [key]: value } : cur));
    },
    [],
  );

  const persist = useCallback(async () => {
    if (!settings) return;
    setSave("saving");
    setSaveMsg(null);
    try {
      const res = await fetch("/api/control/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        settings?: Settings;
      };
      if (!data.ok) {
        setSave("error");
        setSaveMsg(data.message ?? "save failed");
        return;
      }
      if (data.settings) setSettings(data.settings);
      dirty.current = false;
      setSave("saved");
      setSaveMsg("Saved.");
      setTimeout(() => setSave("idle"), 1500);
    } catch (e) {
      setSave("error");
      setSaveMsg(e instanceof Error ? e.message : "save failed");
    }
  }, [settings]);

  const toggleAutostart = useCallback(
    async (next: boolean) => {
      setAutostartBusy(true);
      setAutostartError(null);
      const endpoint = next
        ? "/api/control/service/install"
        : "/api/control/service/uninstall";
      try {
        const res = await fetch(endpoint, { method: "POST" });
        const data = (await res.json()) as { ok: boolean; message?: string };
        if (data.ok) {
          setAutostart(next);
        } else {
          setAutostartError(data.message ?? "couldn't change setting");
        }
      } catch (e) {
        setAutostartError(e instanceof Error ? e.message : "request failed");
      } finally {
        setAutostartBusy(false);
      }
    },
    [],
  );

  const downloadedIds = new Set(localModels.map((m) => m.id));
  const downloadedCatalog = MODEL_CATALOG.filter((m) => downloadedIds.has(m.id));

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Settings"
        subtitle="How ClosedMesh runs on this machine."
      />

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
          <Card
            eyebrow="Startup"
            title="Start automatically when I log in"
            hint="ClosedMesh will be running in the background, ready to share your machine and answer chat requests."
          >
            <div className="flex items-center justify-between gap-4">
              <Toggle
                checked={autostart ?? false}
                disabled={autostart === null || autostartBusy}
                onChange={toggleAutostart}
              />
              <span className="text-[12px] text-[var(--fg-muted)]">
                {autostart === null
                  ? "checking…"
                  : autostartBusy
                    ? "applying…"
                    : autostart
                      ? "On — starts at login"
                      : "Off"}
              </span>
            </div>
            {autostartError && (
              <div className="mt-3 text-[11px] text-red-300">
                {autostartError}
              </div>
            )}
          </Card>

          <Card
            eyebrow="Quitting"
            title="Stay in the mesh after I quit ClosedMesh"
            hint="On: the runtime keeps serving in the background after you close the app — your machine still answers chat requests for the mesh. Off (default): quitting actually leaves the mesh, like CMD+Q implies."
          >
            <div className="flex items-center justify-between gap-4">
              <Toggle
                checked={settings?.keepMeshRunningAfterQuit ?? false}
                disabled={!settings}
                onChange={(v) => update("keepMeshRunningAfterQuit", v)}
              />
              <span className="text-[12px] text-[var(--fg-muted)]">
                {settings?.keepMeshRunningAfterQuit
                  ? "On — quitting leaves the runtime up"
                  : "Off — quitting stops the runtime"}
              </span>
            </div>
          </Card>

          <Card
            eyebrow="Chat"
            title="Default model"
            hint="What chat asks for if you don't pick one. We'll fall back to whatever is loaded if your default isn't ready."
          >
            <select
              value={settings?.defaultModel ?? ""}
              disabled={!settings}
              onChange={(e) =>
                update("defaultModel", e.target.value || null)
              }
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 text-sm text-[var(--fg)] focus:border-[var(--accent)]/60 focus:outline-none disabled:opacity-50"
            >
              <option value="">Auto — first available</option>
              {downloadedCatalog.length > 0 && (
                <optgroup label="On your mesh">
                  {downloadedCatalog.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {MODEL_CATALOG.filter((m) => !downloadedIds.has(m.id)).length >
                0 && (
                <optgroup label="Catalog (not downloaded yet)">
                  {MODEL_CATALOG.filter((m) => !downloadedIds.has(m.id)).map(
                    (m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ),
                  )}
                </optgroup>
              )}
              {localModels
                .filter((m) => !MODEL_CATALOG.find((c) => c.id === m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
            </select>
          </Card>

          <Card
            eyebrow="Sharing"
            title="Lock my mesh to invited machines only"
            hint="When on, only people you've sent an invite to can join. Off means anyone on your network can offer to help (still subject to the runtime's auth)."
          >
            <div className="flex items-center justify-between gap-4">
              <Toggle
                checked={settings?.inviteOnly ?? false}
                disabled={!settings}
                onChange={(v) => update("inviteOnly", v)}
              />
              <span className="text-[12px] text-[var(--fg-muted)]">
                {settings?.inviteOnly ? "Invite-only" : "Open to LAN"}
              </span>
            </div>
          </Card>

          <details className="group rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)]/60 p-5 open:bg-[var(--bg-elev)]">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold tracking-tight text-[var(--fg)]">
              <span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                  Advanced
                </span>
                <span className="block text-base">For power users</span>
              </span>
              <span className="text-[var(--fg-muted)] transition group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="mt-4 flex flex-col gap-5">
              <Field
                label="Hardware override"
                hint="Force a specific accelerator. Default auto-detect is right almost always."
              >
                <select
                  value={settings?.backend ?? "auto"}
                  disabled={!settings}
                  onChange={(e) =>
                    update("backend", e.target.value as Backend)
                  }
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 text-sm text-[var(--fg)] focus:border-[var(--accent)]/60 focus:outline-none disabled:opacity-50"
                >
                  {(Object.keys(BACKEND_LABEL) as Backend[]).map((b) => (
                    <option key={b} value={b}>
                      {BACKEND_LABEL[b]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Trusted web origins"
                hint="Browser pages allowed to call this controller cross-origin (one per line). Add your team's intranet here if you want chat-from-anywhere."
              >
                <textarea
                  value={(settings?.publicOrigins ?? []).join("\n")}
                  disabled={!settings}
                  onChange={(e) =>
                    update(
                      "publicOrigins",
                      e.target.value
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0),
                    )
                  }
                  rows={3}
                  className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 font-mono text-xs text-[var(--fg)] focus:border-[var(--accent)]/60 focus:outline-none disabled:opacity-50"
                  placeholder="https://closedmesh.com"
                />
              </Field>
            </div>
          </details>

          <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-[var(--border)] bg-[var(--bg)]/85 px-6 py-3 backdrop-blur">
            <span className="text-[12px] text-[var(--fg-muted)]">
              {save === "saving"
                ? "Saving…"
                : save === "saved"
                  ? saveMsg
                  : save === "error"
                    ? saveMsg
                    : "Changes apply on save."}
            </span>
            <button
              onClick={persist}
              disabled={save === "saving" || !settings}
              className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {save === "saving" ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function Card({
  eyebrow,
  title,
  hint,
  children,
}: {
  eyebrow: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">
        {eyebrow}
      </div>
      <div className="mt-0.5 text-base font-semibold tracking-tight text-[var(--fg)]">
        {title}
      </div>
      <div className="mt-1 text-[12px] text-[var(--fg-muted)]">{hint}</div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
          {label}
        </label>
      </div>
      {children}
      <div className="mt-1.5 text-[11px] text-[var(--fg-muted)]">{hint}</div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 " +
        (checked
          ? "bg-[var(--accent)] shadow-[0_4px_18px_-6px_rgba(255,122,69,0.8)]"
          : "bg-[var(--border)]")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition " +
          (checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}
