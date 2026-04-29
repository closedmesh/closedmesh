import { NextResponse } from "next/server";
import {
  findClosedmeshBin,
  isPublic,
  runClosedmesh,
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

// Stable identifier the desktop shell uses to confirm "the thing on :3000 is
// actually our controller, not some unrelated Next.js dev server the user
// happens to be running on the same port." See `desktop/src/mesh.rs`'s
// `legacy_controller_up` for the consumer.
const CONTROLLER_HEADERS = { "X-ClosedMesh-Controller": "1" } as const;

function parseStatus(out: string): Status["service"] {
  const txt = out.trim();
  if (!txt) return { state: "unknown", reason: "empty status output" };
  const lower = txt.toLowerCase();

  // `closedmesh service status` writes one of:
  //   "ClosedMesh service: running (pid 12345)"
  //   "ClosedMesh service: stopped"
  //   "ClosedMesh service: unknown — <reason>"
  if (lower.includes("running")) {
    const m = txt.match(/pid\s+(\d+)/i);
    return { state: "running", pid: m ? Number(m[1]) : null };
  }
  if (lower.includes("stopped") || lower.includes("not loaded")) {
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
    return NextResponse.json(status, { headers: CONTROLLER_HEADERS });
  }

  const bin = await findClosedmeshBin();
  if (!bin) {
    const status: Status = {
      available: false,
      binPath: null,
      service: { state: "unavailable" },
      publicDeployment: false,
    };
    return NextResponse.json(status, { headers: CONTROLLER_HEADERS });
  }

  const result = await runClosedmesh(bin, ["service", "status"]);
  const service = parseStatus(result.stdout || result.stderr);

  const status: Status = {
    available: true,
    binPath: bin,
    service,
    publicDeployment: false,
  };
  return NextResponse.json(status, { headers: CONTROLLER_HEADERS });
}
