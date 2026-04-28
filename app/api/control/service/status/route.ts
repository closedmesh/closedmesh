import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reports whether the runtime is registered to start at login.
 *
 * On macOS we look for the launchd plist. On Linux we look for the
 * systemd-user unit. On Windows we shell out to `closedmesh service status`
 * and parse. Falling back to the CLI is fine but the file-based check is
 * faster and works even when the daemon is misbehaving.
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function detectAutostart(): Promise<boolean> {
  const platform = process.platform;
  if (platform === "darwin") {
    const plist = path.join(
      homedir(),
      "Library",
      "LaunchAgents",
      "com.closedmesh.runtime.plist",
    );
    if (await fileExists(plist)) return true;
    const legacy = path.join(
      homedir(),
      "Library",
      "LaunchAgents",
      "com.forgemesh.runtime.plist",
    );
    return fileExists(legacy);
  }
  if (platform === "linux") {
    const unit = path.join(
      homedir(),
      ".config",
      "systemd",
      "user",
      "closedmesh.service",
    );
    return fileExists(unit);
  }
  // Windows / others: fall back to CLI.
  const bin = await findClosedmeshBin();
  if (!bin) return false;
  const r = await runClosedmesh(bin, ["service", "status"]);
  return /installed|enabled|running/i.test(r.stdout);
}

export async function GET() {
  if (isPublic) {
    return NextResponse.json({
      ok: true,
      autostart: false,
      publicDeployment: true,
    });
  }
  const autostart = await detectAutostart();
  return NextResponse.json({ ok: true, autostart, publicDeployment: false });
}
