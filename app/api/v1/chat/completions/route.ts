import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { applyCors, preflightResponse } from "../../../_cors";
import {
  extractBearerToken,
  resolveApiKey,
} from "../../../../lib/api-keys";
import {
  recordMeshCredits,
  resolveCreditMultiplier,
} from "../../../../lib/credits-ledger";
import { evaluateSla, fetchMeshPeersCached } from "../../../../lib/routing-sla";
import { recordServedByDecision } from "../../../../lib/mesh-share";
import { decideFallback } from "../../../../lib/fallback-provider";
import {
  customerStoreReady,
  reclaimExpiredReserves,
  reserveCustomer,
  settleCustomer,
} from "../../../../lib/customer-ledger";
import {
  estimatePromptTokensFromMessages,
  estimateReserveMicros,
  paidApiEnabled,
  requestCostMicros,
} from "../../../../lib/rate-card";
import {
  runtimeAuthHeaders,
  runtimeBaseUrl,
} from "../../../../lib/runtime-proxy";
import { appendSessionReceipt } from "../../../../lib/session-receipts";
import {
  estimateCompletionTokensFromText,
  extractDeltaContent,
} from "../../../../lib/stream-usage";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Upstream connect/headers budget (ms). Streaming continues after this. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 45_000;

export function OPTIONS(req: Request) {
  return preflightResponse(req);
}

type OpenAiMessage = { role?: string; content?: unknown };

type CompletionsBody = {
  model?: string;
  messages?: OpenAiMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
};

function jsonError(
  req: Request,
  status: number,
  message: string,
  code?: string,
) {
  return applyCors(
    req,
    NextResponse.json(
      {
        error: {
          message,
          type: "invalid_request_error",
          code: code ?? null,
        },
      },
      { status },
    ),
  );
}

function maxCompletionTokens(body: CompletionsBody): number {
  const n = body.max_completion_tokens ?? body.max_tokens ?? 256;
  if (!Number.isFinite(n) || n <= 0) return 256;
  return Math.min(Math.floor(n), 8192);
}

function parseUsage(raw: unknown): {
  promptTokens: number;
  completionTokens: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    promptTokens: Math.max(0, Math.floor(prompt || 0)),
    completionTokens: Math.max(0, Math.floor(completion || 0)),
  };
}

