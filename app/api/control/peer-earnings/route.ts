import { NextResponse } from "next/server";
import { isPublic } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Desktop sidecar proxy for peer USD earnings / self-serve payout.
 * Production ledger lives on senda.network (Upstash).
 */
const PUBLIC_BASE = (
  process.env.SENDA_PUBLIC_ORIGIN ?? "https://senda.network"
).trim();

export async function GET(req: Request) {
  if (isPublic) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const peer = new URL(req.url).searchParams.get("peerId")?.trim();
  if (!peer) {
    return NextResponse.json({ error: "peerId_required" }, { status: 400 });
  }
  const target = new URL(`${PUBLIC_BASE}/api/account/peer-earnings`);
  target.searchParams.set("peerId", peer);
  return proxy(target.toString(), { method: "GET" });
}

export async function POST(req: Request) {
  if (isPublic) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const body = await req.text();
  return proxy(`${PUBLIC_BASE}/api/account/peer-earnings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function proxy(url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
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
