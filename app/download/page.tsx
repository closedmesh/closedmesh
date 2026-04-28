import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Logo } from "../components/Logo";
import type {
  DesktopAsset,
  DesktopAssetKind,
  DesktopRelease,
} from "../api/desktop-release/route";

export const metadata: Metadata = {
  title: "Download ClosedMesh",
  description:
    "Download the ClosedMesh desktop app — a tiny native shell around your private LLM mesh. Available for macOS, Windows, and Linux.",
};

// Re-render on the same cadence as the release API so freshly-published
// versions show up within ~5 minutes without a manual deploy.
export const revalidate = 300;

type Platform =
  | "macos-arm64"
  | "macos-intel"
  | "windows"
  | "linux"
  | "unknown";

/**
 * Sniff the visitor's OS + CPU arch from the User-Agent. Server-side so the
 * page renders the right "primary" download button on first paint — no
 * client-side flicker between three giant buttons.
 *
 * UA strings are noisy; we err on the side of "show all four buttons" when
 * the signal is ambiguous (the `unknown` branch hides the spotlight but
 * keeps every download visible below).
 */
function detectPlatform(ua: string): Platform {
  const s = ua.toLowerCase();
  if (s.includes("mac os x") || s.includes("macintosh")) {
    // Apple ships Intel Safari UA strings on Apple Silicon for compat, so we
    // can't tell arm64 vs Intel from UA alone. We default to arm64 because
    // the entire current Mac lineup (M1+) is arm64 and Intel Macs are a
    // shrinking long tail; the page surfaces the Intel build one click away.
    return "macos-arm64";
  }
  if (s.includes("windows")) return "windows";
  if (s.includes("linux") && !s.includes("android")) return "linux";
  return "unknown";
}

