import { NextResponse } from "next/server";
import { syncSolanaDeposits } from "../../../lib/solana-deposits";
import { solanaDepositsConfigured } from "../../../lib/solana-config";
import { reclaimExpiredReserves } from "../../../lib/customer-ledger";
import { getRedis } from "../../../lib/redis";
import {
  depositSyncMessage,
  verifyWalletSignature,
} from "../../../lib/wallet-auth";

/**
 * GET/POST /api/account/deposit-sync
 *
 * Cron (Bearer CRON_SECRET): scan all recent treasury deposits.
 * User: wallet-signed sync for that wallet only (rate-limited).
 */

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization")?.trim() === `Bearer ${secret}`;
}

async function rateLimitWallet(wallet: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    const key = `senda:ratelimit:deposit-sync:${wallet}`;
    const ok = await redis.set(key, "1", { nx: true, ex: 60 });
    return ok === "OK";
  } catch {
    return true;
  }
}

async function handle(req: Request) {
  if (!solanaDepositsConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "treasury_unconfigured",
        hint: "Set SENDA_SOLANA_TREASURY (+ optional HELIUS_API_KEY)",
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const isCron = cronAuthorized(req);
  let wallet = url.searchParams.get("wallet")?.trim() || undefined;

  if (!isCron) {
    const timestampMs = Number(url.searchParams.get("timestampMs"));
    const signatureBase58 =
      url.searchParams.get("signatureBase58")?.trim() ?? "";
    if (!wallet) {
      return NextResponse.json(
        { error: "wallet_required_or_cron_auth" },
        { status: 401 },
      );
    }
    const auth = verifyWalletSignature({
      wallet,
      message: depositSyncMessage(wallet, timestampMs),
      signatureBase58,
      timestampMs,
    });
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }
    const allowed = await rateLimitWallet(wallet);
    if (!allowed) {
      return NextResponse.json(
        { error: "rate_limited", hint: "Wait 60s between syncs" },
        { status: 429 },
      );
    }
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
