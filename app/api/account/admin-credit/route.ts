import { NextResponse } from "next/server";
import {
  creditCustomer,
  customerStoreReady,
  getCustomerBalance,
} from "../../../lib/customer-ledger";
import { usdToMicros } from "../../../lib/rate-card";

/**
 * POST /api/account/admin-credit — Slice 0 ops stand-in for USDC top-up.
 *
 * Auth: Authorization: Bearer $CRON_SECRET
 * Body: { accountId, usd?, micros?, depositId? }
 *
 * GET with same auth + ?account=… → balance read (ops check).
 */

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const accountId = new URL(req.url).searchParams.get("account")?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "account_required" }, { status: 400 });
  }
  if (!customerStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
  const balance = await getCustomerBalance(accountId);
  return NextResponse.json({
    storeReady: true,
    accountId,
    balance_usd_micros: balance,
  });
}

export async function POST(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!customerStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  let body: {
    accountId?: string;
    usd?: number;
    micros?: number;
    depositId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const accountId = body.accountId?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "account_required" }, { status: 400 });
  }

  let micros = 0;
  if (typeof body.micros === "number") {
    micros = body.micros;
  } else if (typeof body.usd === "number") {
    micros = usdToMicros(body.usd);
  }
  if (micros <= 0) {
    return NextResponse.json(
      { error: "usd_or_micros_required" },
      { status: 400 },
    );
  }

  const result = await creditCustomer({
    accountId,
    micros,
    reason: "admin",
    depositId: body.depositId?.trim() || undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    accountId,
    balance_usd_micros: result.balance,
    credited_usd_micros: Math.floor(micros),
  });
}
