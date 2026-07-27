import { NextResponse } from "next/server";
import { applyCors, preflightResponse } from "../../_cors";
import { extractBearerToken, resolveApiKey } from "../../../lib/api-keys";
import { paidApiEnabled } from "../../../lib/rate-card";
import { runtimeAuthHeaders, runtimeBaseUrl } from "../../../lib/runtime-proxy";

export const runtime = "nodejs";

export function OPTIONS(req: Request) {
  return preflightResponse(req);
}

/**
 * GET /v1/models — paid API model list (proxies entry after ck_ auth).
 */
export async function GET(req: Request) {
  if (!paidApiEnabled()) {
    return applyCors(
      req,
      NextResponse.json(
        { error: { message: "Paid API is not enabled" } },
        { status: 503 },
      ),
    );
  }

  const bearer = extractBearerToken(req);
  if (!bearer) {
    return applyCors(
      req,
      NextResponse.json(
        { error: { message: "Missing Bearer API key" } },
        { status: 401 },
      ),
    );
  }
  const key = await resolveApiKey(bearer);
  if (!key) {
    return applyCors(
      req,
      NextResponse.json(
        { error: { message: "Invalid API key" } },
        { status: 401 },
      ),
    );
  }

  try {
    const res = await fetch(`${runtimeBaseUrl()}/models`, {
      cache: "no-store",
      headers: runtimeAuthHeaders(),
    });
    const text = await res.text();
    return applyCors(
      req,
      new NextResponse(text, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
        },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream_error";
    return applyCors(
      req,
      NextResponse.json({ error: { message } }, { status: 502 }),
    );
  }
}
