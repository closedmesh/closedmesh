import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { applyCors, preflightResponse } from "../_cors";

export const runtime = "nodejs";
export const maxDuration = 300;

const RUNTIME_URL =
  process.env.CLOSEDMESH_RUNTIME_URL ??
  process.env.MESH_LLM_URL ??
  "http://127.0.0.1:9337/v1";

const closedmesh = createOpenAICompatible({
  name: "closedmesh",
  baseURL: RUNTIME_URL,
});

async function pickDefaultModel(): Promise<string> {
  try {
    const res = await fetch(`${RUNTIME_URL}/models`, { cache: "no-store" });
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
