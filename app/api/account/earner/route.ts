import { NextResponse } from "next/server";
import {
  creditsStoreReady,
  getPeerCredits,
} from "../../../lib/credits-ledger";
import {
  getPeerIdForWallet,
  getPeerUsdBalance,
  listPendingPeerPayouts,
  peerEarningsStoreReady,
} from "../../../lib/peer-earnings";
import { peerSelfServePayoutsEnabled } from "../../../lib/peer-bind";
import { microsToUsd } from "../../../lib/rate-card";
import { MIN_WITHDRAW_USDC_ATOMIC } from "../../../lib/solana-config";
import { shortPeerId } from "../../../lib/verification-receipts";
import {
  earnerDashboardMessage,
  verifyWalletSignature,
} from "../../../lib/wallet-auth";

/**
 * GET /api/account/earner?wallet=&timestampMs=&signatureBase58=
 *
 * Phantom-signed earner dashboard: resolve bound peer from payout wallet,
 * return contributor credits, per-model tokens, Peer USD, pending payouts.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  const timestampMs = Number(url.searchParams.get("timestampMs"));
  const signatureBase58 =
    url.searchParams.get("signatureBase58")?.trim() ?? "";
  if (!wallet) {
    return NextResponse.json({ error: "wallet_required" }, { status: 400 });
  }

  const auth = verifyWalletSignature({
    wallet,
    message: earnerDashboardMessage(wallet, timestampMs),
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  if (!peerEarningsStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  const peerIdRaw = await getPeerIdForWallet(wallet);
  if (!peerIdRaw) {
    return NextResponse.json(
      {
        error: "wallet_not_bound",
        hint: "Bind this wallet in the Senda desktop app (Peer USD → Bind wallet), then return here.",
      },
      { status: 404 },
    );
  }
  const peerId = shortPeerId(peerIdRaw);

  const [usdMicros, credits, pendingAll] = await Promise.all([
    getPeerUsdBalance(peerId),
    creditsStoreReady() ? getPeerCredits(peerId) : Promise.resolve(null),
    listPendingPeerPayouts(50),
  ]);

  const pending = pendingAll
    .filter((p) => shortPeerId(p.peerId) === peerId)
    .map((p) => ({
      id: p.id,
      status: p.status,
      usd: microsToUsd(p.micros),
      createdAt: p.createdAt,
      txSignature: p.txSignature ?? null,
    }));

  const tokensByModel = credits?.tokensByModel ?? {};
  const totalTokens = Object.values(tokensByModel).reduce(
    (s, n) => s + (Number(n) || 0),
    0,
  );

  return NextResponse.json({
    ok: true,
    wallet,
    peerId,
    credits: {
      storeReady: creditsStoreReady(),
      credits: credits?.credits ?? 0,
      tokensByModel,
      totalTokens,
    },
    peerUsd: {
      storeReady: true,
      balance_usd_micros: usdMicros,
      balance_usd: usdMicros == null ? null : microsToUsd(usdMicros),
      payout_wallet: wallet,
      min_withdraw_usd: microsToUsd(MIN_WITHDRAW_USDC_ATOMIC),
      self_serve: peerSelfServePayoutsEnabled(),
    },
    pendingPayouts: pending,
  });
}
