import { NextResponse } from "next/server";
import {
  findSendaBin,
  isPublic,
  runSenda,
} from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Status = {
  available: boolean;
  binPath: string | null;
  service:
    | { state: "running"; pid: number | null }
    | { state: "stopped" }
    | { state: "unknown"; reason: string }
    | { state: "unavailable" };
  publicDeployment: boolean;
};

function parseStatus(out: string): Status["service"] {
  const txt = out.trim();
  if (!txt) return { state: "unknown", reason: "empty status output" };
  const lower = txt.toLowerCase();

  // `senda service status` writes one of:
  //   "Senda service: running (pid 12345)"
  //   "Senda service: active (pid 12345)"  — launchctl state on some macOS
  //   "Senda service: stopped"
  //   "Senda service: not loaded" / "not registered"
  //   "Senda service: unknown — <reason>"
  // Treat launchd "active" the same as "running" — otherwise the desktop
  // chat empty-state screams "Couldn't join the mesh" while the service is up.
  if (
    /\b(running|active)\b/.test(lower) &&
    !/\b(inactive|not active)\b/.test(lower)
  ) {
    const m = txt.match(/pid\s+(\d+)/i);
    return { state: "running", pid: m ? Number(m[1]) : null };
  }
  if (
    lower.includes("stopped") ||
    lower.includes("not loaded") ||
    lower.includes("not registered") ||
    lower.includes("not installed")
  ) {
    return { state: "stopped" };
  }
  return { state: "unknown", reason: txt };
}

export async function GET() {
  if (isPublic) {
    const status: Status = {
      available: false,
      binPath: null,
      service: { state: "unavailable" },
      publicDeployment: true,
    };
    return NextResponse.json(status);
  }

  const bin = await findSendaBin();
  if (!bin) {
    const status: Status = {
      available: false,
      binPath: null,
      service: { state: "unavailable" },
      publicDeployment: false,
    };
    return NextResponse.json(status);
  }

  const result = await runSenda(bin, ["service", "status"]);
  const service = parseStatus(result.stdout || result.stderr);

  const status: Status = {
    available: true,
    binPath: bin,
    service,
    publicDeployment: false,
  };
  return NextResponse.json(status);
}
