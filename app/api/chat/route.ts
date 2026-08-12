import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { applyCors, preflightResponse } from "../_cors";
import {
  DEFAULT_DAILY_DRIVER_MODEL,
  getModelTier,
  pickDefaultModelByTier,
  SLA_TARGETS_BY_TIER,
} from "../../lib/model-tiers";
import { evaluateSla, fetchMeshPeersCached } from "../../lib/routing-sla";
import {
  consumeFallbackBudget,
  decideFallback,
  getOpenRouterProvider,
} from "../../lib/fallback-provider";
import { isVisionModel } from "../../lib/model-catalog";
import { resolveCatalog } from "../../lib/resolve-catalog";
import { recordServedByDecision } from "../../lib/mesh-share";
import {
  recordMeshCredits,
  resolveCreditMultiplier,
} from "../../lib/credits-ledger";
import { appendSessionReceipt } from "../../lib/session-receipts";
import type { SlaEvaluation } from "../../lib/routing-sla";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Idle watchdog for the free chat stream.
 *
 * Observed in production 2026-08-12: a request emitted `{"type":"start"}` and
 * then nothing — no token, no error, no terminator — for 90 s and counting. It
 * coincided with a peer transitioning `loading` → `serving`, which black-holed
 * the in-flight request. With `maxDuration = 300` and no idle guard, a visitor
 * watches an empty chat for up to five minutes and never learns anything went
 * wrong. That is far worse than an honest error.
 *
 * The paid `/v1` route already guards its raw upstream reader with
 * `withIdleTimeout`; the free route streams through the AI SDK, so the
 * equivalent is an `abortSignal` refreshed on every chunk.
 *
 * The budget is derived from the tier's own advertised TTFT target rather than a
 * magic constant, so a capacity-tier model that legitimately takes 15 s to first
 * token is not cut off. Floored so a fast tier still gets a humane grace period.
 */
const STREAM_IDLE_FLOOR_MS = 30_000;
const STREAM_IDLE_TTFT_MULTIPLE = 6;

export function streamIdleBudgetMs(modelId: string): number {
  const target = SLA_TARGETS_BY_TIER[getModelTier(modelId)].target_ttft_ms_p50;
  return Math.max(STREAM_IDLE_FLOOR_MS, target * STREAM_IDLE_TTFT_MULTIPLE);
}

class ChatStreamStalledError extends Error {
  constructor(idleMs: number) {
    super(`chat stream stalled: no output for ${idleMs}ms`);
    this.name = "ChatStreamStalledError";
  }
}

// `.trim()` defensively against env values like `"https://…/v1\n"` — Vercel
// has burned us once already on `NEXT_PUBLIC_DEPLOYMENT="public\n"` and we
// previously trimmed the token but not the URL, leaving `${RUNTIME_URL}/models`
// to expand into a string with a literal newline mid-URL. Empty string after
// trim falls through to the localhost default, matching dev expectations.
function trimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value) return value;
  }
  return undefined;
}

const RUNTIME_URL =
  trimmedEnv("SENDA_RUNTIME_URL", "MESH_LLM_URL") ??
  "http://127.0.0.1:9337/v1";

// Bearer token shared with the runtime's auth gateway. Set on Vercel for
// the public deployment; unset in local dev where the runtime is on the
// loopback.
const RUNTIME_TOKEN = trimmedEnv("SENDA_RUNTIME_TOKEN") ?? "";

const runtimeHeaders: Record<string, string> = RUNTIME_TOKEN
  ? { Authorization: `Bearer ${RUNTIME_TOKEN}` }
  : {};

type ServingPeerAttribution = {
  /** Short peer id from `x-senda-serving-peer`, if the runtime echoed it. */
  peerId: string | null;
};

/**
 * Per-request provider so concurrent chats don't race on attribution.
 * Captures the serving-host header from the entry/runtime response.
 */
function createSendaProvider(attribution: ServingPeerAttribution) {
  return createOpenAICompatible({
    name: "senda",
    baseURL: RUNTIME_URL,
    headers: runtimeHeaders,
    // v0.66.43 marketplace metrics: the runtime backend proxy can only
    // record a per-model TPS/TTFT sample when the upstream llama-server
    // response carries `usage.completion_tokens`. For non-streaming
    // responses that's always there. For streaming (SSE) responses, the
    // OpenAI spec requires the client to opt in via
    // `stream_options.include_usage: true` — without that flag the
    // final chunk omits `usage`, the runtime parses `None`, and the
    // catalog stays empty. Setting this here on the provider applies
    // to every `streamText({ model: senda.chatModel(...) })` call.
    includeUsage: true,
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      const peer = res.headers.get("x-senda-serving-peer")?.trim();
      if (peer) attribution.peerId = peer;
      return res;
    },
  });
}

