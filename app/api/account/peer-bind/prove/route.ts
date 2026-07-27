import { NextResponse } from "next/server";
import {
  peerSelfServePayoutsEnabled,
  provePeerBindNode,
} from "../../../../lib/peer-bind";
import { peerEarningsStoreReady } from "../../../../lib/peer-earnings";

/**
 * POST /api/account/peer-bind/prove
 * Step 1: prove control of the iroh node key for a challenge.
 */
export async function POST(req: Request) {
  if (!peerSelfServePayoutsEnabled()) {
    return NextResponse.json(
      { error: "self_serve_disabled" },
      { status: 403 },
    );
  }
  if (!peerEarningsStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  let body: {
    challengeId?: string;
    nodePubkeyHex?: string;
    nodeSignatureHex?: string;
    timestampMs?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await provePeerBindNode({
    challengeId: body.challengeId ?? "",
    nodePubkeyHex: body.nodePubkeyHex ?? "",
    nodeSignatureHex: body.nodeSignatureHex ?? "",
    timestampMs: Number(body.timestampMs),
  });

  if (!result.ok) {
    const status =
      result.error === "self_serve_disabled"
        ? 403
        : result.error === "store_unavailable"
          ? 503
          : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const origin = (
    process.env.SENDA_PUBLIC_ORIGIN ?? "https://senda.network"
  ).replace(/\/$/, "");
  return NextResponse.json({
    ok: true,
    peerId: result.peerId,
    challengeId: result.challengeId,
    bindUrl: `${origin}/peer-bind?c=${encodeURIComponent(result.challengeId)}`,
  });
}
