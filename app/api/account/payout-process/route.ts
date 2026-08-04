import { NextResponse } from "next/server";
import { processPendingRefunds } from "../../../lib/customer-refunds";
import { processPendingPeerPayouts } from "../../../lib/peer-earnings";
import {
  peerPayoutDryRun,
  peerPayoutsAutoEnabled,
  refundsAutoEnabled,
  solanaPayoutsConfigured,
} from "../../../lib/solana-config";

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * GET/POST /api/account/payout-process — Vercel cron (5.D-auto).
 *
 * Peer payouts: SENDA_PEER_PAYOUTS_AUTO=1
 * Customer refunds: SENDA_REFUNDS_AUTO=1
 * Shared: SENDA_PAYOUT_DRY_RUN + spend caps.
 */
async function handle(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const peerAuto = peerPayoutsAutoEnabled();
  const refundAuto = refundsAutoEnabled();
  const dryRunEnv = peerPayoutDryRun();

  const peers = peerAuto
    ? await processPendingPeerPayouts(10)
    : {
        autoDisabled: true as const,
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        dryRun: 0,
        wouldSend: [] as [],
      };

  const refunds = refundAuto
    ? await processPendingRefunds(10)
    : {
        autoDisabled: true as const,
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        dryRun: 0,
        wouldSend: [] as [],
      };

  return NextResponse.json({
    ok: true,
    payoutsConfigured: solanaPayoutsConfigured(),
    dryRunEnv,
    peers: { autoEnabled: peerAuto, ...peers },
    refunds: { autoEnabled: refundAuto, ...refunds },
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
