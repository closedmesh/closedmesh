import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Joins an existing mesh by re-launching the service with `--join <token>`.
 * Mirrors what the CLI hint in the README tells users to run manually:
 *
 *   closedmesh serve --join <invite-token>
 */
export async function POST(req: Request) {
  if (isPublic) {
    return NextResponse.json(
      {
        ok: false,
        message: "Control panel is disabled on the public deployment.",
      },
      { status: 403 },
    );
  }

  let token: string | null = null;
  try {
    const body = (await req.json()) as { token?: string };
    token = (body.token ?? "").trim() || null;
  } catch {
    // fall through; token stays null
  }
  if (!token) {
    return NextResponse.json(
      { ok: false, message: "Missing invite token." },
      { status: 400 },
    );
  }
  // Prevent shell-injection / argv abuse — invite tokens are URL-safe base64
  // by convention. Reject anything else loudly so a paste of a stray prompt
  // doesn't get exec'd.
  if (!/^[A-Za-z0-9_\-]+$/.test(token)) {
    return NextResponse.json(
      { ok: false, message: "Invite token contains invalid characters." },
      { status: 400 },
    );
  }

  const bin = await findClosedmeshBin();
  if (!bin) {
    return NextResponse.json(
      { ok: false, message: "closedmesh binary not found." },
      { status: 404 },
    );
  }

  // Stop the current service first so we can re-attach with the new token.
  await runClosedmesh(bin, ["service", "stop"], 6_000);
  const result = await runClosedmesh(
    bin,
    ["service", "start", "--join", token],
    20_000,
  );

  return NextResponse.json({
    ok: result.ok,
    message: result.ok
      ? "Joined the mesh — give it a few seconds for peers to appear."
      : result.stderr || result.stdout || "join failed",
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  });
}
