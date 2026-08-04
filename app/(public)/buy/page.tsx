import type { Metadata } from "next";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";
import { BuyPanel } from "../../components/BuyPanel";

export const metadata: Metadata = {
  title: "API account — Senda",
  description:
    "Paid API preview: top up an API balance with USDC on Solana, mint a ck_ key, call senda.network/v1. Free chat stays free. Request refunds for unused balance.",
};

/**
 * /buy — customer API account panel (USDC prepaid balance + ck_ keys).
 * Signed-in chrome lives inside BuyPanel.
 */
export default function BuyPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />
      <main className="mx-auto max-w-5xl px-6 py-10 sm:py-12">
        <BuyPanel />
      </main>
      <PublicFooter />
    </div>
  );
}
