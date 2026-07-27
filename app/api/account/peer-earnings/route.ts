import { NextResponse } from "next/server";
import {
  getPeerPayoutWallet,
  getPeerUsdBalance,
  peerEarningsStoreReady,
} from "../../../lib/peer-earnings";
import { microsToUsd } from "../../../lib/rate-card";
import { MIN_WITHDRAW_USDC_ATOMIC } from "../../../lib/solana-config";

/**
 * GET /api/account/peer-earnings?peerId=…
 * Preview liability read (non-binding). Self-serve withdraw is ops-only.
 */
export async function GET(req: Request) {
  const peerId = new URL(req.url).searchParams.get("peerId")?.trim();
  if (!peerId) {
    return NextResponse.json({ error: "peerId_required" }, { status: 400 });
  }
  if (!peerEarningsStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
  const balance = await getPeerUsdBalance(peerId);
  const wallet = await getPeerPayoutWallet(peerId);
  return NextResponse.json({
    peerId,
    balance_usd_micros: balance,
    balance_usd: balance == null ? null : microsToUsd(balance),
    payout_wallet: wallet,
    min_withdraw_usd: microsToUsd(MIN_WITHDRAW_USDC_ATOMIC),
    note: "Peer USD accrues on paid /v1 mesh serves (preview liability). Cash payouts are ops-gated — not self-serve.",
  });
}

export async function POST() {
  return NextResponse.json(
    {
      error: "peer_payouts_ops_only",
      hint: "Self-serve peer payouts are disabled. Ops use /api/account/admin-payout.",
    },
    { status: 403 },
  );
}
