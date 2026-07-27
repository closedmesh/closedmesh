import { NextResponse } from "next/server";
import {
  listPendingPeerPayouts,
  processPendingPeerPayouts,
  updatePeerPayout,
  restorePeerUsd,
  setPeerPayoutWallet,
  requestPeerPayout,
  newPeerPayoutId,
  type PeerPayoutRequest,
} from "../../../lib/peer-earnings";
import { microsToUsd } from "../../../lib/rate-card";
import { solanaPayoutsConfigured } from "../../../lib/solana-config";

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * GET /api/account/admin-payout — pending peer USDC payouts.
 * POST — process / mark / register_wallet / request_payout (ops-only).
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pending = await listPendingPeerPayouts(50);
  return NextResponse.json({
    payoutsConfigured: solanaPayoutsConfigured(),
    pending: pending.map((p) => ({
      ...p,
      usd: microsToUsd(p.micros),
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
    peerId?: string;
    wallet?: string;
    txSignature?: string;
    error?: string;
    request?: PeerPayoutRequest;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action?.trim() ?? "";

  if (action === "register_wallet") {
    const peerId = body.peerId?.trim() ?? "";
    const wallet = body.wallet?.trim() ?? "";
    const set = await setPeerPayoutWallet(peerId, wallet);
    if (!set.ok) {
      return NextResponse.json({ error: set.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, peerId, payout_wallet: wallet });
  }

  if (action === "request_payout") {
    const peerId = body.peerId?.trim() ?? "";
    if (!peerId) {
      return NextResponse.json({ error: "peerId_required" }, { status: 400 });
    }
    const result = await requestPeerPayout({
      peerId,
      payoutId: newPeerPayoutId(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      request: {
        ...result.request,
        usd: microsToUsd(result.request.micros),
      },
    });
  }

  if (action === "process") {
    const result = await processPendingPeerPayouts(10);
    return NextResponse.json({ ok: true, ...result });
  }

  if (action === "mark_sent") {
    const pending = await listPendingPeerPayouts(100);
    const ticket = pending.find((p) => p.id === body.id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const tx = body.txSignature?.trim() ?? "";
    if (!tx) {
      return NextResponse.json({ error: "txSignature_required" }, { status: 400 });
    }
    ticket.status = "sent";
    ticket.txSignature = tx;
    await updatePeerPayout(ticket);
    return NextResponse.json({ ok: true, request: ticket });
  }

  if (action === "mark_failed") {
    const pending = await listPendingPeerPayouts(100);
    const ticket = pending.find((p) => p.id === body.id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    ticket.status = "failed";
    ticket.error = body.error?.trim() || "ops_failed";
    await updatePeerPayout(ticket);
    await restorePeerUsd(ticket.peerId, ticket.micros);
    return NextResponse.json({ ok: true, request: ticket });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
