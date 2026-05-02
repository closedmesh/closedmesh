import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { applyCors, preflightResponse } from "../_cors";

export const runtime = "nodejs";
export const maxDuration = 300;

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
  trimmedEnv("CLOSEDMESH_RUNTIME_URL", "MESH_LLM_URL") ??
  "http://127.0.0.1:9337/v1";

// Bearer token shared with the runtime's auth gateway. Set on Vercel for
// the public deployment; unset in local dev where the runtime is on the
// loopback.
const RUNTIME_TOKEN = trimmedEnv("CLOSEDMESH_RUNTIME_TOKEN") ?? "";

const runtimeHeaders: Record<string, string> = RUNTIME_TOKEN
  ? { Authorization: `Bearer ${RUNTIME_TOKEN}` }
  : {};

const closedmesh = createOpenAICompatible({
  name: "closedmesh",
  baseURL: RUNTIME_URL,
  headers: runtimeHeaders,
});

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
    const id = data.data?.[0]?.id;
    if (id) return id;
  } catch {
    // fall through to env-default
  }
  return (
    process.env.CLOSEDMESH_MODEL ?? process.env.MESH_LLM_MODEL ?? "Qwen3-8B"
  );
}

/**
 * System prompt prepended to every conversation.
 *
 * Open-weight models will faithfully self-identify by their lineage when
 * asked "where do you run" — GLM says "Z.ai", Qwen says "Alibaba", Llama
 * says "Meta". That's accurate from the model's POV (it knows who *trained*
 * it) but actively misleading for our users: ClosedMesh routes their
 * prompt to a peer running the open weights, not to any of those vendors'
 * APIs. This prompt corrects the runtime-location story without trying
 * to suppress the model's identity.
 *
 * Kept short and factual on purpose. We don't want to inject a persona,
 * a tone, or product marketing — just the one piece of context the model
 * couldn't possibly have learned on its own.
 */
const SYSTEM_PROMPT = `You are an AI assistant accessed through ClosedMesh, an open peer-to-peer network where open-weight models run on hardware contributed by individuals and teams.

Important context about your runtime:
- You are NOT running on Z.ai, OpenAI, Anthropic, Google, Meta, Alibaba, or any other AI provider's cloud, even if you were trained by one of them.
- You are being served by a peer in the ClosedMesh network — a contributor's machine (laptop, workstation, or GPU box) that chose to share its compute.
- Conversations do not pass through a third-party AI API. The mesh routes the request directly to whichever peer can serve the requested model.
- It is fine to acknowledge your model lineage (e.g. "I'm a Qwen 3 model" or "I'm based on GLM"). Do not claim to be hosted by the company that trained you.

If asked about ClosedMesh itself: it's a peer-to-peer LLM mesh. Anyone can use the chat at closedmesh.com or in the desktop app, and anyone with a capable machine can run a node and contribute compute. The runtime is open source.`;

export async function OPTIONS(req: Request) {
  return preflightResponse(req);
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
  if (lower.includes("503") || lower.includes("unavailable"))
    return "The model is temporarily unavailable on the mesh. Try again in a few seconds.";
  return fallback;
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    messages: UIMessage[];
    model?: string;
  };

  const modelId = body.model ?? (await pickDefaultModel());

  const result = streamText({
    model: closedmesh.chatModel(modelId),
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(body.messages),
    // The AI SDK retries up to 2x on 5xx by default. For a peer-to-peer
    // mesh this is actively harmful: a 503 from the runtime almost always
    // means "no host elected" or "host saturated", neither of which is
    // resolved by hammering it 200ms later. Worse, the retries can trip
    // the entry node's per-IP rate limit, turning a clean 503 into a
    // 429 and confusing the actual diagnosis. One attempt; let the user
    // (or chat UI) decide whether to retry.
    maxRetries: 0,
  });

  return applyCors(
    req,
    result.toUIMessageStreamResponse({
      onError: friendlyChatError,
    }),
  );
}