async function getRelease(): Promise<DesktopRelease | null> {
  // Same-origin fetch into our own API route. Going through the route
  // (rather than calling GitHub directly here) means the page and any
  // future client-side code share one cached copy of the release info.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "";
  try {
    const res = await fetch(`${base}/api/desktop-release`, {
      next: { revalidate },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as DesktopRelease | { error: string };
    if ("error" in data) return null;
    return data;
  } catch {
    return null;
  }
}

export default async function DownloadPage() {
  const h = await headers();
  const ua = h.get("user-agent") ?? "";
  const platform = detectPlatform(ua);
  const release = await getRelease();

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">
                ClosedMesh
              </div>
              <div className="text-[11px] text-[var(--fg-muted)]">
                Private LLM. Your team&apos;s hardware.
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-5 text-[12px]">
            <Link
              href="/about"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              How it works
            </Link>
            <Link
              href="/"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Open chat →
            </Link>
          </div>
        </div>
      </header>

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
          <div className="flex flex-col items-start gap-7">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-3">
              <Logo size={42} />
            </div>
            <div className="max-w-3xl">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
                Desktop app
              </div>
              <h1 className="mt-3 text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
                Download ClosedMesh.
              </h1>
              <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[var(--fg-muted)] sm:text-lg">
                A tiny native shell around the chat UI, with a system-tray
                pill that shows live node count and one-click Start /
                Stop for the runtime. Same private-mesh inference,
                without keeping a browser tab open.
              </p>
            </div>

            <ReleaseHero release={release} platform={platform} />
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              All platforms
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Pick your bundle.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              One Tauri 2 codebase, three native bundles. The runtime
              (<code className="font-mono text-[12px]">closedmesh</code>{" "}
              CLI) installs separately — see{" "}
              <Link href="/" className="text-[var(--accent)] hover:underline">
                the home page
              </Link>{" "}
              for the curl / PowerShell one-liner.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <PlatformCard
              title="macOS · Apple Silicon"
              subtitle="M1, M2, M3, M4 Macs"
              ext=".dmg"
              asset={release?.assets["macos-arm64"]}
            />
            <PlatformCard
              title="macOS · Intel"
              subtitle="Pre-2021 Intel Macs"
              ext=".dmg"
              asset={release?.assets["macos-intel"]}
            />
            <PlatformCard
              title="Windows 10 / 11"
              subtitle="x86_64 installer"
              ext=".exe"
              asset={
                release?.assets["windows-exe"] ??
                release?.assets["windows-msi"]
              }
              secondary={
                release?.assets["windows-exe"] &&
                release?.assets["windows-msi"]
                  ? {
                      label: "Need an MSI?",
                      asset: release.assets["windows-msi"],
                    }
                  : undefined
              }
            />
            <PlatformCard
              title="Linux · Debian / Ubuntu"
              subtitle="x86_64 .deb package"
              ext=".deb"
              asset={release?.assets["linux-deb"]}
            />
            <PlatformCard
              title="Linux · everything else"
              subtitle="x86_64 portable AppImage"
              ext=".AppImage"
              asset={release?.assets["linux-appimage"]}
            />
            <SourceCard release={release} />
          </div>

          {!release && (
            <div className="mt-8 rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6 text-[13px] text-[var(--fg-muted)]">
              The first desktop release hasn&apos;t been published yet.
              In the meantime you can build the app yourself —{" "}
              <code className="font-mono text-[12px]">
                cd desktop && npm install && ./scripts/build.sh
              </code>{" "}
              — or join the mesh from your browser at{" "}
              <Link href="/" className="text-[var(--accent)] hover:underline">
                closedmesh.com
              </Link>
              .
            </div>
          )}
        </div>
      </section>

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              First launch
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Heads-up on the &quot;unidentified developer&quot; warning.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              ClosedMesh Desktop isn&apos;t code-signed yet, so macOS
              Gatekeeper and Windows SmartScreen will both ask if you
              really want to run it the first time. Here&apos;s the
              30-second workaround for each platform.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <FirstLaunchCard
              os="macOS"
              steps={[
                "Open the .dmg and drag ClosedMesh into Applications.",
                'Double-click ClosedMesh. macOS will block it once with an "unidentified developer" dialog — click "Done".',
                'Open System Settings → Privacy & Security, scroll to the "ClosedMesh was blocked" notice, and click "Open Anyway". Confirm with Touch ID / password. Future launches are normal double-clicks.',
              ]}
            />
            <FirstLaunchCard
              os="Windows"
              steps={[
                "Run the .exe installer.",
                'When SmartScreen says "Windows protected your PC", click "More info".',
                'Click "Run anyway" → finish the installer.',
              ]}
            />
            <FirstLaunchCard
              os="Linux"
              steps={[
                ".deb: sudo dpkg -i closedmesh_*_amd64.deb",
                ".AppImage: chmod +x closedmesh_*_amd64.AppImage && ./closedmesh_*.AppImage",
                "Tray icon needs libayatana-appindicator on Wayland desktops.",
              ]}
            />
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Don&apos;t want a desktop app?
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              The mesh runs fine without it.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              The desktop app is purely a convenience wrapper. The chat UI
              works in any browser, and the runtime CLI is what actually
              joins the mesh. Pick whichever path suits the user:
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
              <div className="text-sm font-semibold tracking-tight">
                Browser only
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
                Open{" "}
                <Link
                  href="/"
                  className="text-[var(--accent)] hover:underline"
                >
                  closedmesh.com
                </Link>
                . The page calls back to your local runtime — chats stay on
                your machine even though the page is hosted publicly.
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
              <div className="text-sm font-semibold tracking-tight">
                CLI runtime
              </div>
              <pre className="mt-3 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[12px] leading-snug text-[var(--fg)]">
                {`# macOS / Linux
curl -fsSL https://closedmesh.com/install | sh

# Windows (PowerShell)
iwr https://closedmesh.com/install.ps1 | iex`}
              </pre>
              <p className="mt-3 text-[12px] text-[var(--fg-muted)]">
                Drops the runtime into{" "}
                <code className="font-mono">~/.local/bin</code> (or{" "}
                <code className="font-mono">%LOCALAPPDATA%</code> on
                Windows) and registers an autostart service.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--border)]">
        <div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="text-[12px] text-[var(--fg-muted)]">
              ClosedMesh — private LLM, your team&apos;s hardware.
            </div>
          </div>
          <div className="flex items-center gap-5 text-[12px]">
            <Link
              href="/"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Open chat
            </Link>
            <Link
              href="/about"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              How it works
            </Link>
            <a
              href="https://github.com/closedmesh/closedmesh-llm"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Runtime on GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ReleaseHero({
  release,
  platform,
}: {
  release: DesktopRelease | null;
  platform: Platform;
}) {
  const primary = pickPrimaryAsset(release, platform);

  if (!release || !primary) {
    return (
      <div className="flex w-full flex-wrap items-center gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-3 text-[13px] text-[var(--fg-muted)]">
          No published bundle yet — see &quot;All platforms&quot; below
          for build-from-source instructions.
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <a
          href={primary.asset.url}
          className="inline-flex items-center gap-3 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-6 py-4 text-sm font-semibold text-[var(--fg)] transition hover:border-[var(--accent)] hover:bg-[var(--accent)]/20"
        >
          <DownloadGlyph />
          <span className="leading-tight">
            <span className="block">Download for {primary.label}</span>
            <span className="block text-[11px] font-normal text-[var(--fg-muted)]">
              v{release.version} · {formatBytes(primary.asset.size)} ·{" "}
              {primary.asset.name.split(".").pop()?.toUpperCase()}
            </span>
          </span>
        </a>
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Release notes →
        </a>
      </div>
      <div className="text-[12px] text-[var(--fg-muted)]">
        Released {formatRelative(release.publishedAt)} · auto-detected{" "}
        {platformLabel(platform)} · all platforms below.
      </div>
    </div>
  );
}

function PlatformCard({
  title,
  subtitle,
  ext,
  asset,
  secondary,
}: {
  title: string;
  subtitle: string;
  ext: string;
  asset: DesktopAsset | undefined;
  secondary?: { label: string; asset: DesktopAsset };
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div className="text-sm font-semibold tracking-tight">{title}</div>
      <div className="mt-1 text-[12px] text-[var(--fg-muted)]">{subtitle}</div>
      <div className="mt-5 flex-1" />
      {asset ? (
        <a
          href={asset.url}
          className="inline-flex items-center justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] font-medium text-[var(--fg)] hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/5"
        >
          <span className="font-mono text-[11px] text-[var(--fg-muted)]">
            {ext}
          </span>
          <span>Download</span>
          <span className="font-mono text-[11px] text-[var(--fg-muted)]">
            {formatBytes(asset.size)}
          </span>
        </a>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--border)] bg-transparent px-3 py-2 text-[12px] text-[var(--fg-muted)]">
          Not yet published
        </div>
      )}
      {secondary && (
        <a
          href={secondary.asset.url}
          className="mt-2 text-center text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
        >
          {secondary.label} ({secondary.asset.name.split(".").pop()},{" "}
          {formatBytes(secondary.asset.size)})
        </a>
      )}
    </div>
  );
}

