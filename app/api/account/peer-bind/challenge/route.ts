import { NextResponse } from "next/server";
import {
  createPeerBindChallenge,
  peerSelfServePayoutsEnabled,
} from "../../../../lib/peer-bind";
import { peerEarningsStoreReady } from "../../../../lib/peer-earnings";

/**
 * POST /api/account/peer-bind/challenge
 * Issue a one-time challenge for node-key + wallet bind.
 */
export async function POST() {
  if (!peerSelfServePayoutsEnabled()) {
    return NextResponse.json(
      { error: "self_serve_disabled" },
      { status: 403 },
    );
  }
  if (!peerEarningsStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
  try {
    const challenge = await createPeerBindChallenge();
    return NextResponse.json({
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      timestampMs: challenge.timestampMs,
    });
  } catch {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
}
