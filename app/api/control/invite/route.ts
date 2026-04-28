import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a one-time invite token by shelling out to
 * `closedmesh invite create`. The CLI prints the token on stdout.
 */
export async function POST() {
  if (isPublic) {
    return NextResponse.json(
      {
        ok: false,
        message: "Control panel is disabled on the public deployment.",
      },
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

  const result = await runClosedmesh(bin, ["invite", "create"]);
  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      message:
        result.stderr ||
        result.stdout ||
        "invite create failed (is the service running?)",
    });
  }

  // The CLI may emit the token on its own line, possibly with a label.
  // Pick the longest non-trivial token-like string as a heuristic.
  const lines = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const token =
    lines
      .map((l) => {
        const m = l.match(/[A-Za-z0-9_\-]{20,}/);
        return m ? m[0] : null;
      })
      .filter((s): s is string => !!s)
      .sort((a, b) => b.length - a.length)[0] ?? null;

  if (!token) {
    return NextResponse.json({
      ok: false,
      message: "Couldn't parse invite token from CLI output.",
    });
  }

  return NextResponse.json({
    ok: true,
    token,
    message: "Invite token created.",
  });
}
