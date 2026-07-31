import Link from "next/link";
import { Logo } from "./Logo";

/**
 * Shared site footer for the public marketing pages. The homepage had no
 * footer before the redesign, so `/status`, `/metrics`, and `/updates`
 * were effectively undiscoverable from `/`. This surfaces the full
 * sitemap, including `/updates` (the public dev log), in one place.
 */
export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--border)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-2.5">
          <Logo />
          <div className="text-[12px] text-[var(--fg-muted)]">
            Senda — an open peer-to-peer network for LLMs.
            <span className="mt-0.5 block text-[var(--fg-muted)] opacity-70">
              senda: Spanish for path — the route a request takes to a machine
              that can run it.
            </span>
          </div>
        </div>
        <nav className="grid grid-cols-2 gap-x-12 gap-y-2 text-[12px] sm:grid-cols-3">
          <Link
            href="/about"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            How it works
          </Link>
          <Link
            href="/docs"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Docs
          </Link>
          <Link
            href="/status"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Status
          </Link>
          <Link
            href="/metrics"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Metrics
          </Link>
          <Link
            href="/earn"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Earn
          </Link>
          <Link
            href="/contribute"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Contribute
          </Link>
          <Link
            href="/security"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Security
          </Link>
          <Link
            href="/updates"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Updates
          </Link>
          <Link
            href="/download"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Download
          </Link>
          <Link
            href="/privacy"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Terms
          </Link>
          <a
            href="https://github.com/senda-network/senda-llm"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Runtime on GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