async function pickDefaultModel(): Promise<string> {
  try {
    // /v1/models is intentionally allowed through the auth gateway without
    // a token, but we send the header anyway so we exercise the same code
    // path in tests and never hit a "works for chat, fails for models"
    // skew.
    const res = await fetch(`${RUNTIME_URL}/models`, {
      cache: "no-store",
      headers: runtimeHeaders,
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const routable = (data.data ?? []).map((m) => m.id);
    // Phase 4.A — pick by tier, not by listing order. The runtime
    // returns whichever Host happens to be first; without this gate a
    // chat request with no `model` field on a mesh that's currently
    // hosting both Qwen3-8B and DeepSeek-70B could land on the 70B
    // (~1 tok/s through-mesh measured 2026-05-23) just because the
    // listing happened to put it first.
    const tierPreferred = pickDefaultModelByTier(
      routable,
      process.env.SENDA_MODEL ?? process.env.MESH_LLM_MODEL ?? null,
    );
    if (tierPreferred) return tierPreferred;
  } catch {
    // fall through to env-default
  }
  return (
    process.env.SENDA_MODEL ??
    process.env.MESH_LLM_MODEL ??
    DEFAULT_DAILY_DRIVER_MODEL
  );
}

/**
 * System prompt prepended to every conversation.
 *
 * Open-weight models will faithfully self-identify by their lineage when
 * asked "where do you run" — GLM says "Z.ai", Qwen says "Alibaba", Llama
 * says "Meta". That's accurate from the model's POV (it knows who *trained*
 * it) but actively misleading for our users: Senda routes their
 * prompt to a peer running the open weights, not to any of those vendors'
 * APIs. This prompt corrects the runtime-location story without trying
 * to suppress the model's identity.
 *
 * Kept short and factual on purpose. We don't inject a persona, a tone,
 * or product marketing — and we do NOT front-load Senda/privacy/moderation
 * context, or models volunteer it on every greeting. All Senda-specific
 * facts are gated behind "when asked" so casual chat stays casual.
 */
const SYSTEM_PROMPT = `Respond naturally. Match the user's tone and message length — a short greeting gets a short reply, not a disclaimer.

Background you may need when relevant (do NOT volunteer this unprompted):
- You run on Senda, a peer-to-peer network where open-weight models run on contributors' hardware — not on Z.ai, OpenAI, Anthropic, Google, Meta, Alibaba, or any vendor's cloud API, even if you were trained by one of them.
- It is fine to acknowledge model lineage (e.g. "I'm a Qwen 3 model"). Do not claim to be hosted by the company that trained you.

When asked about Senda: peer-to-peer LLM mesh; chat at senda.network or the desktop app; anyone can contribute compute; runtime is open source.

When asked about privacy or where data goes: prompts go to a mesh peer, not a third-party AI API; sessions are pseudonymous; runtime is open source and auditable.

When asked about censorship or content moderation: Senda has no network-wide content policy; individual node operators set their own limits; any refusals are your judgment as a model, not a Senda rule. Do not invent or speculate about Senda content policies.`;

export async function OPTIONS(req: Request) {
  return preflightResponse(req);
}

export type ParsedChatBody = {
  messages: UIMessage[];
  model?: string;
};

export type ChatBodyParseResult =
  | { ok: true; body: ParsedChatBody }
  | { ok: false; status: number; error: string };

/**
 * Validate the JSON body of a `/api/chat` POST request.
 *
 * The previous handler did `(await req.json()) as { messages, model? }`
 * with no defensive checks. Malformed JSON or a missing/invalid
 * `messages` field produced an unhandled exception inside
 * `convertToModelMessages`, which surfaced to the user as a generic
 * 500 with no useful body. We want bad input to produce a clean 400
 * with a single-line reason — and we want the contract pinned in a
 * test so the validation can't silently regress.
 *
 * Note: we deliberately only check the *shape* of `messages` (array of
 * objects). Validating each `UIMessagePart` discriminant is the AI
 * SDK's job; doing it here would duplicate a moving target and reject
 * input the SDK actually accepts.
 */
export function parseChatBody(raw: unknown): ChatBodyParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return { ok: false, status: 400, error: "`messages` must be an array" };
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      return {
        ok: false,
        status: 400,
        error: `\`messages[${i}]\` must be an object`,
      };
    }
    // AI SDK v5 contract: every UIMessage has a `parts` array. Without
    // it, `convertToModelMessages` calls `.map` on `undefined` and the
    // route 500s with an empty body. We saw this in the wild on
    // 2026-05-25 when a client sent legacy `{role, content}` messages
    // against the v5 deployment. Reject cleanly with a 400 that names
    // the fix instead of letting it surface as an opaque 500.
    const mObj = m as Record<string, unknown>;
    if (!Array.isArray(mObj.parts)) {
      return {
        ok: false,
        status: 400,
        error: `\`messages[${i}].parts\` must be an array — this endpoint uses the AI SDK v5 UIMessage shape (\`{ id, role, parts: [{ type: "text", text }] }\`); legacy \`{ role, content }\` messages are not accepted`,
      };
    }
  }
  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== "string") {
      return { ok: false, status: 400, error: "`model` must be a string" };
    }
    const trimmed = body.model.trim();
    if (!trimmed) {
      return { ok: false, status: 400, error: "`model` must be a non-empty string" };
    }
    model = trimmed;
  }
  return {
    ok: true,
    body: { messages: messages as UIMessage[], model },
  };
}

