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

export const runtime = "nodejs";
export const maxDuration = 300;

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

/**
 * POST /v1/chat/completions — paid OpenAI-compatible surface (Phase 5.E Slice 1).
 * Auth: Bearer ck_…  Mesh-only until Slice 3 enables paid fallback.
 */
export async function POST(req: Request) {
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

  const peers = await fetchMeshPeersCached();
  const sla = evaluateSla(modelId, peers);
  // Slice 3: paid path may use OpenRouter when mesh misses SLA (key set).
  // Free /api/chat keeps its own IP budget; paid uses customer credits only.
  const decision = decideFallback(modelId, sla);
  const servedBy = decision.useFallback ? "fallback" : "mesh";
  void recordServedByDecision(servedBy);

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
        await settleCustomer({ requestId, actualMicros: 0 });
        return jsonError(req, 503, "Fallback unavailable", "fallback_disabled");
      }
      upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": "https://senda.network",
          "X-Title": "Senda",
        },
        body: JSON.stringify(upstreamBody),
      });
    } else {
      upstream = await fetch(`${runtimeBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...runtimeAuthHeaders(),
        },
        body: JSON.stringify(upstreamBody),
      });
    }
  } catch (err) {
    await settleCustomer({ requestId, actualMicros: 0 });
    const message = err instanceof Error ? err.message : "upstream_error";
    return jsonError(req, 502, message, "upstream_unreachable");
  }

  const servingPeer = upstream.headers.get("x-senda-serving-peer");
  if (servingPeer) headersOut["x-senda-serving-peer"] = servingPeer;

  if (!upstream.ok) {
    await settleCustomer({ requestId, actualMicros: 0 });
    const text = await upstream.text().catch(() => "");
    return applyCors(
      req,
      new NextResponse(text || upstream.statusText, {
        status: upstream.status,
        headers: headersOut,
      }),
    );
  }

  if (!wantStream) {
    const json = (await upstream.json()) as {
      usage?: unknown;
    };
    const usage = parseUsage(json.usage) ?? {
      promptTokens: promptEstimate,
      completionTokens: 0,
    };
    const charged = requestCostMicros({
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    const settled = await settleCustomer({
      requestId,
      actualMicros: charged,
    });
    headersOut["x-senda-cost-usd-micros"] = String(charged);
    if (settled.ok) {
      headersOut["x-senda-balance-usd-micros"] = String(settled.balance);
    }
    if (servedBy === "mesh") {
      await accrueMeshCredits({
        modelId,
        peerId: servingPeer,
        slaPeerId: sla.creditPeerId,
        tier: sla.tier,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
    }
    return applyCors(
      req,
      NextResponse.json(json, { status: 200, headers: headersOut }),
    );
  }

  // Streaming: tee SSE, capture final usage, settle in background.
  const reader = upstream.body?.getReader();
  if (!reader) {
    await settleCustomer({ requestId, actualMicros: 0 });
    return jsonError(req, 502, "Empty upstream stream", "upstream_empty");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let usage: { promptTokens: number; completionTokens: number } | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const finalUsage = usage ?? {
            promptTokens: promptEstimate,
            completionTokens: 0,
          };
          const charged = requestCostMicros({
            modelId,
            promptTokens: finalUsage.promptTokens,
            completionTokens: finalUsage.completionTokens,
          });
          const settled = await settleCustomer({
            requestId,
            actualMicros: charged,
          });
          // Trailer-like final SSE comment with cost (clients ignore unknown lines).
          const meta = `data: ${JSON.stringify({
            senda: {
              cost_usd_micros: charged,
              balance_usd_micros: settled.ok ? settled.balance : null,
              request_id: requestId,
            },
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(meta));
          if (servedBy === "mesh") {
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
          try {
            const chunk = JSON.parse(payload) as { usage?: unknown };
            const parsed = parseUsage(chunk.usage);
            if (parsed) usage = parsed;
          } catch {
            // ignore non-JSON SSE lines
          }
        }
      } catch (err) {
        await settleCustomer({ requestId, actualMicros: 0 });
        controller.error(err);
      }
    },
    cancel() {
      void reader.cancel();
      void settleCustomer({ requestId, actualMicros: 0 });
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
