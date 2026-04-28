import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const isPublic =
  process.env.NEXT_PUBLIC_DEPLOYMENT === "public" ||
  process.env.CLOSEDMESH_DEPLOYMENT === "public" ||
  process.env.FORGEMESH_DEPLOYMENT === "public";

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

export async function findClosedmeshBin(): Promise<string | null> {
  if (cachedBin) return cachedBin;
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