function badRequest(req: Request, message: string, status = 400): Response {
  return applyCors(
    req,
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/**
 * Translate runtime errors into single, user-readable lines.
 *
 * The default AI SDK error message for 5xx looks like
 * `Failed after 3 attempts. Last error: APICallError: Too Many Requests`,
 * which terrifies users and tells them nothing actionable. The runtime has
 * structured 503 reasons we can pluck out (`no_host_for_model`,
 * `no_capable_node`, etc.) — we surface those cleanly instead.
 */
function friendlyChatError(error: unknown): string {
  const fallback =
    "The mesh couldn't serve that request. The hosting peer may be busy, restarting, or temporarily offline. Please try again in a few seconds.";
  if (!error) return fallback;
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : JSON.stringify(error);
  const lower = raw.toLowerCase();
  if (lower.includes("no host is currently serving"))
    return "No node in the mesh is currently hosting this model. A peer needs to start sharing it before requests can be served.";
  if (lower.includes("no_capable_node") || lower.includes("insufficient vram"))
    return "No node in the mesh has enough capacity to run this model right now.";
  if (lower.includes("election in progress") || lower.includes("host down"))
    return "The mesh is electing a new host (the previous one disappeared). Try again in 10–15 seconds.";
  if (lower.includes("too many requests") || lower.includes("rate"))
    return "The mesh is at capacity right now. Try again in a few seconds.";
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "The hosting peer didn't respond in time. It may be loading the model — try again in a few seconds.";
  if (
    lower.includes("all ") &&
    lower.includes("target") &&
    lower.includes("failed")
  )
    return "No reachable host for this model right now — the mesh listed a peer we couldn't dial. Try another model, or wait while the mesh reconfigures.";
  if (lower.includes("503") || lower.includes("unavailable"))
    return "No reachable host for this model on the mesh right now. Try another model, or try again shortly.";
  return fallback;
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest(req, "request body must be valid JSON");
  }

  const parsed = parseChatBody(raw);
  if (!parsed.ok) {
    return badRequest(req, parsed.error, parsed.status);
  }

  const modelId = parsed.body.model ?? (await pickDefaultModel());

  // Vision gate. A message carries an image when any part is a file with an
  // `image/*` media type (AI SDK v5 FileUIPart). Only models flagged
  // vision-capable (runtime catalog `vision`, merged with site copy) are
  // launched with an `--mmproj` projector; routing an image at a text-only
  // model produces an opaque llama-server failure, so reject early with an
  // actionable message instead.
  const hasImage = parsed.body.messages.some(
    (m) =>
      Array.isArray(m.parts) &&
      m.parts.some(
        (p) =>
          (p as { type?: string }).type === "file" &&
          typeof (p as { mediaType?: string }).mediaType === "string" &&
          (p as { mediaType: string }).mediaType.startsWith("image/"),
      ),
  );
  if (hasImage) {
    const catalog = await resolveCatalog();
    if (!isVisionModel(modelId, catalog)) {
      return badRequest(
        req,
        "This model can't see images. Pick a vision model like Gemma 3 12B or Gemma 3 27B, then attach your image again.",
        422,
      );
    }
  }

  // Phase 4.B — SLA gate inputs. Cached fetch (~5 s TTL) so the
  // hot path is essentially free in steady state.
  const peers = await fetchMeshPeersCached();
  const sla = evaluateSla(modelId, peers);

  // Phase 4.C — pick the supply path for this request. The decision
  // is pure (see `decideFallback`); the only side effect is
  // consuming the testbed's per-IP per-hour budget, and that
  // happens only when the decision routes to the external provider.
  let decision = decideFallback(modelId, sla);
  // The external fallback slugs are text-only; never ship an image to them.
  // A vision request stays on the mesh even when the SLA gate would
  // otherwise have leaned on fallback.
  if (hasImage && decision.useFallback) {
    decision = {
      useFallback: false,
      verdict: "vision-mesh-only",
      fallbackModelSlug: null,
    };
  }
  let budgetRemaining: number | null = null;
  if (decision.useFallback) {
    const clientIp = getClientIp(req);
    const budget = await consumeFallbackBudget(clientIp);
    if (!budget.allowed) {
      // The free `/chat` testbed bounds external-supply use per IP
      // per hour while we're not yet billing. Over-budget callers
      // route to the mesh path on this surface. Phase 5's paid API
      // replaces this with the customer's credit balance.
      decision = {
        useFallback: false,
        verdict: "fallback-rate-limited",
        fallbackModelSlug: null,
      };
    } else {
      budgetRemaining = budget.remaining;
    }
  }

  const servedBy = decision.useFallback ? "fallback" : "mesh";

  // Phase 4 headline KPI: fire-and-forget `mesh_share_pct` counter.
  // The streamed response is what the customer paid for (or what
  // the testbed promises today); the counter is bookkeeping and
  // must never gate the response — internally guarded for the same
  // reason.
  void recordServedByDecision(servedBy);

  let meshCredits = servedBy === "mesh";

  const headers: Record<string, string> = {
    "x-senda-served-by": servedBy,
    "x-senda-sla-status": sla.meetsSla ? "meet" : sla.reason,
    "x-senda-sla-tier": sla.tier,
    "x-senda-sla-candidates": String(sla.candidatePeerCount),
    "x-senda-fallback-status": decision.verdict,
  };
  if (sla.bestPeerTtftMs !== null) {
    headers["x-senda-sla-best-ttft-ms"] = String(sla.bestPeerTtftMs);
  }
  if (sla.bestPeerTps !== null) {
    headers["x-senda-sla-best-tps"] = sla.bestPeerTps.toFixed(2);
  }
  // Through-mesh / native throughput ratio of the peer the gate would
  // route to. ~1.0 for a healthy solo serve; below the tier floor means
  // the entry demoted a peer whose decode has degraded relative to its
  // own native baseline. Surfaced so the narrowing of the ratio is
  // observable on every response before it gates real routing in 5.E.
  if (sla.bestPeerNativeRatio !== null) {
    headers["x-senda-sla-native-ratio"] = sla.bestPeerNativeRatio.toFixed(2);
  }
  if (decision.useFallback) {
    headers["x-senda-fallback-provider"] = "openrouter";
    headers["x-senda-fallback-model"] = decision.fallbackModelSlug ?? "";
    if (budgetRemaining !== null) {
      headers["x-senda-fallback-budget-remaining"] = String(budgetRemaining);
    }
  }

  // Phase 5.A — capture serving-host peer id from the runtime response.
  const servingAttribution: ServingPeerAttribution = { peerId: null };
  const senda = createSendaProvider(servingAttribution);
  const creditOnFinish = meshCreditOnFinish(
    meshCredits,
    sla,
    modelId,
    servingAttribution,
  );

  // Both branches use the same `streamText` protocol, so the AI SDK
  // chunk format is identical to the caller. The chat UI does not
  // need to know whether it got mesh or fallback — only the
  // headers and `/metrics` distinguish them.
  // Watchdog armed *before* the first token, since the observed hang was
  // pre-first-token. Every chunk refreshes it; abort surfaces through `onError`
  // as a real stream error instead of silence.
  const idleMs = streamIdleBudgetMs(modelId);
  const stallController = new AbortController();
  let stalled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const bumpIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      stalled = true;
      stallController.abort(new ChatStreamStalledError(idleMs));
    }, idleMs);
    // Never let a pending watchdog hold the serverless invocation open past a
    // completed stream. Aborting an already-settled stream is a no-op, so the
    // only thing worth guarding against is the timer itself keeping us alive.
    idleTimer?.unref?.();
  };
  bumpIdle();
  const streamGuards = {
    abortSignal: stallController.signal,
    onChunk: () => bumpIdle(),
    onAbort: () => clearIdle(),
  };

  let result;
  if (decision.useFallback) {
    const provider = getOpenRouterProvider();
    if (!provider) {
      // Shouldn't reach here because `decideFallback` checks the
      // key, but guard belt-and-braces in case env state shifts.
      decision = {
        useFallback: false,
        verdict: "fallback-disabled",
        fallbackModelSlug: null,
      };
      headers["x-senda-served-by"] = "mesh";
      headers["x-senda-fallback-status"] = "fallback-disabled";
      meshCredits = true;
      result = streamText({
        model: senda.chatModel(modelId),
        system: SYSTEM_PROMPT,
        messages: convertToModelMessages(parsed.body.messages),
        maxRetries: 0,
        ...streamGuards,
        ...meshCreditOnFinish(meshCredits, sla, modelId, servingAttribution),
      });
    } else {
      result = streamText({
        model: provider.chatModel(decision.fallbackModelSlug!),
        system: SYSTEM_PROMPT,
        messages: convertToModelMessages(parsed.body.messages),
        maxRetries: 1,
        ...streamGuards,
      });
    }
  } else {
    result = streamText({
      model: senda.chatModel(modelId),
      system: SYSTEM_PROMPT,
      messages: convertToModelMessages(parsed.body.messages),
      // The AI SDK retries up to 2x on 5xx by default. For a peer-to-peer
      // mesh this is actively harmful: a 503 from the runtime almost always
      // means "no host elected" or "host saturated", neither of which is
      // resolved by hammering it 200ms later. Worse, the retries can trip
      // the entry node's per-IP rate limit, turning a clean 503 into a
      // 429 and confusing the actual diagnosis. One attempt; let the user
      // (or chat UI) decide whether to retry.
      maxRetries: 0,
      ...streamGuards,
      ...creditOnFinish,
    });
  }

  // When the request is being served from the mesh but the SLA gate found
  // zero candidate peers hosting this model, the runtime call is a foregone
  // failure — and its error string used to get mislabeled as "at capacity"
  // (a rate-limit message) by `friendlyChatError`'s keyword matching. We
  // already know the real reason from our own signal, so surface it
  // accurately instead of guessing. The mesh path streams even below SLA
  // (a slow serve beats no serve), so we only override for the genuine
  // no-host case, not for degraded-but-serving peers.
  const onError = (error: unknown): string => {
    clearIdle();
    // A stalled stream is its own failure mode and deserves its own message.
    // Checked before the no-host case: a stall means a peer accepted the
    // request and then went quiet, which is not the same as having no peer.
    if (stalled) {
      return `The contributor serving ${modelId} stopped responding mid-request (no output for ${Math.round(
        idleMs / 1000,
      )}s). This usually means a peer dropped off or is still loading the model — try again, or see senda.network/status.`;
    }
    if (!decision.useFallback && sla.candidatePeerCount === 0) {
      return `No contributor is currently serving ${modelId} on the mesh right now. A peer needs to load and share it before requests can be served — see senda.network/status.`;
    }
    return friendlyChatError(error);
  };

  return applyCors(
    req,
    result.toUIMessageStreamResponse({
      onError,
      headers,
    }),
  );
}

