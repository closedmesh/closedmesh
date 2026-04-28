import { NextResponse } from "next/server";
import { isPublic, LOG_PATHS, tailFile } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isPublic) {
    return NextResponse.json(
      { ok: false, message: "Logs are not exposed on the public deployment." },
      { status: 403 },
    );
  }
  const [stdout, stderr] = await Promise.all([
    tailFile(LOG_PATHS.stdout),
    tailFile(LOG_PATHS.stderr),
  ]);
  return NextResponse.json({
    ok: true,
    paths: LOG_PATHS,
    stdout,
    stderr,
  });
}