async function accrueMeshCredits(input: {
  modelId: string;
  peerId: string | null;
  slaPeerId: string | null;
  tier: "daily_driver" | "capacity" | "experimental";
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  if (input.completionTokens <= 0) return;
  const servingPeer = input.peerId?.trim() || null;
  const peerId = servingPeer || input.slaPeerId;
  if (!peerId) return;
  const attribution = servingPeer ? "serving-peer" : "sla-heuristic";
  const multiplier = await resolveCreditMultiplier(
    peerId,
    input.modelId,
    attribution,
  );
  void recordMeshCredits({
    peerId,
    modelId: input.modelId,
    completionTokens: input.completionTokens,
    tier: input.tier,
    attribution,
    multiplier,
  });
  void appendSessionReceipt({
    peerId,
    modelId: input.modelId,
    completionTokens: input.completionTokens,
    promptTokens: input.promptTokens || null,
    tier: input.tier,
    attribution,
    multiplier,
  });
}

async function settleSafe(
  requestId: string,
  actualMicros: number,
): Promise<{ balance: number | null; charged: number }> {
  const settled = await settleCustomer({ requestId, actualMicros });
  if (settled.ok) {
    return { balance: settled.balance, charged: settled.charged };
  }
  return { balance: null, charged: 0 };
}

async function fetchUpstream(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /v1/chat/completions — paid OpenAI-compatible surface (Phase 5.E).
 * Auth: Bearer ck_…
 *
 * Billing hardening: atomic reserve, reclaimable holds, connect timeout,
 * settle on all exits, charge delivered tokens when usage is missing.
 */
export async function POST(req: Request) {
  void reclaimExpiredReserves(25);

  if (!paidApiEnabled()) {
    return jsonError(req, 503, "Paid API is not enabled", "paid_api_disabled");
  }
  if (!customerStoreReady()) {
    return jsonError(req, 503, "Billing store unavailable", "store_unavailable");
  }

  const bearer = extractBearerToken(req);
  if (!bearer) {
    return jsonError(req, 401, "Missing Bearer API key", "missing_auth");
  }
  const key = await resolveApiKey(bearer);
  if (!key) {
    return jsonError(req, 401, "Invalid API key", "invalid_api_key");
  }

  let body: CompletionsBody;
  try {
    body = (await req.json()) as CompletionsBody;
  } catch {
    return jsonError(req, 400, "Request body must be valid JSON");
  }

  const modelId = body.model?.trim();
  if (!modelId) {
    return jsonError(req, 400, "model is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(req, 400, "messages is required");
  }

  const wantStream = body.stream === true;
  const maxOut = maxCompletionTokens(body);
  const promptEstimate = estimatePromptTokensFromMessages(body.messages);
  const reserveMicros = estimateReserveMicros({
    modelId,
    promptTokens: promptEstimate,
    maxCompletionTokens: maxOut,
  });

  const requestId = randomUUID();
  const reserved = await reserveCustomer({
    accountId: key.accountId,
    requestId,
    micros: Math.max(1, reserveMicros),
  });
  if (!reserved.ok) {
    const status = reserved.error === "insufficient_funds" ? 402 : 400;
    return jsonError(req, status, reserved.error, reserved.error);
  }

  let settled = false;
  const finishSettle = async (actualMicros: number) => {
    if (settled) return settleSafe(requestId, actualMicros);
    settled = true;
    return settleSafe(requestId, actualMicros);
  };

  const peers = await fetchMeshPeersCached();
  const sla = evaluateSla(modelId, peers);
  const decision = decideFallback(modelId, sla);
  const servedBy = decision.useFallback ? "fallback" : "mesh";

  const upstreamBody = {
    ...body,
    model: decision.useFallback
      ? (decision.fallbackModelSlug ?? modelId)
      : modelId,
    stream: wantStream,
    max_tokens: maxOut,
    stream_options: wantStream
      ? { include_usage: true, ...(body.stream_options ?? {}) }
      : body.stream_options,
  };

  const headersOut: Record<string, string> = {
    "x-senda-served-by": servedBy,
    "x-senda-sla-status": sla.meetsSla ? "meet" : sla.reason,
    "x-senda-sla-tier": sla.tier,
    "x-senda-sla-candidates": String(sla.candidatePeerCount),
    "x-senda-fallback-status": decision.verdict,
    "x-senda-request-id": requestId,
    "x-senda-account-id": key.accountId,
  };
  if (decision.useFallback) {
    headersOut["x-senda-fallback-provider"] = "openrouter";
    headersOut["x-senda-fallback-model"] = decision.fallbackModelSlug ?? "";
  }

  let upstream: Response;
  try {
    if (decision.useFallback) {
      const orKey = process.env.OPENROUTER_API_KEY?.trim();
      if (!orKey) {
        await finishSettle(0);
        return jsonError(req, 503, "Fallback unavailable", "fallback_disabled");
      }
      upstream = await fetchUpstream(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${orKey}`,
            "HTTP-Referer": "https://senda.network",
            "X-Title": "Senda",
          },
          body: JSON.stringify(upstreamBody),
        },
      );
    } else {
      upstream = await fetchUpstream(`${runtimeBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...runtimeAuthHeaders(),
        },
        body: JSON.stringify(upstreamBody),
      });
    }
  } catch (err) {
    await finishSettle(0);
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(err.message));
    const message = aborted
      ? "Upstream timed out"
      : err instanceof Error
        ? err.message
        : "upstream_error";
    return jsonError(
      req,
      502,
      message,
      aborted ? "upstream_timeout" : "upstream_unreachable",
    );
  }

  const servingPeer = upstream.headers.get("x-senda-serving-peer");
  if (servingPeer) headersOut["x-senda-serving-peer"] = servingPeer;

  if (!upstream.ok) {
    await finishSettle(0);
    const text = await upstream.text().catch(() => "");
    return applyCors(
      req,
      new NextResponse(text || upstream.statusText, {
        status: upstream.status,
        headers: headersOut,
      }),
    );
  }

  // Only count successful upstream accepts toward mesh_share.
  void recordServedByDecision(servedBy);

  if (!wantStream) {
    try {
      const json = (await upstream.json()) as { usage?: unknown };
      const usage = parseUsage(json.usage) ?? {
        promptTokens: promptEstimate,
        completionTokens: 0,
      };
      const charged = requestCostMicros({
        modelId,
        promptTokens: usage.promptTokens || promptEstimate,
        completionTokens: usage.completionTokens,
      });
      const result = await finishSettle(charged);
      headersOut["x-senda-cost-usd-micros"] = String(result.charged);
      if (result.balance != null) {
        headersOut["x-senda-balance-usd-micros"] = String(result.balance);
      }
      if (servedBy === "mesh") {
        await accrueMeshCredits({
          modelId,
          peerId: servingPeer,
          slaPeerId: sla.creditPeerId,
          tier: sla.tier,
          promptTokens: usage.promptTokens || promptEstimate,
          completionTokens: usage.completionTokens,
        });
      }
      return applyCors(
        req,
        NextResponse.json(json, { status: 200, headers: headersOut }),
      );
    } catch (err) {
      await finishSettle(0);
      const message = err instanceof Error ? err.message : "upstream_error";
      return jsonError(req, 502, message, "upstream_body_error");
    }
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    await finishSettle(0);
    return jsonError(req, 502, "Empty upstream stream", "upstream_empty");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let streamedText = "";

  const resolveUsage = () => {
    if (usage && (usage.completionTokens > 0 || usage.promptTokens > 0)) {
      return {
        promptTokens: usage.promptTokens || promptEstimate,
        completionTokens: usage.completionTokens,
      };
    }
    const fromText = estimateCompletionTokensFromText(streamedText);
    return {
      promptTokens: promptEstimate,
      completionTokens: fromText,
    };
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const finalUsage = resolveUsage();
          const charged = requestCostMicros({
            modelId,
            promptTokens: finalUsage.promptTokens,
            completionTokens: finalUsage.completionTokens,
          });
          const result = await finishSettle(charged);
          const meta = `data: ${JSON.stringify({
            senda: {
              cost_usd_micros: result.charged,
              balance_usd_micros: result.balance,
              request_id: requestId,
            },
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(meta));
          if (servedBy === "mesh" && finalUsage.completionTokens > 0) {
            await accrueMeshCredits({
              modelId,
              peerId: servingPeer,
              slaPeerId: sla.creditPeerId,
              tier: sla.tier,
              promptTokens: finalUsage.promptTokens,
              completionTokens: finalUsage.completionTokens,
            });
          }
          controller.close();
          return;
        }
        controller.enqueue(value);
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          streamedText += extractDeltaContent(payload);
          try {
            const chunk = JSON.parse(payload) as { usage?: unknown };
            const parsed = parseUsage(chunk.usage);
            if (parsed) usage = parsed;
          } catch {
            // ignore non-JSON SSE lines
          }
        }
      } catch (err) {
        // Charge for whatever was already delivered; don't zero-out after
        // the customer received tokens.
        const finalUsage = resolveUsage();
        const charged = requestCostMicros({
          modelId,
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
        });
        await finishSettle(charged);
        if (servedBy === "mesh" && finalUsage.completionTokens > 0) {
          void accrueMeshCredits({
            modelId,
            peerId: servingPeer,
            slaPeerId: sla.creditPeerId,
            tier: sla.tier,
            promptTokens: finalUsage.promptTokens,
            completionTokens: finalUsage.completionTokens,
          });
        }
        controller.error(err);
      }
    },
    cancel() {
      void reader.cancel();
      const finalUsage = resolveUsage();
      const charged = requestCostMicros({
        modelId,
        promptTokens: finalUsage.promptTokens,
        completionTokens: finalUsage.completionTokens,
      });
      void finishSettle(charged);
    },
  });

  return applyCors(
    req,
    new NextResponse(stream, {
      status: 200,
      headers: {
        ...headersOut,
        "content-type":
          upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
      },
    }),
  );
}