/**
 * Best-effort client IP for the testbed's per-IP per-hour budget
 * on external-supply use. Vercel sets `x-forwarded-for` on every
 * request; pick the first hop (the actual client), fall through to
 * `x-real-ip`, then to a constant placeholder so the Redis key is
 * still deterministic in dev.
 */
function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function meshCreditOnFinish(
  meshCredits: boolean,
  sla: SlaEvaluation,
  modelId: string,
  serving: ServingPeerAttribution,
) {
  if (!meshCredits) return {};
  return {
    onFinish: async (event: {
      totalUsage?: { outputTokens?: number; inputTokens?: number };
    }) => {
      const tokens = event.totalUsage?.outputTokens ?? 0;
      if (tokens <= 0) return;
      // Prefer the host that actually answered; SLA ranking is heuristic.
      const servingPeer = serving.peerId?.trim() || null;
      const peerId = servingPeer || sla.creditPeerId;
      if (!peerId) return;
      const attribution = servingPeer ? "serving-peer" : "sla-heuristic";
      // 5.B: resolve once so ledger + receipt stay aligned. Default 1.0 until
      // SENDA_CREDIT_SLASH is enabled after the L1 oracle gate.
      const multiplier = await resolveCreditMultiplier(
        peerId,
        modelId,
        attribution,
      );
      void recordMeshCredits({
        peerId,
        modelId,
        completionTokens: tokens,
        tier: sla.tier,
        attribution,
        multiplier,
      });
      void appendSessionReceipt({
        peerId,
        modelId,
        completionTokens: tokens,
        promptTokens: event.totalUsage?.inputTokens ?? null,
        tier: sla.tier,
        attribution,
        multiplier,
      });
    },
  };
}
