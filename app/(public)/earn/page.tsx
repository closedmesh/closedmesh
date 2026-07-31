import type { Metadata } from "next";
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
 * Signed-in chrome (user toggle) lives inside EarnPanel, not the site header.
 */
export default function EarnPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main>
        <section>
          <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
            <EarnPanel />
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
