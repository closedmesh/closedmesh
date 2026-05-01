"use client";

import Link from "next/link";
import {
  ChatExperience,
  type ChatEmptyStateApi,
} from "../components/ChatExperience";
import { MeshLiveStatus } from "../components/MeshLiveStatus";

// Three suggestions chosen to be:
// - immediately relatable (no jargon, no insider product talk)
// - structurally different from each other (write / explain / plan)
// - genuinely useful, so a visitor sees real value on first try
const SUGGESTIONS = [
  "Write a polite email canceling tomorrow's meeting.",
  "Explain compound interest to a curious 12-year-old.",
  "Plan a 3-day weekend in Lisbon with one rainy day.",
];

/**
 * The homepage chat + empty state live in a client component because the
 * empty state passes a function (`onSuggest`) into ChatExperience. Next
 * (App Router) disallows function props crossing the server→client
 * boundary, so the page-level server component just renders this wrapper.
 */
export function HomepageChat() {
  return (
    <ChatExperience
      empty={(api) => <HomepageIntro onSuggest={api.onSuggest} />}
    />
  );
}

function HomepageIntro({
  onSuggest,
}: {
  onSuggest: ChatEmptyStateApi["onSuggest"];
}) {
  return (
    <div className="relative mx-auto max-w-2xl py-14 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-8 h-40"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(255,122,69,0.14), transparent 70%)",
        }}
      />
      <div className="relative">
        <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
          Open peer-to-peer mesh
        </div>
        <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Your private LLM.
          <span className="block text-[var(--fg-muted)]">
            On hardware people own.
          </span>
        </h1>
        <p className="mx-auto mt-4 max-w-md text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
          A peer-to-peer mesh of contributed machines, running open-weight
          models. No third-party API in the middle.
        </p>
        <div className="mt-5 flex justify-center">
          <MeshLiveStatus />
        </div>
        <ul className="mt-8 space-y-2 text-left">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => onSuggest(s)}
                className="block w-full rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-left text-sm text-[var(--fg-muted)] transition hover:border-[var(--accent)]/30 hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)] focus:outline-none focus-visible:border-[var(--accent)]/60"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-7 text-[12px] text-[var(--fg-muted)]">
          Have a machine to spare?{" "}
          <Link
            href="/download"
            className="text-[var(--accent)] hover:underline"
          >
            Run a node
          </Link>{" "}
          and add your hardware to the mesh.
        </div>
      </div>
    </div>
  );
}
