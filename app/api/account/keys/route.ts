import { NextResponse } from "next/server";
import { mintApiKey } from "../../../lib/api-keys";
import { mintKeyMessage, verifyWalletSignature } from "../../../lib/wallet-auth";

/**
 * POST /api/account/keys — mint ck_ after Solana wallet signature.
 * Body: { wallet, timestampMs, signatureBase58 }
 */
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
