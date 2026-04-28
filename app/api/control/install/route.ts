import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isPublic } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the bundled `public/install.sh` for the current host. Streams stdout
 * and stderr back to the caller as newline-delimited JSON events so the
 * dashboard can show live progress without a second polling endpoint.
 *
 * Each line is one of:
 *
 *   {"kind":"stdout","text":"…"}
 *   {"kind":"stderr","text":"…"}
 *   {"kind":"done","ok":true,"code":0}
 *   {"kind":"error","message":"…"}
 *
 * The dashboard parses the stream and surfaces an in-app log pane. We
 * intentionally do *not* use SSE because the AI SDK's transport already
 * monopolises EventSource semantics for /api/chat; sticking to a plain
 * `text/plain` stream keeps the client wiring tiny.
 */
export async function POST(req: Request) {
  if (isPublic) {
    return new Response(
      JSON.stringify({
        ok: false,
        message:
          "The hosted public site can't install software on your machine. Download the desktop app first.",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  // The Setup component sends { autoStart: boolean } so the user can
  // turn off "Start automatically when I log in" before installing.
  // Default is true — that's the right answer for almost everyone.
  let autoStart = true;
  try {
    const body = (await req.json()) as { autoStart?: boolean };
    if (body && typeof body.autoStart === "boolean") {
      autoStart = body.autoStart;
    }
  } catch {
    // No body / not JSON — keep default (autoStart = true).
  }

  // We avoid `curl | sh` to keep the supply chain visible: the install
  // script is shipped inside this very controller bundle. If somebody
  // tampered with `public/install.sh` they already had write access.
  const scriptPath = path.join(process.cwd(), "public", "install.sh");
  try {
    await fs.access(scriptPath);
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        message: `install.sh not found at ${scriptPath}`,
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  // Linux/macOS only for now — Windows users go through install.ps1 which
  // we'll wire up once the desktop bundle ships on Windows. Refuse loudly
  // rather than mis-execute on the wrong shell.
  if (process.platform === "win32") {
    return new Response(
      JSON.stringify({
        ok: false,
        message:
          "In-app install isn't wired for Windows yet. Run install.ps1 manually for now.",
      }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      };

      const args = autoStart ? [scriptPath, "--service"] : [scriptPath];
      send({ kind: "stdout", text: `bash ${args.join(" ")}` });

      const child = spawn("bash", args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      child.stdout.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) send({ kind: "stdout", text: line });
        }
      });
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) send({ kind: "stderr", text: line });
        }
      });

      child.on("error", (err) => {
        send({ kind: "error", message: err.message });
        controller.close();
      });
      child.on("close", (code) => {
        send({ kind: "done", ok: code === 0, code: code ?? -1 });
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Hint to proxies that this is a long-lived response. (Vercel
      // wouldn't run the install endpoint anyway — see isPublic guard
      // above — but a corp proxy in front of a self-hosted controller
      // might.)
      "x-content-type-options": "nosniff",
    },
  });
}
