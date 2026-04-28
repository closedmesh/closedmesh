import Link from "next/link";
import { Logo } from "./components/Logo";

/**
 * Global 404. Reachable both naturally (a typo'd URL) and synthetically
 * (middleware rewrites here to firewall the control surface off the
 * public deployment). Renders the public brand chrome — there's no
 * scenario where a 404 needs the sidebar.
 */
export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--bg)] px-6 py-10 text-[var(--fg)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, rgba(255,122,69,0.16), transparent 70%)",
        }}
      />
      <div className="relative max-w-lg text-center">
        <div className="flex justify-center">
          <Logo size={36} />
        </div>
        <div className="mt-6 text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
          404 · not here
        </div>
        <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          That page doesn&apos;t exist.
        </h1>
        <p className="mt-3 text-pretty text-sm text-[var(--fg-muted)]">
          You may have followed a stale link, or this is part of the
          ClosedMesh control surface that only lives inside the desktop
          app — not on this public site.
        </p>
        <div className="mt-7 flex justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_24px_-12px_rgba(255,122,69,0.7)] transition hover:brightness-110"
          >
            Open chat
          </Link>
          <Link
            href="/download"
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-2.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-elev-2)]"
          >
            Download
          </Link>
        </div>
      </div>
    </div>
  );
}
