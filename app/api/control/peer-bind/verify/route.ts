import { NextResponse } from "next/server";
import { isPublic } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_BASE = (
  process.env.SENDA_PUBLIC_ORIGIN ?? "https://senda.network"
).trim();

/** Desktop proxy → POST /api/account/peer-bind/verify */
export async function POST(req: Request) {
  if (isPublic) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const body = await req.text();
  try {
    const res = await fetch(`${PUBLIC_BASE}/api/account/peer-bind/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "public_unreachable" },
      { status: 502 },
    );
  }
}
