import { NextResponse } from "next/server";
import {
  attachPeerBindWallet,
  getPeerBindChallengeStatus,
  peerSelfServePayoutsEnabled,
} from "../../../../lib/peer-bind";
import { peerEarningsStoreReady } from "../../../../lib/peer-earnings";

/**
 * GET /api/account/peer-bind/verify?challengeId=…
 * Status of a bind challenge (for the public Phantom page).
 */
export async function GET(req: Request) {
  const challengeId = new URL(req.url).searchParams.get("challengeId")?.trim();
  if (!challengeId) {
    return NextResponse.json({ error: "challengeId_required" }, { status: 400 });
  }
  const status = await getPeerBindChallengeStatus(challengeId);
  if (!status.ok) {
    return NextResponse.json({ error: status.error }, { status: 404 });
  }
  return NextResponse.json(status);
}

/**
 * POST /api/account/peer-bind/verify
 * Step 2: attach Solana wallet (Phantom) to a node-proven challenge.
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
    wallet?: string;
    walletSignatureBase58?: string;
    timestampMs?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await attachPeerBindWallet({
    challengeId: body.challengeId ?? "",
    wallet: body.wallet ?? "",
    walletSignatureBase58: body.walletSignatureBase58 ?? "",
    timestampMs: Number(body.timestampMs),
  });

  if (!result.ok) {
    const status =
      result.error === "self_serve_disabled"
        ? 403
        : result.error === "store_unavailable" || result.error === "redis_error"
          ? 503
          : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    peerId: result.peerId,
    payout_wallet: result.wallet,
  });
}
