import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./Logo";

/**
 * Shared header for closedmesh.com — homepage chat, /about, /download all
 * use this so the brand surface is identical across the public site.
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
    <header className={sticky}>
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight text-[var(--fg)]">
              ClosedMesh
            </div>
            <div className="text-[11px] text-[var(--fg-muted)]">
              Open peer-to-peer LLM mesh.
            </div>
          </div>
        </Link>
        {status ? (
          <div className="hidden sm:flex">{status}</div>
        ) : null}
        <nav className="flex items-center gap-5 text-[12px]">
          <Link
            href="/about"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            How it works
          </Link>
          <Link
            href="/download"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-black shadow-[0_6px_18px_-10px_rgba(255,122,69,0.7)] transition hover:brightness-110"
          >
            Download
          </Link>
        </nav>
      </div>
    </header>
  );
}
