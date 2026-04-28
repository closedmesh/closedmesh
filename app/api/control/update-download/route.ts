import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { isPublic } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download an installer for the in-app updater and hand it to the OS.
 *
 *   POST { url: "https://github.com/.../ClosedMesh_0.1.9_aarch64.dmg",
 *          filename: "ClosedMesh_0.1.9_aarch64.dmg" }
 *
 * Streams the file to `~/Downloads/closedmesh-updates/<filename>` (we
 * keep our own subdir so the user has one obvious place to look if
 * something goes wrong), then `open`s it. On macOS that mounts the
 * .dmg and pops the drag-to-Applications window; on Windows it kicks
 * off the .msi/.exe installer; on Linux .AppImage gets +x and is
 * launched, .deb opens in the default package manager UI.
 *
 * Why we don't do silent in-place install: that needs an Apple
 * Developer ID-signed app + a notarised updater bundle (and on Windows,
 * a code-signing cert). We ship neither yet, so the user has to
 * complete the install themselves — but at least the installer lands
 * in front of them, instead of "go to the website and re-download".
 *
 * Response is JSON, not a stream — the actual byte-streaming progress
 * UI lives client-side once we have a per-build size estimate; for now
 * downloads are quick enough (50–135 MB on a normal connection) that
 * a single "Downloading…" spinner is acceptable.
 */

type Body = { url?: string; filename?: string };

type DownloadResp =
  | { ok: true; path: string; opened: boolean; message: string }
  | { ok: false; message: string };

const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const ALLOWED_EXT = new Set([".dmg", ".msi", ".exe", ".appimage", ".deb"]);

const ALLOWED_FILENAME = /^[A-Za-z0-9._-]{1,128}$/;

export async function POST(req: Request) {
  if (isPublic) {
    return NextResponse.json<DownloadResp>(
      {
        ok: false,
        message: "In-app updates aren't available on the hosted public site.",
      },
      { status: 403 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json<DownloadResp>(
      { ok: false, message: "Body must be JSON." },
      { status: 400 },
    );
  }

  const urlStr = (body.url ?? "").trim();
  const filename = (body.filename ?? "").trim();

  if (!urlStr || !filename) {
    return NextResponse.json<DownloadResp>(
      { ok: false, message: "Both `url` and `filename` are required." },
      { status: 400 },
    );
  }
  if (!ALLOWED_FILENAME.test(filename)) {
    return NextResponse.json<DownloadResp>(
      {
        ok: false,
        message:
          "Filename contains characters we don't allow. Path-injection guard.",
      },
      { status: 400 },
    );
  }
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json<DownloadResp>(
      { ok: false, message: `Unsupported installer extension: ${ext}.` },
      { status: 400 },
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return NextResponse.json<DownloadResp>(
      { ok: false, message: "Invalid URL." },
      { status: 400 },
    );
  }
  if (parsed.protocol !== "https:") {
    return NextResponse.json<DownloadResp>(
      { ok: false, message: "Only https URLs allowed." },
      { status: 400 },
    );
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    // Lock this down to GitHub-hosted assets — the same place
    // /api/desktop-release sources the URLs from. Keeps us from being
    // turned into a generic "download arbitrary executables" proxy by
    // a malicious or compromised desktop-release response.
    return NextResponse.json<DownloadResp>(
      {
        ok: false,
        message: `Refusing to download from ${parsed.host}.`,
      },
      { status: 400 },
    );
  }

  const downloadsDir = path.join(
    os.homedir(),
    "Downloads",
    "closedmesh-updates",
  );
  try {
    await fs.mkdir(downloadsDir, { recursive: true });
  } catch (err) {
    return NextResponse.json<DownloadResp>({
      ok: false,
      message:
        err instanceof Error
          ? `Couldn't create downloads dir: ${err.message}`
          : "Couldn't create downloads dir.",
    });
  }

  const finalPath = path.join(downloadsDir, filename);

  let res: Response;
  try {
    res = await fetch(parsed, { redirect: "follow" });
  } catch (err) {
    return NextResponse.json<DownloadResp>({
      ok: false,
      message:
        err instanceof Error
          ? `Network error: ${err.message}`
          : "Network error.",
    });
  }
  if (!res.ok || !res.body) {
    return NextResponse.json<DownloadResp>({
      ok: false,
      message: `Asset returned ${res.status} ${res.statusText}.`,
    });
  }

  try {
    const sink = createWriteStream(finalPath);
    const stream = Readable.fromWeb(
      res.body as unknown as WebReadableStream<Uint8Array>,
    );
    await new Promise<void>((resolve, reject) => {
      stream.pipe(sink);
      sink.on("finish", () => resolve());
      sink.on("error", reject);
      stream.on("error", reject);
    });
  } catch (err) {
    try {
      await fs.unlink(finalPath);
    } catch {
      // already gone
    }
    return NextResponse.json<DownloadResp>({
      ok: false,
      message:
        err instanceof Error
          ? `Couldn't write installer: ${err.message}`
          : "Couldn't write installer.",
    });
  }

  // Linux .AppImage needs +x or the OS won't launch it.
  if (process.platform === "linux" && ext === ".appimage") {
    try {
      await fs.chmod(finalPath, 0o755);
    } catch {
      // best-effort; user can still chmod themselves
    }
  }

  const opened = await openWithSystem(finalPath);

  return NextResponse.json<DownloadResp>({
    ok: true,
    path: finalPath,
    opened,
    message: opened
      ? `Downloaded ${filename}. The installer is open — finish the install there.`
      : `Downloaded ${filename}, but couldn't open it automatically. Open ${finalPath} manually to install.`,
  });
}

/**
 * Hand the installer to whatever the OS uses to launch a click-through
 * install. Detached + ignored stdio so we don't leave zombie children
 * (the Tauri main process keeps the .app alive after the controller
 * exits anyway).
 */
async function openWithSystem(filepath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "darwin") {
      cmd = "open";
      args = [filepath];
    } else if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty quoted title is required
      // when the path itself is quoted (otherwise `start "<path>"`
      // treats the path as a window title, not the file to launch).
      cmd = "cmd";
      args = ["/C", "start", "", filepath];
    } else {
      cmd = "xdg-open";
      args = [filepath];
    }
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.unref();
      // We don't wait for exit — `open` returns immediately on macOS,
      // and we don't want to block the HTTP response on user
      // interaction with the installer.
      setTimeout(() => resolve(true), 100);
    } catch {
      resolve(false);
    }
  });
}
