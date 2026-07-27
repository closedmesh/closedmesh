import { NextResponse } from "next/server";
import {
  cancelRefund,
  claimRefundForSend,
  getRefund,
  listPendingRefunds,
  markRefundPaid,
} from "../../../lib/customer-refunds";
import { microsToUsd } from "../../../lib/rate-card";
import { sendUsdc } from "../../../lib/solana-usdc-send";
import { solanaPayoutsConfigured } from "../../../lib/solana-config";

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * GET /api/account/admin-refund — list pending refunds (ops).
 * POST — { action: "pay"|"cancel"|"send", id, txSignature? }
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pending = await listPendingRefunds(50);
  return NextResponse.json({
    payoutsConfigured: solanaPayoutsConfigured(),
    pending: pending.map((r) => ({
      ...r,
      usd: microsToUsd(r.micros),
    })),
  });
}

export async function POST(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    action?: string;
    id?: string;
    txSignature?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const id = body.id?.trim() ?? "";
  const action = body.action?.trim() ?? "";
  if (!id || !action) {
    return NextResponse.json({ error: "id_and_action_required" }, { status: 400 });
  }

  if (action === "cancel") {
    const result = await cancelRefund({ id });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, request: result.request });
  }

  if (action === "pay") {
    const tx = body.txSignature?.trim() ?? "";
    if (!tx) {
      return NextResponse.json({ error: "txSignature_required" }, { status: 400 });
    }
    const result = await markRefundPaid({ id, txSignature: tx });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, request: result.request });
  }

  if (action === "send") {
    const existing = await getRefund(id);
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (existing.txSignature) {
      return NextResponse.json(
        {
          error: "already_sent",
          request: existing,
          hint: "Refund already has a tx signature — do not re-send",
        },
        { status: 409 },
      );
    }
    if (!solanaPayoutsConfigured()) {
      return NextResponse.json(
        { error: "payer_not_configured", hint: "Set SENDA_SOLANA_PAYER_SECRET" },
        { status: 503 },
      );
    }

    const claimed = await claimRefundForSend(id);
    if (!claimed.ok) {
      return NextResponse.json({ error: claimed.error }, { status: 409 });
    }
    if (claimed.request.txSignature) {
      return NextResponse.json(
        { error: "already_sent", request: claimed.request },
        { status: 409 },
      );
    }

    const sent = await sendUsdc({
      destinationWallet: claimed.request.destination,
      amountAtomic: claimed.request.micros,
    });
    if (!sent.ok) {
      // Leave status sending for ops reconcile; do not auto-retry blindly.
      return NextResponse.json(
        {
          error: sent.error,
          request: claimed.request,
          hint: "Send failed after claim — reconcile before retry",
        },
        { status: 502 },
      );
    }

    const result = await markRefundPaid({
      id,
      txSignature: sent.signature,
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          sentSignature: sent.signature,
          hint: "USDC sent but mark-paid failed — reconcile manually; do not re-send",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, request: result.request });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
