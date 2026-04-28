import type { Metadata } from "next";
import Link from "next/link";
import { ChatExperience } from "../components/ChatExperience";
import { PublicHeader } from "../components/PublicHeader";

export const metadata: Metadata = {
  title: "ClosedMesh — open peer-to-peer LLM",
  description:
    "Chat with an LLM running on a peer-to-peer mesh of contributed compute. Open, no third-party API behind it.",
};

/**
 * Public homepage at https://closedmesh.com/.
 *
 * The visitor lands directly in the chat. No modal, no setup gate, no
 * "your machine" framing — the website is just a chat surface backed by
 * the public mesh entry point. People who want to *contribute compute*
 * download the desktop app; those are two separate user journeys and
 * the homepage doesn't conflate them.
 */
export default function PublicHomePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader />

      <main className="flex flex-1 flex-col">
        <ChatExperience empty={<HomepageIntro />} />
      </main>
    </div>
  );
}

function HomepageIntro() {
  const suggestions = [
    "Summarize a 1-paragraph product pitch in plain language.",
    "Draft a Slack message inviting my team to a planning session.",
    "Explain pipeline parallelism vs. MoE expert sharding in 4 lines.",
  ];
  return (
    <div className="relative mx-auto max-w-xl py-14 text-center">
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
          Open peer-to-peer LLM
        </div>
        <h1 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Chat with a model that doesn&apos;t live behind a paywall.
        </h1>
        <p className="mx-auto mt-3 max-w-md text-pretty text-[14px] leading-relaxed text-[var(--fg-muted)]">
          ClosedMesh is a mesh of contributed compute serving open models.
          Type a message to try it.
        </p>
        <ul className="mt-7 space-y-2 text-left">
          {suggestions.map((s) => (
            <li
              key={s}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 text-sm text-[var(--fg-muted)] transition hover:border-[var(--accent)]/30 hover:text-[var(--fg)]"
            >
              {s}
            </li>
          ))}
        </ul>
        <div className="mt-7 text-[12px] text-[var(--fg-muted)]">
          Want to contribute compute?{" "}
          <Link
            href="/download"
            className="text-[var(--accent)] hover:underline"
          >
            Download the desktop app
          </Link>{" "}
          and join the mesh.
        </div>
      </div>
    </div>
  );
}
