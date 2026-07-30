"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ChatExperience,
  type ChatEmptyStateApi,
} from "../../components/ChatExperience";
import { Button } from "../../components/ui/Button";
import { useSharing } from "../../lib/use-control-status";

const SESSION_KEY = "senda:threadId";

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

  // The global command palette / top bar can request a fresh thread.
  useEffect(() => {
    const onNew = () => startNewChat();
    window.addEventListener("senda:new-chat", onNew);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("senda:new-chat", onNew);
      window.removeEventListener("keydown", onKey);
    };
  }, [startNewChat]);

  // `h-full`: the AppShell <main> is the bounded scroll container, and the
  // messages list inside ChatExperience scrolls within itself — every ancestor
  // in the flex chain needs a bounded height for that to work.
  return (
    <div className="flex h-full flex-col">
      <ChatExperience
        key={threadNonce}
        empty={(api) => <ControlEmptyState onSuggest={api.onSuggest} />}
      />
    </div>
  );
}

function ControlEmptyState({
  onSuggest,
}: {
  onSuggest: ChatEmptyStateApi["onSuggest"];
}) {
  const suggestions = [
    "Write a polite email canceling tomorrow's meeting.",
    "Explain compound interest to a curious 12-year-old.",
    "Plan a 3-day weekend in Lisbon with one rainy day.",
  ];

  return (
    <div className="relative mx-auto max-w-xl py-16 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-8 h-40"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, var(--accent-soft), transparent 70%)",
        }}
      />
      <div className="relative">
        <div className="text-balance text-[28px] font-semibold tracking-tight text-[var(--fg)]">
          Chat with the mesh
        </div>
        <div className="mt-2 text-pretty text-[14px] text-[var(--fg-muted)]">
          Type below and your prompt is answered by a machine in the network —
          this one included, when it&apos;s sharing.
        </div>

        <SharingHomeCard />

        <ul className="mt-8 space-y-2 text-left">
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => onSuggest(s)}
                className="block w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-left text-sm text-[var(--fg-muted)] transition hover:border-[var(--accent)]/30 hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)] focus:outline-none focus-visible:border-[var(--accent)]/60"
              >
                {s}
              </button>
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

/**
 * Soft contributor status on the chat home. Chat itself always goes through
 * `/api/chat` (public mesh) — a local runtime that is still starting or
 * stopped must never look like chat is broken.
 */
function SharingHomeCard() {
  const sharing = useSharing();

  if (sharing.publicDeployment) return null;
  if (sharing.state === "running") return null;

  const joining =
    sharing.state === "loading" ||
    sharing.state === "starting" ||
    sharing.busy === "start";

  if (joining) {
    return (
      <div className="mx-auto mt-7 max-w-md rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-left">
        <div className="text-[13px] font-medium text-[var(--fg)]">
          Starting this machine…
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--fg-muted)]">
          You can chat now — the runtime is coming up so this Mac can also
          serve the mesh.
        </div>
      </div>
    );
  }

  if (sharing.state === "stopping") {
    return (
      <div className="mx-auto mt-7 max-w-md rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-left">
        <div className="text-[13px] font-medium text-[var(--fg)]">
          Stopping this machine…
        </div>
      </div>
    );
  }

  // Stopped / unknown — chat still works. Offer an optional contribute path.
  return (
    <div className="mx-auto mt-7 flex max-w-md items-center justify-between gap-4 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-left">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--fg)]">
          Chat works either way
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--fg-muted)]">
          This machine isn&apos;t sharing right now. Start it to contribute, or
          just type below.
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={sharing.busy !== null}
        onClick={() => sharing.start()}
      >
        {sharing.busy === "start" ? "Starting…" : "Start"}
      </Button>
    </div>
  );
}
