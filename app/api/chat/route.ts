import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { applyCors, preflightResponse } from "../_cors";

export const runtime = "nodejs";
export const maxDuration = 300;

const RUNTIME_URL =
  process.env.CLOSEDMESH_RUNTIME_URL ??
  process.env.MESH_LLM_URL ??
  "http://127.0.0.1:9337/v1";

// Bearer token shared with the runtime's Caddy auth gateway. Set on Vercel
// for the public deployment; unset in local dev where the runtime is on
// the loopback. We strip surrounding whitespace because Vercel has burned
// us before with a `"public\n"` env value.
const RUNTIME_TOKEN = (
  process.env.CLOSEDMESH_RUNTIME_TOKEN ?? ""
).trim();

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
  });

  return applyCors(req, result.toUIMessageStreamResponse());
}
