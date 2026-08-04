import { NextResponse } from "next/server";
import {
  listPendingPeerPayouts,
  processPendingPeerPayouts,
  updatePeerPayout,
  restorePeerUsd,
  creditPeerUsd,
  getPeerPayout,
  getPeerUsdBalance,
  setPeerPayoutWallet,
  requestPeerPayout,
  newPeerPayoutId,
  type PeerPayoutRequest,
} from "../../../lib/peer-earnings";
import { microsToUsd, usdToMicros } from "../../../lib/rate-card";
import {
  peerPayoutMaxTicketMicros,
  solanaPayoutsConfigured,
} from "../../../lib/solana-config";

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
    /** Ops credit: USD (preferred) or micros */
    usd?: number;
    micros?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action?.trim() ?? "";

  if (action === "credit") {
    const peerId = body.peerId?.trim() ?? "";
    if (!peerId) {
      return NextResponse.json({ error: "peerId_required" }, { status: 400 });
    }
    let micros = 0;
    if (typeof body.micros === "number" && Number.isFinite(body.micros)) {
      micros = Math.floor(body.micros);
    } else if (typeof body.usd === "number" && Number.isFinite(body.usd)) {
      micros = usdToMicros(body.usd);
    }
    if (micros <= 0) {
      return NextResponse.json({ error: "usd_or_micros_required" }, { status: 400 });
    }
    // Hard ceiling: never ops-credit above current ticket cap.
    const max = peerPayoutMaxTicketMicros();
    if (micros > max) {
      return NextResponse.json(
        {
          error: "above_ticket_cap",
          max_usd: microsToUsd(max),
          hint: "Raise SENDA_PAYOUT_MAX_TICKET_USD or credit a smaller amount",
        },
        { status: 400 },
      );
    }
    const balance = await creditPeerUsd(peerId, micros);
    return NextResponse.json({
      ok: true,
      peerId,
      credited_usd: microsToUsd(micros),
      balance_usd: microsToUsd(balance),
      balance_usd_micros: balance,
    });
  }

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

  if (action === "index_history") {
    const id = body.id?.trim() ?? "";
    if (!id) {
      return NextResponse.json({ error: "id_required" }, { status: 400 });
    }
    const ticket = await getPeerPayout(id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await updatePeerPayout(ticket);
    return NextResponse.json({
      ok: true,
      request: { ...ticket, usd: microsToUsd(ticket.micros) },
      hint: "Indexed into history + paid_total if status=sent",
    });
  }

  if (action === "process") {
    // Ops intentional: bypass AUTO kill switch; still honors dry-run + caps.
    const result = await processPendingPeerPayouts(10, { force: true });
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
