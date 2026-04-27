import type { UIMessage } from "ai";

export function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  return (
    <div
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={[
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap",
          isUser
            ? "bg-[var(--bg-elev-2)] text-[var(--fg)]"
            : "bg-transparent text-[var(--fg)]",
        ].join(" ")}
      >
        {!isUser && (
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
            ClosedMesh
          </div>
        )}
        {text || (
          <span className="inline-flex items-center gap-1 text-[var(--fg-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--fg-muted)] pulse-soft" />
            <span className="text-xs">thinking…</span>
          </span>
        )}
      </div>
    </div>
  );
}
