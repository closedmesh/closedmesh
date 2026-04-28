import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const result = await runClosedmesh(bin, ["service", "start"]);
  return NextResponse.json({
    ok: result.ok,
    message: result.ok
      ? "ClosedMesh started."
      : (result.stderr || result.stdout || "start failed"),
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  });
}
