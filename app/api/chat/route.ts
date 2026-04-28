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
    messages: convertToModelMessages(body.messages),
  });

  return applyCors(req, result.toUIMessageStreamResponse());
}
