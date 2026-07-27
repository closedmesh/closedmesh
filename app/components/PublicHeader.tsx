import Link from "next/link";
import type { ReactNode } from "react";
import { EarlyAccessBanner } from "./EarlyAccessBanner";
import { Logo } from "./Logo";
import { MobileNav, type NavLink } from "./MobileNav";

const GITHUB_URL = "https://github.com/senda-network/senda-llm";

/**
 * Primary public nav — three first-order links. Updates and Contribute live
 * off-nav (docs/status and the CTA button respectively); Metrics stays in the
 * footer as a niche transparency surface.
 */
const NAV_LINKS: NavLink[] = [
  { href: "/about", label: "How it works" },
  { href: "/docs", label: "Docs" },
  { href: "/status", label: "Status" },
  { href: "/buy", label: "Buy" },
];

/**
 * Shared header for senda.network — homepage chat, /about, /download, /docs
 * and every other public page use this so the brand surface is identical
 * across the site.
 *
 * Note: deliberately *not* used inside the (control) group. The local
 * controller / desktop app uses the sidebar shell instead; the visitor
 * there is already inside their own machine and doesn't need a marketing
 * header pointing them to "Download".
 */
export function PublicHeader({
  variant = "default",
  status,
}: {
  /**
   * `default` — sticky, blurred-glass top bar (chat homepage, /about).
   * `flat` — non-sticky, sits above hero content (used by /download where
   * the page itself manages scroll position).
   */
  variant?: "default" | "flat";
  /**
   * Optional slot rendered between the brand and the nav — used by the
   * homepage to surface a tiny live "mesh online" pill so visitors can
   * see at a glance that the network is actually serving traffic.
   */
  status?: ReactNode;
}) {
  const sticky =
    variant === "default"
      ? "sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/60"
      : "border-b border-[var(--border)] bg-[var(--bg)]";
  return (
    <header className={`relative ${sticky}`}>
      <EarlyAccessBanner />
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight text-[var(--fg)]">
              Senda
            </div>
            <div className="text-[11px] text-[var(--fg-muted)]">
              Open peer-to-peer LLM mesh.
            </div>
          </div>
        </Link>

        {status ? <div className="hidden sm:flex">{status}</div> : null}

        <div className="flex items-center gap-3 sm:gap-5">
          <nav className="hidden items-center gap-5 text-[12px] md:flex">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
              >
                {l.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Senda runtime on GitHub"
              className="text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden
              >
                <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
              </svg>
            </a>
          </nav>

          <Link
            href="/contribute"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-black shadow-[0_6px_18px_-10px_rgba(26,157,95,0.7)] transition hover:brightness-110"
          >
            Run a node
          </Link>

          <MobileNav links={NAV_LINKS} github={GITHUB_URL} />
        </div>
      </div>
    </header>
  );
}