function SourceCard({ release }: { release: DesktopRelease | null }) {
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div className="text-sm font-semibold tracking-tight">
        Build from source
      </div>
      <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
        Tauri 2 · Rust + system webview
      </div>
      <pre className="mt-4 flex-1 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[11px] leading-snug text-[var(--fg)]">
        {`git clone https://github.com/closedmesh/closedmesh
cd closedmesh/desktop
npm install
./scripts/build.sh`}
      </pre>
      {release && (
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 text-center text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
        >
          See all v{release.version} assets on GitHub →
        </a>
      )}
    </div>
  );
}

function FirstLaunchCard({ os, steps }: { os: string; steps: string[] }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
        {os}
      </div>
      <ol className="mt-4 flex flex-col gap-3 text-[13px] leading-relaxed text-[var(--fg)]/90">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-3">
            <span className="font-mono text-[11px] text-[var(--fg-muted)]">
              0{i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DownloadGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function pickPrimaryAsset(
  release: DesktopRelease | null,
  platform: Platform,
): { asset: DesktopAsset; label: string } | null {
  if (!release) return null;
  const a = release.assets;
  switch (platform) {
    case "macos-arm64":
      if (a["macos-arm64"]) return { asset: a["macos-arm64"], label: "macOS (Apple Silicon)" };
      if (a["macos-intel"]) return { asset: a["macos-intel"], label: "macOS (Intel)" };
      return null;
    case "macos-intel":
      if (a["macos-intel"]) return { asset: a["macos-intel"], label: "macOS (Intel)" };
      if (a["macos-arm64"]) return { asset: a["macos-arm64"], label: "macOS (Apple Silicon)" };
      return null;
    case "windows":
      if (a["windows-exe"]) return { asset: a["windows-exe"], label: "Windows" };
      if (a["windows-msi"]) return { asset: a["windows-msi"], label: "Windows (MSI)" };
      return null;
    case "linux":
      if (a["linux-appimage"]) return { asset: a["linux-appimage"], label: "Linux (AppImage)" };
      if (a["linux-deb"]) return { asset: a["linux-deb"], label: "Linux (.deb)" };
      return null;
    case "unknown":
      return (
        (a["macos-arm64"] && { asset: a["macos-arm64"], label: "macOS (Apple Silicon)" }) ||
        (a["windows-exe"] && { asset: a["windows-exe"], label: "Windows" }) ||
        (a["linux-appimage"] && { asset: a["linux-appimage"], label: "Linux" }) ||
        null
      );
  }
}

function platformLabel(p: Platform): string {
  switch (p) {
    case "macos-arm64":
      return "macOS (Apple Silicon)";
    case "macos-intel":
      return "macOS (Intel)";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "unknown":
      return "platform";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const now = Date.now();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "moments ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

// Pinned const: `pickPrimaryAsset` is exhaustive over `Platform`, so the
// `Platform` type and the switch should be edited in lock-step. The
// no-default-case lint surfaces any missed branch.
//
// Keep this assertion at the bottom of the file so it survives refactors:
const _exhaustive: Platform[] = [
  "macos-arm64",
  "macos-intel",
  "windows",
  "linux",
  "unknown",
];
void _exhaustive;
