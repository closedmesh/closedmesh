import { NextResponse } from "next/server";
import { processPendingPeerPayouts } from "../../../lib/peer-earnings";
import {
  peerPayoutDryRun,
  peerPayoutsAutoEnabled,
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
 * Requires SENDA_PEER_PAYOUTS_AUTO=1. Honors SENDA_PAYOUT_DRY_RUN and spend caps.
 * Does not use force — ops use admin-payout action=process for manual runs.
 */
async function handle(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!peerPayoutsAutoEnabled()) {
    return NextResponse.json({
      ok: true,
      autoDisabled: true,
      hint: "Set SENDA_PEER_PAYOUTS_AUTO=1 after caps + canary checklist",
      payoutsConfigured: solanaPayoutsConfigured(),
      dryRun: peerPayoutDryRun(),
    });
  }

  const result = await processPendingPeerPayouts(10);
  return NextResponse.json({
    ok: true,
    payoutsConfigured: solanaPayoutsConfigured(),
    dryRunEnv: peerPayoutDryRun(),
    ...result,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
