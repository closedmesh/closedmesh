import { NextResponse } from "next/server";
import {
  customerStoreReady,
  getCustomerBalance,
} from "../../../lib/customer-ledger";
import { microsToUsd } from "../../../lib/rate-card";

/**
 * GET /api/account/balance?wallet=… — customer USD balance (account id = wallet).
 */
export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet")?.trim();
  if (!wallet) {
    return NextResponse.json({ error: "wallet_required" }, { status: 400 });
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
