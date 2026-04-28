import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// `.trim()` defensively — a stray trailing newline in the Vercel env var
// (`"public\n"` vs `"public"`) would silently turn this flag off otherwise,
// and any /api/control/* handler would happily try to spawn closedmesh on
// a Vercel function. Belt-and-braces alongside proxy.ts.
function flagSet(value: string | undefined): boolean {
  return (value ?? "").trim() === "public";
}

export const isPublic =
  flagSet(process.env.NEXT_PUBLIC_DEPLOYMENT) ||
  flagSet(process.env.CLOSEDMESH_DEPLOYMENT) ||
  flagSet(process.env.FORGEMESH_DEPLOYMENT);

const explicit = process.env.CLOSEDMESH_BIN ?? process.env.FORGEMESH_BIN;

const candidates = [
  explicit,
  path.join(homedir(), ".local", "bin", "closedmesh"),
  "/opt/homebrew/bin/closedmesh",
  "/usr/local/bin/closedmesh",
  // Legacy fallbacks (one release of grace).
  path.join(homedir(), ".local", "bin", "forgemesh"),
  "/opt/homebrew/bin/forgemesh",
  "/usr/local/bin/forgemesh",
].filter((p): p is string => typeof p === "string" && p.length > 0);

let cachedBin: string | null = null;

/**
 * Locate the closedmesh runtime binary on disk.
 *
 * We cache the resolved path because `/api/control/status` polls every 4s
 * and stat'ing 6+ candidate paths on every poll is wasteful. But we
 * *re-verify* the cached path is still executable before returning it —
 * otherwise an uninstall (whether through the UI's `service uninstall`
 * flow or a manual `rm`) leaves the dashboard claiming the runtime is
 * still here, never showing the Setup screen again until the controller
 * is restarted. Re-stat'ing one path is essentially free.
 */
export async function findClosedmeshBin(): Promise<string | null> {
  if (cachedBin) {
    try {
      const stat = await fs.stat(cachedBin);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return cachedBin;
    } catch {
      // fall through and rescan; the cached path is no longer valid
    }
    cachedBin = null;
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        cachedBin = candidate;
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export type RunResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export function runClosedmesh(
  bin: string,
  args: string[],
  timeoutMs = 8000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr || "spawn failed" });
    });
  });
}

export const LOG_PATHS = {
  stdout: path.join(homedir(), "Library", "Logs", "closedmesh", "stdout.log"),
  stderr: path.join(homedir(), "Library", "Logs", "closedmesh", "stderr.log"),
};

export async function tailFile(filepath: string, maxBytes = 16_384) {
  try {
    const stat = await fs.stat(filepath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(filepath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
      return buf.toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
