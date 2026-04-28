import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Install the runtime as a launchd / systemd-user / Scheduled Task service.
 * Used by the "Start at login" toggle on the Settings page.
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
  const result = await runClosedmesh(bin, ["service", "install"], 15000);
  return NextResponse.json({
    ok: result.ok,
    message: result.ok
      ? "ClosedMesh will start automatically when you log in."
      : (result.stderr || result.stdout || "service install failed"),
  });
}
