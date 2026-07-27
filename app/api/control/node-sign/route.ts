import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import { isPublic } from "../_lib";
import { shortPeerId } from "../../../lib/verification-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/control/node-sign
 * Desktop-only: sign a UTF-8 message with the local iroh node key
 * (~/.senda/key). Never available on public deployments.
 *
 * Body: { message: string }
 * → { peerId, nodePubkeyHex, signatureHex }
 */
export async function POST(req: Request) {
  if (isPublic) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }

  let body: { message?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const message = body.message;
  if (typeof message !== "string" || message.length === 0 || message.length > 4096) {
    return NextResponse.json({ error: "invalid_message" }, { status: 400 });
  }

  const keyPath = path.join(homedir(), ".senda", "key");
  let hex: string;
  try {
    hex = (await fs.readFile(keyPath, "utf8")).trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: "node_key_missing" }, { status: 503 });
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return NextResponse.json({ error: "node_key_invalid" }, { status: 500 });
  }

  const seed = hexToBytes(hex);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  const nodePubkeyHex = bytesToHex(kp.publicKey);
  const signatureHex = bytesToHex(sig);

  return NextResponse.json({
    peerId: shortPeerId(nodePubkeyHex),
    nodePubkeyHex,
    signatureHex,
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
