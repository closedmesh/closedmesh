import { NextResponse } from "next/server";
import {
  apiKeysStoreReady,
  mintApiKey,
  revokeApiKey,
} from "../../../lib/api-keys";

/**
 * POST /api/account/admin-key — mint a ck_ key for an account (Slice 1 ops).
 * DELETE — revoke by prefix.
 *
 * Auth: Authorization: Bearer $CRON_SECRET
 * Body POST: { accountId }
 * Body DELETE: { accountId, prefix }
 */

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!apiKeysStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  let body: { accountId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const accountId = body.accountId?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "account_required" }, { status: 400 });
  }

  const result = await mintApiKey(accountId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    accountId,
    prefix: result.prefix,
    /** Shown once — store it; we only keep the hash. */
    apiKey: result.plaintext,
    createdAt: result.record.createdAt,
  });
}

export async function DELETE(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!apiKeysStoreReady()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  let body: { accountId?: string; prefix?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await revokeApiKey({
    accountId: body.accountId ?? "",
    prefix: body.prefix ?? "",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
