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
 * /earn — Phantom-gated peer earnings panel.
 * Requires a prior desktop wallet bind (peer ↔ Solana address).
 * Signed-in chrome lives inside EarnPanel.
 */
export default function EarnPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main className="mx-auto max-w-5xl px-6 py-10 sm:py-12">
        <EarnPanel />
      </main>
      <PublicFooter />
    </div>
  );
}
