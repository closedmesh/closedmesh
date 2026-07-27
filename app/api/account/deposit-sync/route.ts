import { NextResponse } from "next/server";
import { syncSolanaDeposits } from "../../../lib/solana-deposits";
import { solanaDepositsConfigured } from "../../../lib/solana-config";
import { reclaimExpiredReserves } from "../../../lib/customer-ledger";

/**
 * GET/POST /api/account/deposit-sync
 *
 * Cron (Bearer CRON_SECRET): scan all recent treasury deposits.
 * User (?wallet=): scan and credit only that wallet (no secret — public
 * sync is safe because credits only go to the sending wallet).
 */

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization")?.trim() === `Bearer ${secret}`;
}

async function handle(req: Request) {
  if (!solanaDepositsConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "treasury_unconfigured",
        hint: "Set SENDA_SOLANA_TREASURY (+ optional SENDA_SOLANA_RPC_URL)",
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() || undefined;
  const isCron = cronAuthorized(req);

  if (!wallet && !isCron) {
    return NextResponse.json(
      { error: "wallet_required_or_cron_auth" },
      { status: 401 },
    );
  }

  const reclaimed = await reclaimExpiredReserves(isCron ? 50 : 25);
  const result = await syncSolanaDeposits({
    onlyWallet: wallet,
    limit: isCron ? 40 : 25,
  });
  return NextResponse.json({ ok: true, reclaimed, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
