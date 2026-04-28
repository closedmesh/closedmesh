import type { Metadata } from "next";
import Link from "next/link";
import { ChatExperience } from "../components/ChatExperience";
import { MeshLiveStatus } from "../components/MeshLiveStatus";
import { PublicHeader } from "../components/PublicHeader";

export const metadata: Metadata = {
  title: "ClosedMesh — your private LLM",
  description:
    "Open-weight models, served by a peer-to-peer mesh of contributed compute. No third-party API in the middle. Use the chat or run a node.",
};

/**
 * Public homepage at https://closedmesh.com/.
 *
 * Two audiences land on this page and the framing has to work for both:
 *
 *   1. Someone who just wants a private LLM chat. Their question is "is
 *      this trustworthy and does it work?" — answered by leading with
 *      "private LLM mesh" + a live indicator showing the mesh is actually
 *      serving real models, plus the chat composer right there.
 *
 *   2. Someone who has a GPU or laptop and might lend compute. Their
 *      question is "what is this thing I'd be joining?" — answered by
 *      the same headline (mesh, peer-to-peer, hardware) and a clear
 *      pointer to /download from the empty state.
 *
 * We deliberately don't lead with anything price-related. The economics
 * may change; the architecture won't.
 */
export default function PublicHomePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader status={<MeshLiveStatus variant="header" />} />

      <main className="flex flex-1 flex-col">
        <ChatExperience empty={<HomepageIntro />} />
      </main>
    </div>
  );
}

function HomepageIntro() {
  // Three suggestions chosen to be:
  // - immediately relatable (no jargon, no insider product talk)
  // - structurally different from each other (write / explain / plan)
  // - genuinely useful, so a visitor sees real value on first try
  const suggestions = [
    "Write a polite email canceling tomorrow's meeting.",
    "Explain compound interest to a curious 12-year-old.",
    "Plan a 3-day weekend in Lisbon with one rainy day.",
  ];
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
        </h1>
        <p className="mx-auto mt-4 max-w-md text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
          Open-weight models, served by a peer-to-peer mesh of contributed
          compute. No third-party API in the middle.
        </p>
        <div className="mt-5 flex justify-center">
          <MeshLiveStatus />
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
