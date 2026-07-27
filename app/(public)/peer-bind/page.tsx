import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";
import { PeerBindPanel } from "../../components/PeerBindPanel";

export const metadata: Metadata = {
  title: "Bind payout wallet — Senda",
  description:
    "Attach a Solana wallet to your Senda peer for peer USD payouts. Requires a node-proven challenge from the desktop app.",
};

export default function PeerBindPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main>
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-xl px-6 py-16 sm:py-20">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Earners
            </div>
            <h1 className="mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
              Bind payout wallet
            </h1>
            <p className="mt-4 text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Step 2 of 2. Your desktop app proved control of the node key; this
              page attaches the Solana address that receives peer USD (USDC)
              when you request a payout.
            </p>
            <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
              <Link href="/contribute" className="text-[var(--accent)] underline">
                Contribute →
              </Link>
            </p>
          </div>
        </section>
        <section>
          <div className="mx-auto max-w-xl px-6 py-12">
            <Suspense
              fallback={
                <div className="text-[13px] text-[var(--fg-muted)]">Loading…</div>
              }
            >
              <PeerBindPanel />
            </Suspense>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
