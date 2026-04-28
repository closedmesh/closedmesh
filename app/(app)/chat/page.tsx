"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMessage } from "../../components/ChatMessage";
import { PageHeader } from "../../components/PageHeader";
import { StatusPill } from "../../components/StatusPill";
import { apiUrl, isPublicDeployment } from "../../lib/runtime-target";
import { useMeshStatus } from "../../lib/use-mesh-status";

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

export default function ChatPage() {
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

  const meshStatus = useMeshStatus();
  // On the public site we *cannot* chat without a local mesh — the browser
  // calls back into localhost and that has to be running. On the local
  // controller, the mesh is on the same machine, so a transient offline blip
  // from the status probe shouldn't lock the UI.
  const meshUnavailable =
    isPublicDeployment() && !meshStatus.loading && !meshStatus.online;

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
    if (!trimmed || isStreaming || meshUnavailable) return;
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

  const startNewChat = useCallback(() => {
    if (typeof window === "undefined") return;
    const next = newThreadId();
    window.sessionStorage.setItem(SESSION_KEY, next);
    setThreadId(next);
    setMessages([]);
  }, [setMessages]);

  const clearStored = useCallback(() => {
    if (!threadId || typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_PREFIX + threadId);
    setMessages([]);
  }, [threadId, setMessages]);

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader
        title="Chat"
        subtitle="Answers come from your mesh. Nothing leaves it."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={startNewChat}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)]"
              title="Start a new chat (clears the current thread)"
            >
              New chat
            </button>
            <StatusPill />
          </div>
        }
      />

      <main ref={scrollerRef} className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-8">
          {messages.length === 0 ? (
            meshUnavailable ? (
              <NoLocalMesh />
            ) : (
              <EmptyState />
            )
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}
          {error && <ChatError error={error} />}
        </div>
      </main>

      <footer className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 py-4">
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
              placeholder={
                meshUnavailable
                  ? "Install ClosedMesh to start chatting…"
                  : "Ask anything…"
              }
              disabled={meshUnavailable}
              rows={1}
              className="max-h-[200px] flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
                disabled={!input.trim() || meshUnavailable}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-black shadow-[0_6px_18px_-10px_rgba(255,122,69,0.7)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                Send
              </button>
            )}
          </form>
          <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-[var(--fg-muted)]">
            <span>Served by your mesh. Nothing leaves it.</span>
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
    </div>
  );
}

function EmptyState() {
  const suggestions = [
    "Summarize a 1-paragraph pitch for our team.",
    "Write a Slack message inviting teammates to share their GPU.",
    "Explain how a mesh-served LLM differs from cloud inference.",
  ];
  return (
    <div className="relative mx-auto max-w-xl py-16 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-8 h-40"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(255,122,69,0.12), transparent 70%)",
        }}
      />
      <div className="relative">
        <div className="text-balance text-3xl font-semibold tracking-tight">
          Your team&apos;s private LLM.
        </div>
        <div className="mt-2 text-pretty text-sm text-[var(--fg-muted)]">
          Running on machines you own. Nothing leaves the mesh.
        </div>
        <ul className="mt-8 space-y-2 text-left">
          {suggestions.map((s) => (
            <li
              key={s}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-sm text-[var(--fg-muted)] transition hover:border-[var(--accent)]/30 hover:text-[var(--fg)]"
            >
              {s}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ChatError({ error }: { error: Error }) {
  // The runtime returns a structured JSON 503 with `reason_code: "no_capable_node"`
  // when the request requires hardware (VRAM, backend) that no live mesh node
  // can serve.
  const msg = error.message || "";
  const isNoCapableNode = msg.includes("no_capable_node");

  if (isNoCapableNode) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
        <div className="font-medium">
          Your mesh can&apos;t run that model yet.
        </div>
        <div className="mt-1 text-amber-300/80">
          Every connected machine is too small for this one. Try a smaller
          model, or add a beefier machine to your mesh.
        </div>
        <div className="mt-2 text-xs text-amber-300/70">
          Open{" "}
          <a href="/nodes" className="underline hover:text-amber-200">
            Mesh
          </a>{" "}
          to see what each machine can run, or{" "}
          <a href="/models" className="underline hover:text-amber-200">
            pick another model
          </a>
          .
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300">
      {msg || "Something went wrong talking to the mesh."}
    </div>
  );
}

function NoLocalMesh() {
  return (
    <div className="relative mx-auto max-w-xl py-12 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-6 h-40"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(255,122,69,0.16), transparent 70%)",
        }}
      />
      <div className="relative">
        <div className="text-balance text-3xl font-semibold tracking-tight">
          No mesh on this machine yet.
        </div>
        <div className="mx-auto mt-2 max-w-md text-pretty text-sm text-[var(--fg-muted)]">
          ClosedMesh runs entirely on hardware you own. Install the desktop
          app once and chat lights up — your messages never leave the mesh.
        </div>

        <div className="mt-7 flex justify-center">
          <a
            href="/download"
            className="rounded-xl bg-[var(--accent)] px-6 py-3 text-sm font-semibold text-black shadow-[0_10px_30px_-12px_rgba(255,122,69,0.8)] transition hover:brightness-110"
          >
            Download ClosedMesh
          </a>
        </div>

        <div className="mt-5 text-[12px] text-[var(--fg-muted)]">
          Already installed? Make sure ClosedMesh is running, then refresh.
        </div>
      </div>
    </div>
  );
}
