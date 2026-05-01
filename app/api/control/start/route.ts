import { NextResponse } from "next/server";
import { extractStartError, findClosedmeshBin, isPublic, runClosedmesh } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** True when the error text looks like a launchctl bootstrap failure. */
function isBootstrapError(raw: string): boolean {
  return /bootstrap.*failed|launchctl.*bootstrap/i.test(raw);
}

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

  let result = await runClosedmesh(bin, ["service", "start"]);

  // On a fresh machine the launchd plist may not yet exist, causing
  // `service start` → `launchctl bootstrap` to fail with exit code 5 (EIO).
  // Run `service install` (which writes the plist) and retry once.
  if (!result.ok && isBootstrapError(result.stderr || result.stdout || "")) {
    const install = await runClosedmesh(bin, ["service", "install"], 15_000);
    if (install.ok) {
      result = await runClosedmesh(bin, ["service", "start"]);
    }
  }

  const rawError = result.stderr || result.stdout || "";
  return NextResponse.json({
    ok: result.ok,
    message: result.ok ? "ClosedMesh started." : extractStartError(rawError),
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  });
}
