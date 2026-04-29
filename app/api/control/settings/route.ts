import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isPublic } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Controller-side user preferences.
 *
 * These live in `~/.closedmesh/controller-settings.json` and are read by the
 * controller UI itself plus, eventually, the runtime when it boots. Today
 * the runtime ignores everything except `defaultModel` (used by `/api/chat`
 * when the request omits a model). The other fields are surfaced as hints
 * to the user without binding them yet — a stub we'll wire to runtime
 * config in a follow-up.
 *
 * We do *not* touch the runtime's own config file from here. The runtime
 * is the source of truth for things like the listen port; this file is the
 * UI's private preferences.
 */

export type Backend = "auto" | "metal" | "cuda" | "rocm" | "vulkan" | "cpu";

export type ControllerSettings = {
  defaultModel: string | null;
  backend: Backend;
  publicOrigins: string[];
  inviteOnly: boolean;
  /**
   * When true, quitting the desktop app leaves the runtime daemon running
   * in the background (still serving the public mesh). When false (the
   * default), the desktop app stops the launchd-supervised service on
   * quit so closing the app actually leaves the mesh — matching what
   * users expect from CMD+Q. The desktop shell reads this file directly
   * on quit; nothing in the controller reads it.
   */
  keepMeshRunningAfterQuit: boolean;
};

const DEFAULTS: ControllerSettings = {
  defaultModel: null,
  backend: "auto",
  publicOrigins: ["https://closedmesh.com"],
  inviteOnly: false,
  keepMeshRunningAfterQuit: false,
};

const SETTINGS_PATH = path.join(
  homedir(),
  ".closedmesh",
  "controller-settings.json",
);

async function ensureDir(p: string) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function readSettings(): Promise<ControllerSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ControllerSettings>;
    return {
      defaultModel:
        typeof parsed.defaultModel === "string" || parsed.defaultModel === null
          ? parsed.defaultModel
          : DEFAULTS.defaultModel,
      backend: isBackend(parsed.backend) ? parsed.backend : DEFAULTS.backend,
      publicOrigins: Array.isArray(parsed.publicOrigins)
        ? parsed.publicOrigins.filter(
            (o): o is string => typeof o === "string",
          )
        : DEFAULTS.publicOrigins,
      inviteOnly:
        typeof parsed.inviteOnly === "boolean"
          ? parsed.inviteOnly
          : DEFAULTS.inviteOnly,
      keepMeshRunningAfterQuit:
        typeof parsed.keepMeshRunningAfterQuit === "boolean"
          ? parsed.keepMeshRunningAfterQuit
          : DEFAULTS.keepMeshRunningAfterQuit,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function isBackend(v: unknown): v is Backend {
  return (
    v === "auto" ||
    v === "metal" ||
    v === "cuda" ||
    v === "rocm" ||
    v === "vulkan" ||
    v === "cpu"
  );
}

async function writeSettings(s: ControllerSettings) {
  await ensureDir(SETTINGS_PATH);
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
}

export async function GET() {
  if (isPublic) {
    return NextResponse.json(
      { ok: false, message: "Settings are not exposed on the public deployment." },
      { status: 403 },
    );
  }
  const settings = await readSettings();
  return NextResponse.json({ ok: true, settings });
}

export async function POST(req: Request) {
  if (isPublic) {
    return NextResponse.json(
      { ok: false, message: "Settings are not exposed on the public deployment." },
      { status: 403 },
    );
  }
  let patch: Partial<ControllerSettings>;
  try {
    patch = (await req.json()) as Partial<ControllerSettings>;
  } catch {
    return NextResponse.json(
      { ok: false, message: "Body must be JSON." },
      { status: 400 },
    );
  }
  const current = await readSettings();
  const next: ControllerSettings = {
    defaultModel:
      typeof patch.defaultModel === "string" || patch.defaultModel === null
        ? patch.defaultModel
        : current.defaultModel,
    backend: isBackend(patch.backend) ? patch.backend : current.backend,
    publicOrigins: Array.isArray(patch.publicOrigins)
      ? patch.publicOrigins
          .map((o) => (typeof o === "string" ? o.trim() : ""))
          .filter((o) => o.length > 0)
      : current.publicOrigins,
    inviteOnly:
      typeof patch.inviteOnly === "boolean"
        ? patch.inviteOnly
        : current.inviteOnly,
    keepMeshRunningAfterQuit:
      typeof patch.keepMeshRunningAfterQuit === "boolean"
        ? patch.keepMeshRunningAfterQuit
        : current.keepMeshRunningAfterQuit,
  };
  await writeSettings(next);
  return NextResponse.json({ ok: true, settings: next });
}
