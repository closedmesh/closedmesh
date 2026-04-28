import { NextResponse } from "next/server";

// Render this as a regular Next route, not a static asset, so the
// `revalidate` setting actually controls cache freshness.
export const runtime = "nodejs";

// Refresh once every 5 minutes. Releases happen rarely (a couple of times a
// month at most) and the GitHub API is rate-limited per IP for unauthenticated
// callers; an aggressive cache keeps the /download page snappy and stays well
// inside the 60-req/hour anonymous budget even under heavy traffic.
export const revalidate = 300;

const REPO =
  process.env.CLOSEDMESH_DESKTOP_REPO ?? "closedmesh/closedmesh";

// All Tauri release tags for the desktop app are prefixed with `desktop-v`
// (so they don't collide with future runtime / web tags). The user-facing
// version we surface in UI strips the prefix.
const TAG_PREFIX = "desktop-v";

export type DesktopAsset = {
  /** File name as it appears on the release, e.g. `ClosedMesh_0.1.0_aarch64.dmg`. */
  name: string;
  /** Direct download URL (browser_download_url from the GitHub API). */
  url: string;
  /** Bytes — useful for the "Download · 5.4 MB" label. */
  size: number;
  /** "macos-arm64" | "macos-intel" | "windows-exe" | "windows-msi" | "linux-deb" | "linux-appimage". */
  kind: DesktopAssetKind;
};

export type DesktopAssetKind =
  | "macos-arm64"
  | "macos-intel"
  | "windows-exe"
  | "windows-msi"
  | "linux-deb"
  | "linux-appimage";

export type DesktopRelease = {
  /** "0.1.0" — the tag with the `desktop-v` prefix removed. */
  version: string;
  /** GitHub release page; fallback link when no platform-specific asset matches. */
  htmlUrl: string;
  /** ISO-8601 publish timestamp for "released 3 days ago" labels. */
  publishedAt: string;
  /** All bundles, keyed by platform variant. Missing entries mean that platform's bundle wasn't built (or hasn't uploaded yet). */
  assets: Partial<Record<DesktopAssetKind, DesktopAsset>>;
};

type GitHubAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GitHubRelease = {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
};

/**
 * Map a release-asset filename to a `DesktopAssetKind`. Filenames come from
 * Tauri's bundler so they're stable: the recognised patterns are documented
 * inline. Anything unrecognised (source tarballs, latest.json, etc.) returns
 * null and is skipped.
 */
function classifyAsset(name: string): DesktopAssetKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".dmg")) {
    if (lower.includes("aarch64") || lower.includes("arm64")) {
      return "macos-arm64";
    }
    if (lower.includes("x64") || lower.includes("x86_64")) {
      return "macos-intel";
    }
    return "macos-arm64";
  }
  if (lower.endsWith(".msi")) return "windows-msi";
  if (lower.endsWith("-setup.exe") || lower.endsWith(".exe")) {
    return "windows-exe";
  }
  if (lower.endsWith(".deb")) return "linux-deb";
  if (lower.endsWith(".appimage")) return "linux-appimage";
  return null;
}

async function fetchLatestRelease(): Promise<DesktopRelease | null> {
  // Prefer `releases/latest` (which respects "Set as latest release" in the
  // GitHub UI and skips drafts/prereleases for us), but fall back to listing
  // all releases and picking the newest non-draft `desktop-v*` so a half-set
  // of platform bundles still surfaces in the UI while CI is mid-flight on
  // the others.
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "closedmesh-website",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.CLOSEDMESH_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  // Step 1 — try /releases/latest.
  const latest = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers, next: { revalidate } },
  );
  let release: GitHubRelease | null = null;
  if (latest.ok) {
    const candidate = (await latest.json()) as GitHubRelease;
    if (candidate.tag_name?.startsWith(TAG_PREFIX)) {
      release = candidate;
    }
  }

  // Step 2 — `latest` returned a non-desktop tag (or 404 because the repo
  // has no published releases yet); list everything and pick the newest
  // matching tag.
  if (!release) {
    const list = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=20`,
      { headers, next: { revalidate } },
    );
    if (!list.ok) return null;
    const all = (await list.json()) as GitHubRelease[];
    release =
      all.find(
        (r) =>
          !r.draft && !r.prerelease && r.tag_name.startsWith(TAG_PREFIX),
      ) ?? null;
  }
  if (!release) return null;

  const assets: DesktopRelease["assets"] = {};
  for (const a of release.assets) {
    const kind = classifyAsset(a.name);
    if (!kind) continue;
    // First match wins per kind. The release should never have two assets of
    // the same kind, but if it does (e.g. macOS arm64 .dmg uploaded twice
    // because of a re-run), this gives us a deterministic outcome.
    if (assets[kind]) continue;
    assets[kind] = {
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
      kind,
    };
  }

  return {
    version: release.tag_name.slice(TAG_PREFIX.length),
    htmlUrl: release.html_url,
    publishedAt: release.published_at,
    assets,
  };
}

export async function GET() {
  try {
    const release = await fetchLatestRelease();
    if (!release) {
      return NextResponse.json(
        { error: "no-release" },
        {
          status: 200,
          headers: { "cache-control": "public, max-age=60" },
        },
      );
    }
    return NextResponse.json(release, {
      headers: {
        // The Next runtime caches via ISR (`revalidate = 300`), but we also
        // emit an explicit Cache-Control so any CDN in front of the site
        // (Cloudflare etc.) honours the same TTL.
        "cache-control": "public, max-age=300, s-maxage=300",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "fetch-failed" },
      {
        status: 200,
        headers: { "cache-control": "public, max-age=60" },
      },
    );
  }
}
