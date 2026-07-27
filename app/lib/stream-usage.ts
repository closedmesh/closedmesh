/** Rough completion-token estimate from streamed assistant text. */
export function estimateCompletionTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function extractDeltaContent(payload: string): string {
  try {
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; text?: string }>;
    };
    const choice = chunk.choices?.[0];
    if (!choice) return "";
    if (typeof choice.delta?.content === "string") return choice.delta.content;
    if (typeof choice.text === "string") return choice.text;
  } catch {
    // ignore
  }
  return "";
}
