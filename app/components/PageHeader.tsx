import { StatusPill } from "./StatusPill";

/**
 * Sticky page header used across every sidebar-shell route.
 *
 * Visual rules (kept consistent so the app feels of-a-piece):
 *   - Subtle orange ambient glow at the top of each page, fading out at
 *     ~120px. Echoes the first-run hero without being loud.
 *   - Title in regular weight + tighter tracking; subtitle is muted.
 *   - Actions slot on the right defaults to <StatusPill /> when nothing
 *     is passed; this is what most pages want.
 *   - Optional `eyebrow` for a small uppercase label above the title.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(255,122,69,0.10), transparent 70%)",
        }}
      />
      <div className="relative flex items-center justify-between gap-4 px-6 py-3.5">
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
              {eyebrow}
            </div>
          )}
          <div className="truncate text-base font-semibold tracking-tight text-[var(--fg)]">
            {title}
          </div>
          {subtitle && (
            <div className="truncate text-[12px] text-[var(--fg-muted)]">
              {subtitle}
            </div>
          )}
        </div>
        <div className="shrink-0">{actions ?? <StatusPill />}</div>
      </div>
    </header>
  );
}
