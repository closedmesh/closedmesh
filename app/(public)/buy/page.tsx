import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";
import { BuyPanel } from "../../components/BuyPanel";

export const metadata: Metadata = {
  title: "Buy credits — Senda",
  description:
    "Top up Senda API credits with USDC on Solana. Mint a ck_ key for the OpenAI-compatible paid API.",
};

/**
 * /buy — Phase 5.C customer credit purchase (USDC on Solana).
 */
export default function BuyPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main>
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Paid API
            </div>
            <h1 className="mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
              Buy credits with USDC
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Prices are in USD. Settlement is USDC on Solana. Use your balance
              with an OpenAI-compatible key against{" "}
              <code className="text-[var(--fg)]">/v1/chat/completions</code>.
              Free chat on the homepage stays free.
            </p>
            <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
              Prefer docs first?{" "}
              <Link href="/docs" className="text-[var(--accent)] underline">
                Read the API notes
              </Link>
              .
            </p>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-3xl px-6 py-12">
            <BuyPanel />
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
