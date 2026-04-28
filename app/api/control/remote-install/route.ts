import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Onboard a remote machine (vast.ai box, a teammate's GPU server, anything
 * reachable over SSH) into this mesh — without anyone having to open a
 * terminal.
 *
 * The flow:
 *   1. Generate a one-time invite token from the LOCAL runtime
 *      (closedmesh invite create).
 *   2. SSH to the remote host and pipe public/install.sh in via stdin —
 *      no scp, no second hop. install.sh detects the remote's hardware
 *      (Apple Silicon / NVIDIA / AMD / Vulkan / CPU) and downloads the
 *      matching ClosedMesh release tarball into ~/.local/bin/closedmesh.
 *   3. SSH again and start the runtime with `closedmesh serve --join
 *      <token>` in the background. The remote becomes a mesh node;
 *      capability-matching takes over from there.
 *
 * Output is streamed back to the client as newline-delimited JSON so the
 * dashboard can show a live console. Same envelope as /api/control/install:
 *
 *   {"kind":"step","name":"connect","ok":true}
 *   {"kind":"stdout","text":"…"}
 *   {"kind":"stderr","text":"…"}
 *   {"kind":"done","ok":true,"code":0}
 *   {"kind":"error","message":"…"}
 *
 * SECURITY: we accept a path to an existing private key on the LOCAL
 * filesystem (typically ~/.ssh/id_*) — we never ferry key bytes over
 * HTTP. We never log the key path either; only the public host:port.
 * StrictHostKeyChecking=accept-new keeps the first-contact UX smooth
 * without silently accepting a changed host key on subsequent runs.
 */

type Body = {
  host?: string;
  user?: string;
  port?: number;
  /** Path to an SSH private key on this local machine. */
  identityFile?: string;
  /** Optional: vast.ai-style copy/paste of `ssh -p ... user@host -i ...`. */
  sshCommand?: string;
  /** Optional: force a backend on the remote (CLOSEDMESH_BACKEND env). */
  backend?: "cuda" | "rocm" | "vulkan" | "cpu" | "metal";
};

type Plan = {
  host: string;
  user: string;
  port: number;
  identityFile: string | null;
  backend: Body["backend"];
};

function parseSshCommand(cmd: string): Partial<Plan> | null {
  // We tolerate both styles vast.ai emits:
  //   `ssh -p 12345 root@ssh1.vast.ai -L 8080:localhost:8080 -i ~/.ssh/key`
  //   `ssh root@ssh1.vast.ai -p 12345`
  const tokens = cmd
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens[0] !== "ssh") return null;

  let host: string | null = null;
  let user: string | null = null;
  let port = 22;
  let identityFile: string | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-p" && tokens[i + 1]) {
      port = Number(tokens[++i]) || 22;
      continue;
    }
    if (t === "-i" && tokens[i + 1]) {
      identityFile = tokens[++i].replace(/^~/, process.env.HOME ?? "~");
      continue;
    }
    if (t === "-L" || t === "-R" || t === "-D") {
      // skip the spec arg too
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    // Positional non-flag: user@host or just host
    if (!host) {
      const at = t.indexOf("@");
      if (at >= 0) {
        user = t.slice(0, at);
        host = t.slice(at + 1);
      } else {
        host = t;
      }
    }
  }
  if (!host) return null;
  return { host, user: user ?? "root", port, identityFile };
}

function buildSshArgs(plan: Plan, remoteCommand: string): string[] {
  const args: string[] = [];
  if (plan.identityFile) {
    args.push("-i", plan.identityFile);
  }
  args.push("-p", String(plan.port));
  args.push("-o", "BatchMode=yes");
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ConnectTimeout=12");
  args.push(`${plan.user}@${plan.host}`);
  args.push(remoteCommand);
  return args;
}

