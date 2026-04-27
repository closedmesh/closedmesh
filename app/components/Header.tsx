import Link from "next/link";
import { Logo } from "./Logo";
import { StatusPill } from "./StatusPill";

export function Header({ onNewChat }: { onNewChat?: () => void }) {
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/60">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <Link
          href="/"
          className="flex items-center gap-2.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]/60"
        >
          <Logo />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ClosedMesh</div>
            <div className="text-[11px] text-[var(--fg-muted)]">
              Private LLM. Your team&apos;s hardware.
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/about"
            className="hidden rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--fg-muted)] hover:text-[var(--fg)] sm:inline-block"
          >
            How it works
          </Link>
          <Link
            href="/download"
            className="hidden rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)] sm:inline-block"
          >
            Download
          </Link>
          {onNewChat && (
            <button
              type="button"
              onClick={onNewChat}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)]"
              title="Start a new chat (clears the current thread from this tab)"
            >
              New chat
            </button>
          )}
          <StatusPill />
        </div>
      </div>
    </header>
  );
}
