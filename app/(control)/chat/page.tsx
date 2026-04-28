"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ChatExperience } from "../../components/ChatExperience";
import { PageHeader } from "../../components/PageHeader";
import { StatusPill } from "../../components/StatusPill";

const SESSION_KEY = "closedmesh:threadId";

function newThreadId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function ChatPage() {
  // Bumping this nonce forces ChatExperience to remount with a fresh thread.
  const [threadNonce, setThreadNonce] = useState(0);

  const startNewChat = useCallback(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(SESSION_KEY, newThreadId());
    setThreadNonce((n) => n + 1);
  }, []);

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

      <ChatExperience
        key={threadNonce}
        empty={<ControlEmptyState />}
      />
    </div>
  );
}

function ControlEmptyState() {
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
        <div className="mt-6 flex items-center justify-center gap-3 text-[12px] text-[var(--fg-muted)]">
          <Link href="/models" className="hover:text-[var(--fg)]">
            Browse models →
          </Link>
        </div>
      </div>
    </div>
  );
}
