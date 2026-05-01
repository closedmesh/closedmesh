"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMessage } from "./ChatMessage";
import { apiUrl } from "../lib/runtime-target";

const SESSION_KEY = "closedmesh:threadId";
const STORAGE_PREFIX = "closedmesh:thread:";

function newThreadId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readPersistedMessages(threadId: string): UIMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + threadId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UIMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Hooks exposed to empty-state builders so a suggestion tile can prefill
 * and focus the composer. Kept intentionally minimal — anything richer
 * (submit, streaming state) belongs inside ChatExperience itself.
 */
export type ChatEmptyStateApi = {
  /** Prefill the composer with `text` and focus the textarea. */
  onSuggest: (text: string) => void;
};

export type ChatExperienceProps = {
  /**
   * Empty-state shown above the composer when there are no messages yet.
   * Accepts either a plain ReactNode or a builder that receives the
   * composer api so suggestions can wire `onClick` to prefill the input.
   */
  empty?: React.ReactNode | ((api: ChatEmptyStateApi) => React.ReactNode);
  /** Content rendered above the messages list. Used for marketing copy. */
  intro?: React.ReactNode;
  /** Class applied to the outer scroll container. */
  scrollerClassName?: string;
  /**
   * Render the input + message list inside a centred max-width container.
   * The default (true) is what both surfaces want.
   */
  centered?: boolean;
  /** Tagline under the composer. Each surface can supply its own framing. */
  footnote?: React.ReactNode;
};

/**
 * The chat experience shared by the public homepage at `/` and the local
 * controller's `/chat` page. Same wire protocol in both: a same-origin
 * fetch to `/api/chat`, which the surrounding Next.js process is responsible
 * for proxying to whichever closedmesh-llm endpoint it's been pointed at
 * (the public mesh entry, or the visitor's local runtime). This component
 * has no knowledge of "is the mesh local or remote" and deliberately makes
 * no assumptions about whether the visitor has anything installed.
 */
export function ChatExperience({
  empty,
  intro,
  scrollerClassName,
  centered = true,
  footnote,
}: ChatExperienceProps) {
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [hydratedMessages, setHydratedMessages] = useState<UIMessage[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newThreadId();
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    setThreadId(id);
    setHydratedMessages(readPersistedMessages(id));
    setHydrated(true);
  }, []);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: apiUrl("/api/chat") }),
    [],
  );

  const { messages, setMessages, sendMessage, status, stop, error } = useChat({
    id: threadId ?? undefined,
    transport,
  });

  useEffect(() => {
    if (!hydrated) return;
    if (hydratedMessages.length > 0) {
      setMessages(hydratedMessages);
    }
  }, [hydrated, hydratedMessages, setMessages]);

  const isStreaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (!hydrated || !threadId || typeof window === "undefined") return;
    if (isStreaming) return;
    try {
      if (messages.length === 0) {
        window.localStorage.removeItem(STORAGE_PREFIX + threadId);
      } else {
        window.localStorage.setItem(
          STORAGE_PREFIX + threadId,
          JSON.stringify(messages),
        );
      }
    } catch {
      // quota exceeded etc. — silently drop persistence
    }
  }, [messages, threadId, hydrated, isStreaming]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    sendMessage({ text: trimmed });
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const clearStored = useCallback(() => {
    if (!threadId || typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_PREFIX + threadId);
    setMessages([]);
  }, [threadId, setMessages]);

  // Suggestion tiles prefill the composer rather than auto-submitting so the
  // visitor stays in control (they can edit, add context, or cancel). Also
  // resize the textarea to fit multi-line prompts and focus it.
  const handleSuggest = useCallback((text: string) => {
    setInput(text);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
      el.focus();
      const len = text.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // some browsers throw on setSelectionRange for detached nodes
      }
    }
  }, []);

  const emptyApi = useMemo<ChatEmptyStateApi>(
    () => ({ onSuggest: handleSuggest }),
    [handleSuggest],
  );
  const renderedEmpty = typeof empty === "function" ? empty(emptyApi) : empty;

  const innerWrap = centered
    ? "mx-auto flex max-w-3xl flex-col gap-5 px-4 py-8"
    : "flex flex-col gap-5 px-4 py-8";

  return (
    <>
      <div
        ref={scrollerRef}
        className={
          scrollerClassName ?? "flex-1 overflow-y-auto scrollbar-thin"
        }
      >
        <div className={innerWrap}>
          {intro}
          {messages.length === 0 ? (
            renderedEmpty ?? null
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}
          {error && <ChatError error={error} />}
        </div>
      </div>

      <footer className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
        <div className={centered ? "mx-auto max-w-3xl px-4 py-4" : "px-4 py-4"}>
          <form
            onSubmit={submit}
            className="flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 focus-within:border-[var(--accent)]/60"
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={onKeyDown}
              placeholder="Ask anything…"
              rows={1}
              className="max-h-[200px] flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:outline-none"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={() => stop()}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--border)]"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-black shadow-[0_6px_18px_-10px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                Send
              </button>
            )}
          </form>
          <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-[var(--fg-muted)]">
            <span>{footnote ?? "Powered by ClosedMesh — open peer-to-peer LLM mesh."}</span>
            {messages.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <button
                  onClick={clearStored}
                  className="underline-offset-2 hover:text-[var(--fg)] hover:underline"
                >
                  Clear this thread
                </button>
              </>
            )}
          </div>
        </div>
      </footer>
    </>
  );
}

function ChatError({ error }: { error: Error }) {
  // Generic error surface. The runtime occasionally returns a structured
  // 503 with `reason_code: "no_capable_node"` when the request requires
  // hardware no live peer can serve; we surface that distinctly because
  // it's actionable ("the mesh is busy / try a smaller model") rather
  // than a transport failure.
  const msg = error.message || "";
  const isNoCapableNode = msg.includes("no_capable_node");

  if (isNoCapableNode) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
        <div className="font-medium">The mesh is busy right now.</div>
        <div className="mt-1 text-amber-300/80">
          No node currently online can serve this model. Try a smaller
          model or try again in a moment.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300">
      {msg || "Couldn't reach the mesh. Try again in a moment."}
    </div>
  );
}
