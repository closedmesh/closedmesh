import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove the launchd / systemd-user / Scheduled Task unit so ClosedMesh
 * stops auto-starting at login. The runtime keeps working for the current
 * session — this just unhooks autostart.
 */
export async function POST() {
  if (isPublic) {
    return NextResponse.json(
      { ok: false, message: "Control panel is disabled on the public deployment." },
      { status: 403 },
    );
  }
  const bin = await findClosedmeshBin();
  if (!bin) {
    return NextResponse.json(
      { ok: false, message: "closedmesh binary not found." },
      { status: 404 },
    );
  }
  const result = await runClosedmesh(bin, ["service", "uninstall"], 15000);
  return NextResponse.json({
    ok: result.ok,
    message: result.ok
      ? "ClosedMesh won't start automatically anymore."
      : (result.stderr || result.stdout || "service uninstall failed"),
  });
}