export async function POST(req: Request) {
  if (isPublic) {
    return new Response(
      JSON.stringify({
        ok: false,
        message:
          "Remote install isn't available on the hosted public site. Use the desktop app.",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonErr(400, "Body must be JSON.");
  }

  let plan: Plan;
  if (body.sshCommand) {
    const parsed = parseSshCommand(body.sshCommand);
    if (!parsed?.host) {
      return jsonErr(
        400,
        "Couldn't parse the SSH command. Expected something like `ssh -p 12345 root@host -i ~/.ssh/key`.",
      );
    }
    plan = {
      host: parsed.host,
      user: parsed.user ?? body.user ?? "root",
      port: parsed.port ?? body.port ?? 22,
      identityFile: parsed.identityFile ?? body.identityFile ?? null,
      backend: body.backend,
    };
  } else {
    if (!body.host) return jsonErr(400, "host is required.");
    plan = {
      host: body.host,
      user: body.user ?? "root",
      port: body.port ?? 22,
      identityFile: body.identityFile ?? null,
      backend: body.backend,
    };
  }

  if (plan.identityFile) {
    try {
      const stat = await fs.stat(plan.identityFile);
      if (!stat.isFile()) {
        return jsonErr(
          400,
          `identityFile is not a regular file: ${plan.identityFile}`,
        );
      }
    } catch {
      return jsonErr(
        400,
        `identityFile not found on this machine: ${plan.identityFile}`,
      );
    }
  }

  const scriptPath = path.join(process.cwd(), "public", "install.sh");
  try {
    await fs.access(scriptPath);
  } catch {
    return jsonErr(500, `install.sh not found at ${scriptPath}`);
  }

  const localBin = await findClosedmeshBin();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      };
      const log = (text: string) => send({ kind: "stdout", text });

      log(`→ ${plan.user}@${plan.host}:${plan.port}`);

      // Step 0 — generate an invite token from the LOCAL runtime, so the
      // remote node knows which mesh to join.
      let token: string | null = null;
      if (localBin) {
        send({ kind: "step", name: "invite", ok: true });
        log("Creating invite token from local mesh…");
        const result = await runClosedmesh(localBin, ["invite", "create"]);
        if (result.ok) {
          token =
            result.stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .map((l) => {
                const m = l.match(/[A-Za-z0-9_\-]{20,}/);
                return m ? m[0] : null;
              })
              .filter((s): s is string => !!s)
              .sort((a, b) => b.length - a.length)[0] ?? null;
        }
        if (!token) {
          log(
            "Couldn't read invite token from local CLI; remote will install but not auto-join.",
          );
        }
      } else {
        log(
          "Local closedmesh binary not found — remote will install but not auto-join. Install locally first to get full mesh-join behaviour.",
        );
      }

      // Step 1 — pipe install.sh into bash on the remote.
      send({ kind: "step", name: "install", ok: true });
      log(
        `Streaming install.sh → ssh ${plan.user}@${plan.host} (will detect hardware on remote)…`,
      );

      const installEnv = plan.backend
        ? `CLOSEDMESH_BACKEND=${plan.backend} `
        : "";
      const installArgs = buildSshArgs(
        plan,
        `${installEnv}bash -s -- --no-start-service`,
      );

      const installOk = await runStreaming(
        "ssh",
        installArgs,
        send,
        scriptPath,
      );
      if (!installOk) {
        send({
          kind: "done",
          ok: false,
          code: -1,
          message: "Remote install failed.",
        });
        controller.close();
        return;
      }

      // Step 2 — start the runtime on the remote, joined to this mesh.
      send({ kind: "step", name: "join", ok: true });
      const joinArg = token ? `--join ${token}` : "";
      const remoteStartCmd = [
        // Persist past the SSH session. The user wants their vast.ai box
        // to keep serving after they close the laptop lid.
        "nohup",
        "$HOME/.local/bin/closedmesh",
        "serve",
        joinArg,
        "</dev/null",
        ">/tmp/closedmesh.log",
        "2>&1",
        "&",
        "echo started",
      ]
        .filter(Boolean)
        .join(" ");
      log(`Remote: ${remoteStartCmd.replace(joinArg, joinArg ? "--join ***" : "")}`);

      const startArgs = buildSshArgs(plan, `bash -lc '${remoteStartCmd}'`);
      const startOk = await runStreaming("ssh", startArgs, send);
      send({ kind: "done", ok: startOk, code: startOk ? 0 : 1 });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function jsonErr(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Spawns `cmd args...`, optionally piping a local file into stdin, and
 * forwards its stdout/stderr line-by-line to the NDJSON sink. Resolves
 * to the boolean exit success (code === 0).
 */
async function runStreaming(
  cmd: string,
  args: string[],
  send: (obj: Record<string, unknown>) => void,
  stdinFromFile?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: [stdinFromFile ? "pipe" : "ignore", "pipe", "pipe"],
      env: process.env,
    });

    if (stdinFromFile && child.stdin) {
      // Stream the local file into ssh stdin. We use a Node read stream
      // rather than reading the whole file into memory because install.sh
      // is small today (~13KB) but we'd like the wiring to scale if it
      // ever embeds release archives.
      import("node:fs").then(({ createReadStream }) => {
        const rs = createReadStream(stdinFromFile);
        rs.pipe(child.stdin!);
        rs.on("error", (err) => {
          send({ kind: "error", message: `read install.sh: ${err.message}` });
          child.kill("SIGTERM");
        });
      });
    }

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) send({ kind: "stdout", text: line });
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) send({ kind: "stderr", text: line });
      }
    });
    child.on("error", (err) => {
      send({ kind: "error", message: err.message });
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}
