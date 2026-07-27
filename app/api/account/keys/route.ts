import { NextResponse } from "next/server";
import {
  listApiKeys,
  mintApiKey,
  revokeApiKey,
} from "../../../lib/api-keys";
import {
  listKeysMessage,
  mintKeyMessage,
  revokeKeyMessage,
  verifyWalletSignature,
} from "../../../lib/wallet-auth";

/**
 * GET — list key prefixes (signed).
 * POST — mint ck_ after Solana wallet signature.
 * DELETE — revoke by prefix (signed).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  const timestampMs = Number(url.searchParams.get("timestampMs"));
  const signatureBase58 = url.searchParams.get("signatureBase58")?.trim() ?? "";
  const auth = verifyWalletSignature({
    wallet,
    message: listKeysMessage(wallet, timestampMs),
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const keys = await listApiKeys(wallet);
  return NextResponse.json({
    wallet,
    keys: keys.map((k) => ({
      prefix: k.prefix,
      createdAt: k.createdAt,
      revoked: !!k.revokedAt,
    })),
  });
}

export async function POST(req: Request) {
  let body: {
    wallet?: string;
    timestampMs?: number;
    signatureBase58?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const wallet = body.wallet?.trim() ?? "";
  const timestampMs = Number(body.timestampMs);
  const signatureBase58 = body.signatureBase58?.trim() ?? "";
  const message = mintKeyMessage(wallet, timestampMs);
  const auth = verifyWalletSignature({
    wallet,
    message,
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const result = await mintApiKey(wallet);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    accountId: wallet,
    prefix: result.prefix,
    apiKey: result.plaintext,
    createdAt: result.record.createdAt,
    hint: "Store apiKey now — it is only shown once.",
  });
}

export async function DELETE(req: Request) {
  let body: {
    wallet?: string;
    prefix?: string;
    timestampMs?: number;
    signatureBase58?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const wallet = body.wallet?.trim() ?? "";
  const prefix = body.prefix?.trim() ?? "";
  const timestampMs = Number(body.timestampMs);
  const signatureBase58 = body.signatureBase58?.trim() ?? "";
  const auth = verifyWalletSignature({
    wallet,
    message: revokeKeyMessage(wallet, prefix, timestampMs),
    signatureBase58,
    timestampMs,
  });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const result = await revokeApiKey({ accountId: wallet, prefix });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, prefix });
}
