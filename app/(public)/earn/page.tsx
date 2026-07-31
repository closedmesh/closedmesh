import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";
import { EarnPanel } from "../../components/EarnPanel";

export const metadata: Metadata = {
  title: "Earner dashboard — Senda",
  description:
    "Sign in with Phantom to see contributor credits, tokens served, and Peer USD for the node bound to your payout wallet.",
};

/**
 * /earn — Phantom-gated view of peer contribution + Peer USD.
 * Requires a prior desktop wallet bind (peer ↔ Solana address).
 */
export default function EarnPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main>
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Earners
            </div>
            <h1 className="mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
              Your node earnings
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Sign with the Phantom wallet you bound in the desktop app. We show
              contributor credits, tokens served by model, and Peer USD from
              paid{" "}
              <code className="text-[var(--fg)]">/v1</code> mesh serves.
            </p>
            <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
              No bind yet?{" "}
              <Link href="/contribute" className="text-[var(--accent)] underline">
                Run a node
              </Link>
              , then Peer USD → Bind wallet in Senda desktop.{" "}
              <Link href="/peer-bind" className="text-[var(--accent)] underline">
                Bind help →
              </Link>
            </p>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-3xl px-6 py-12">
            <EarnPanel />
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
