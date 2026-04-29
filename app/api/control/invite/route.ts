import { NextResponse } from "next/server";
import { isPublic } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The runtime publishes the local node's join token directly on the admin
// status payload — same envs as `app/api/status/route.ts` so an operator can
// repoint both the chat surface and the control panel at a remote runtime
// with a single override. Trim defensively against trailing-newline env
// values (Vercel has shipped those to us before).
function trimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value) return value;
  }
  return undefined;
}

const ADMIN_URL =
  trimmedEnv("CLOSEDMESH_ADMIN_URL", "MESH_CONSOLE_URL") ??
  "http://127.0.0.1:3131";

const RUNTIME_TOKEN = trimmedEnv("CLOSEDMESH_RUNTIME_TOKEN") ?? "";

const adminHeaders: Record<string, string> = RUNTIME_TOKEN
  ? { Authorization: `Bearer ${RUNTIME_TOKEN}` }
  : {};

/**
 * Returns a one-time invite token a teammate can paste on their machine to
 * join this mesh. The runtime mints the token at startup and publishes it on
 * `/api/status` — there is intentionally no `closedmesh invite create` CLI
 * subcommand, since the token is just an addressable identity for the local
 * node and is regenerated each time the service starts.
 *
 * The token is the same value the CLI consumes via `--join <token>`.
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

  let payload: { token?: unknown } | null = null;
  try {
    const res = await fetch(`${ADMIN_URL}/api/status`, {
      cache: "no-store",
      headers: adminHeaders,
    });
    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        message: `Runtime returned ${res.status} on /api/status — is the service running?`,
      });
    }
    payload = (await res.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({
      ok: false,
      message:
        "Couldn't reach the local runtime on :3131. Start the ClosedMesh service and try again.",
    });
  }

  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (!token) {
    return NextResponse.json({
      ok: false,
      message:
        "Runtime didn't return a join token yet. Give the service a few seconds to finish starting.",
    });
  }

  return NextResponse.json({
    ok: true,
    token,
    message: "Invite token created.",
  });
}
