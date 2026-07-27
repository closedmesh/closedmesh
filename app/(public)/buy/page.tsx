import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";
import { BuyPanel } from "../../components/BuyPanel";

export const metadata: Metadata = {
  title: "API access (preview) — Senda",
  description:
    "Paid API preview: top up an API balance with USDC on Solana, mint a ck_ key, call senda.network/v1. Free chat stays free. Request refunds for unused balance. Peer USD payouts are preview/ops-gated.",
};

/**
 * /buy — Phase 5.C customer API balance (USDC on Solana). Preview framing.
 */
export default function BuyPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main>
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Paid API preview
            </div>
            <h1 className="mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
              Get an API key
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Top up an <strong className="font-medium text-[var(--fg)]">API balance</strong>{" "}
              with USDC on Solana (prices in USD). Call the OpenAI-compatible{" "}
              <code className="text-[var(--fg)]">/v1/chat/completions</code>{" "}
              endpoint with a <code className="text-[var(--fg)]">ck_</code> key.
              Homepage chat stays free — no wallet required.
            </p>
            <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[var(--fg-muted)]">
              Running a node?{" "}
              <Link href="/contribute" className="text-[var(--accent)] underline">
                Contribution credits
              </Link>{" "}
              stay illustrative; paid{" "}
              <code className="text-[var(--fg)]">/v1</code> serves can accrue a
              separate peer USD balance (payouts still preview / ops-gated). See{" "}
              <Link href="/terms" className="text-[var(--accent)] underline">
                terms
              </Link>
              .
            </p>
            <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
              <Link href="/docs" className="text-[var(--accent)] underline">
                Developer docs →
              </Link>
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
