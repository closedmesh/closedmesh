import { NextResponse } from "next/server";
import {
  ensureWalletPeerIndex,
  getPeerPayoutWallet,
  getPeerUsdBalance,
  newPeerPayoutId,
  peerEarningsStoreReady,
  requestPeerPayout,
} from "../../../lib/peer-earnings";
import {
  peerSelfServePayoutsEnabled,
} from "../../../lib/peer-bind";
import { microsToUsd } from "../../../lib/rate-card";
import { MIN_WITHDRAW_USDC_ATOMIC } from "../../../lib/solana-config";
import { shortPeerId } from "../../../lib/verification-receipts";
import {
  peerPayoutRequestMessage,
  verifyWalletSignature,
} from "../../../lib/wallet-auth";

/**
 * GET /api/account/peer-earnings?peerId=…
 * Peer USD liability + bound payout wallet (if any).
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
  if (wallet) {
    // Backfill wallet→peer index for binds that predated /earn sign-in.
    await ensureWalletPeerIndex(peerId, wallet);
  }
  const selfServe = peerSelfServePayoutsEnabled();
  return NextResponse.json({
    peerId: shortPeerId(peerId),
    balance_usd_micros: balance,
    balance_usd: balance == null ? null : microsToUsd(balance),
    payout_wallet: wallet,
    min_withdraw_usd: microsToUsd(MIN_WITHDRAW_USDC_ATOMIC),
    self_serve: selfServe,
    note: selfServe
      ? "Peer USD accrues on paid /v1 mesh serves. Bind a wallet with node-key proof to request payout (≥ $10)."
      : "Peer USD accrues on paid /v1 mesh serves. Cash payouts are ops-gated.",
  });
}

/**
 * POST — self-serve payout request (bound wallet + Phantom signature).
 * Body: { peerId, wallet, timestampMs, signatureBase58 }
 */
export async function POST(req: Request) {
  if (!peerSelfServePayoutsEnabled()) {
    return NextResponse.json(
      {
        error: "peer_payouts_ops_only",
        hint: "Self-serve peer payouts are disabled. Ops use /api/account/admin-payout.",
      },
      { status: 403 },
    );
  }
  if (!peerEarningsStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  let body: {
    peerId?: string;
    wallet?: string;
    timestampMs?: number;
    signatureBase58?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const peerId = shortPeerId(body.peerId ?? "");
  const wallet = (body.wallet ?? "").trim();
  const timestampMs = Number(body.timestampMs);
  if (!peerId || !wallet) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const bound = await getPeerPayoutWallet(peerId);
  if (!bound) {
    return NextResponse.json({ error: "wallet_not_registered" }, { status: 400 });
  }
  if (bound !== wallet) {
    return NextResponse.json({ error: "wallet_mismatch" }, { status: 400 });
  }

  const message = peerPayoutRequestMessage(peerId, wallet, timestampMs);
  const verified = verifyWalletSignature({
    wallet,
    message,
    signatureBase58: body.signatureBase58 ?? "",
    timestampMs,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  const result = await requestPeerPayout({
    peerId,
    payoutId: newPeerPayoutId(),
  });
  if (!result.ok) {
    const status = result.error === "below_minimum" ? 400 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    request: {
      id: result.request.id,
      peerId: result.request.peerId,
      wallet: result.request.wallet,
      usd: microsToUsd(result.request.micros),
      status: result.request.status,
      createdAt: result.request.createdAt,
    },
  });
}
