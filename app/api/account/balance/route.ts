import { NextResponse } from "next/server";
import {
  customerStoreReady,
  getCustomerBalance,
} from "../../../lib/customer-ledger";
import { microsToUsd } from "../../../lib/rate-card";
import {
  balanceMessage,
  verifyWalletSignature,
} from "../../../lib/wallet-auth";

/**
 * GET /api/account/balance?wallet=&timestampMs=&signatureBase58=
 * Wallet-signed balance read.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  const timestampMs = Number(url.searchParams.get("timestampMs"));
  const signatureBase58 = url.searchParams.get("signatureBase58")?.trim() ?? "";
  if (!wallet) {
    return NextResponse.json({ error: "wallet_required" }, { status: 400 });
  }
  const auth = verifyWalletSignature({
    wallet,
    message: balanceMessage(wallet, timestampMs),
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  if (!customerStoreReady()) {
    return NextResponse.json({ storeReady: false, balance_usd_micros: null });
  }
  const micros = await getCustomerBalance(wallet);
  if (micros == null) {
    return NextResponse.json({ storeReady: false, balance_usd_micros: null });
  }
  return NextResponse.json({
    storeReady: true,
    accountId: wallet,
    balance_usd_micros: micros,
    balance_usd: microsToUsd(micros),
  });
}
