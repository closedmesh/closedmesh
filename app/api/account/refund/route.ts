import { NextResponse } from "next/server";
import {
  listWalletRefunds,
  requestCustomerRefund,
} from "../../../lib/customer-refunds";
import { customerStoreReady } from "../../../lib/customer-ledger";
import { microsToUsd } from "../../../lib/rate-card";
import { MIN_WITHDRAW_USDC_ATOMIC } from "../../../lib/solana-config";
import {
  refundListMessage,
  refundMessage,
  verifyWalletSignature,
} from "../../../lib/wallet-auth";

/**
 * GET — signed list of refund tickets.
 * POST — signed refund request for remaining (or partial) API balance.
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
    message: refundListMessage(wallet, timestampMs),
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const refunds = await listWalletRefunds(wallet);
  return NextResponse.json({
    wallet,
    min_withdraw_usd: microsToUsd(MIN_WITHDRAW_USDC_ATOMIC),
    refunds: refunds.map((r) => ({
      ...r,
      usd: microsToUsd(r.micros),
    })),
  });
}

export async function POST(req: Request) {
  if (!customerStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  let body: {
    wallet?: string;
    destination?: string;
    timestampMs?: number;
    signatureBase58?: string;
    note?: string;
    micros?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const wallet = body.wallet?.trim() ?? "";
  const destination = body.destination?.trim() || wallet;
  const timestampMs = Number(body.timestampMs);
  const signatureBase58 = body.signatureBase58?.trim() ?? "";
  const message = refundMessage(wallet, destination, timestampMs);
  const auth = verifyWalletSignature({
    wallet,
    message,
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const result = await requestCustomerRefund({
    wallet,
    destination,
    note: body.note,
    micros: body.micros,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        min_withdraw_usd: microsToUsd(MIN_WITHDRAW_USDC_ATOMIC),
      },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    request: {
      ...result.request,
      usd: microsToUsd(result.request.micros),
    },
    hint: "Refund queued. Ops settles USDC back to destination (preview).",
  });
}
