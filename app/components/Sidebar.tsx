"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { isPublicDeployment } from "../lib/runtime-target";
import { useMeshStatus } from "../lib/use-mesh-status";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Optional badge (e.g. node count). */
  badge?: (status: ReturnType<typeof useMeshStatus>) => string | null;
  /** If true, only show on the local controller (i.e. desktop app). */
  controlOnly?: boolean;
};

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: <IconDashboard />,
  },
  {
    href: "/models",
    label: "Models",
    icon: <IconModels />,
    badge: (s) => (s.models.length > 0 ? String(s.models.length) : null),
    controlOnly: true,
  },
  {
    href: "/nodes",
    label: "Mesh",
    icon: <IconMesh />,
    badge: (s) => (s.online ? String(s.nodeCount) : null),
    controlOnly: true,
  },
  {
    href: "/chat",
    label: "Chat",
    icon: <IconChat />,
  },
  {
    href: "/logs",
    label: "Activity",
    icon: <IconLogs />,
    controlOnly: true,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: <IconSettings />,
    controlOnly: true,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const status = useMeshStatus();
  const isPublic = isPublicDeployment();
  const items = NAV.filter((n) => !(isPublic && n.controlOnly));

  return (
    <aside className="hidden w-[220px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-elev)] sm:flex">
      <Link
        href="/"
        className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5"
      >
        <Logo />
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight text-[var(--fg)]">
            ClosedMesh
          </div>
          <div className="text-[10px] text-[var(--fg-muted)]">
            Private LLM mesh
          </div>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(item.href + "/");
            const badge = item.badge?.(status) ?? null;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={
                    "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition " +
                    (active
                      ? "bg-[var(--bg-elev-2)] text-[var(--fg)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)]")
                  }
                >
                  <span
                    className={
                      "shrink-0 " +
                      (active
                        ? "text-[var(--accent)]"
                        : "text-[var(--fg-muted)] group-hover:text-[var(--fg)]")
                    }
                  >
                    {item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {badge && (
                    <span
                      className={
                        "rounded px-1.5 py-0.5 font-mono text-[10px] " +
                        (active
                          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "bg-[var(--border)] text-[var(--fg-muted)]")
                      }
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <SidebarFooter status={status} />
    </aside>
  );
}

function SidebarFooter({
  status,
}: {
  status: ReturnType<typeof useMeshStatus>;
}) {
  const dot = status.online
    ? "bg-emerald-400"
    : status.loading
      ? "bg-zinc-500"
      : "bg-red-400";
  const label = status.loading
    ? "checking…"
    : status.online
      ? `${status.nodeCount} ${status.nodeCount === 1 ? "machine" : "machines"} online`
      : "Not running";
  return (
    <div className="border-t border-[var(--border)] px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={`relative inline-block h-1.5 w-1.5 rounded-full ${dot}`}
        >
          {status.online && (
            <span className="absolute inset-0 rounded-full bg-emerald-400 pulse-soft" />
          )}
        </span>
        <span className="font-medium text-[var(--fg)]">{label}</span>
      </div>
      {status.online && status.models[0] && (
        <div className="mt-1 truncate font-mono text-[10px] text-[var(--fg-muted)]">
          {status.models[0]}
        </div>
      )}
    </div>
  );
}

// ---------- Icons (16px) ----------------------------------------------

function IconDashboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconModels() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2L13.5 5v6L8 14 2.5 11V5L8 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M2.5 5L8 8l5.5-3M8 8v6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconMesh() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="3" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="13" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.3 4.2L7 11.5M11.7 4.2L9 11.5M4.5 3h7"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 3h10a1 1 0 011 1v6a1 1 0 01-1 1H7l-3 3v-3H3a1 1 0 01-1-1V4a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLogs() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="2.5"
        width="11"
        height="11"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5 6h6M5 8.5h6M5 11h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
