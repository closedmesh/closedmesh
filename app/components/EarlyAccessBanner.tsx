import Link from "next/link";

/**
 * Site-wide early-access notice for the in-development mesh launch.
 * Rendered above the public nav on every page that uses `PublicHeader`.
 *
 * Sets honest expectations without sounding broken: preview paid API,
 * contributor credits tracked, peer USD bind/payout via desktop, free chat.
 */
export function EarlyAccessBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-400/15 px-4 py-2 text-center text-[11px] leading-relaxed text-[var(--fg-muted)] sm:text-[12px]">
      <span className="font-semibold text-amber-700">Early access.</span>{" "}
      The mesh is live and under active development — latency and uptime vary.{" "}
      <Link href="/buy" className="text-[var(--accent)] hover:underline">
        Paid API preview
      </Link>
      {" · "}
      <Link href="/earn" className="text-[var(--accent)] hover:underline">
        Earner dashboard
      </Link>
      {" · "}
      <Link href="/contribute" className="text-[var(--accent)] hover:underline">
        Contributor credits
      </Link>{" "}
      tracked; peer USD may accrue on paid serves. Free chat stays free.{" "}
      <Link href="/security" className="text-[var(--accent)] hover:underline">
        Security →
      </Link>
    </div>
  );
}
