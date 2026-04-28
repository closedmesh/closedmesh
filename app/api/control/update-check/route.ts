import { NextResponse } from "next/server";
import type {
  DesktopAssetKind,
  DesktopRelease,
} from "../../../api/desktop-release/route";
import { isPublic } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * In-app updater check.
 *
 * Reads the running app's version + host OS/arch from env vars set by
 * the Tauri shell when it spawned this controller (`CLOSEDMESH_APP_VERSION`,
 * `CLOSEDMESH_HOST_OS`, `CLOSEDMESH_HOST_ARCH`). Fetches the latest
 * release info from the public website's `/api/desktop-release` (which
 * is itself a 5-min ISR cache over the GitHub Releases API), compares
 * versions, and surfaces the right asset for this host.
 *
 * The dashboard polls this on mount + once an hour. Hitting the local
 * controller (rather than `closedmesh.com/api/desktop-release` directly
 * from the browser) keeps everything same-origin and lets us layer on
 * environment-aware logic (e.g. respecting `CLOSEDMESH_UPDATE_CHANNEL`
 * once we ship beta/canary streams).
 */

type UpdateAsset = {
  kind: DesktopAssetKind;
  name: string;
  size: number;
  /** Direct .dmg / .msi / .AppImage URL on GitHub Releases. */
  url: string;
};

type UpdateCheckResp =
  | {
      ok: true;
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      publishedAt: string;
      htmlUrl: string;
      /** Best-match installer for this host, when one exists. */
      asset: UpdateAsset | null;
      hostOs: string;
      hostArch: string;
    }
  | {
      ok: false;
      message: string;
      currentVersion: string;
    };

const RELEASE_API_URL =
  process.env.CLOSEDMESH_RELEASE_API_URL ??
  "https://closedmesh.com/api/desktop-release";

export async function GET() {
  const currentVersion = (process.env.CLOSEDMESH_APP_VERSION ?? "").trim();
  const hostOs = (process.env.CLOSEDMESH_HOST_OS ?? "").trim();
  const hostArch = (process.env.CLOSEDMESH_HOST_ARCH ?? "").trim();

  if (isPublic) {
    return NextResponse.json<UpdateCheckResp>(
      {
        ok: false,
        message: "Update checks aren't available on the hosted public site.",
        currentVersion,
      },
      { status: 200 },
    );
  }

  if (!currentVersion) {
    // Running outside the Tauri shell (dev `next dev` etc). Surface a
    // friendly response instead of pretending an update exists.
    return NextResponse.json<UpdateCheckResp>(
      {
        ok: false,
        message:
          "Can't determine the running app version. Update checks only work inside the desktop app.",
        currentVersion,
      },
      { status: 200 },
    );
  }

  let release: DesktopRelease;
  try {
    const res = await fetch(RELEASE_API_URL, {
      // Bypass any CDN caches — we want fresh release info on demand,
      // and the upstream API does its own 5-min ISR.
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return NextResponse.json<UpdateCheckResp>({
        ok: false,
        message: `Release API returned ${res.status}.`,
        currentVersion,
      });
    }
    const body = (await res.json()) as DesktopRelease | { error: string };
    if ("error" in body) {
      return NextResponse.json<UpdateCheckResp>({
        ok: false,
        message: `Release API: ${body.error}.`,
        currentVersion,
      });
    }
    release = body;
  } catch (err) {
    return NextResponse.json<UpdateCheckResp>({
      ok: false,
      message:
        err instanceof Error
          ? `Couldn't reach the release API: ${err.message}`
          : "Couldn't reach the release API.",
      currentVersion,
    });
  }

  const updateAvailable = compareSemver(release.version, currentVersion) > 0;
  const asset = pickAssetForHost(release, hostOs, hostArch);

  return NextResponse.json<UpdateCheckResp>({
    ok: true,
    currentVersion,
    latestVersion: release.version,
    updateAvailable,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl,
    asset,
    hostOs,
    hostArch,
  });
}

/**
 * Three-way semver compare: returns 1 if `a > b`, -1 if `a < b`, 0 if
 * equal. Tolerates `0.1.7` vs `0.1.7-beta.1` style suffixes by stripping
 * everything after the first non-digit/non-dot in each segment — good
 * enough for our "is the published version newer?" question without
 * pulling in a dependency.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split(".")
      .slice(0, 3)
      .map((s) => parseInt(s.replace(/[^0-9].*/, ""), 10) || 0);
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const av = A[i] ?? 0;
    const bv = B[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/**
 * Pick the best-matching installer for the running host. For macOS we
 * map arm64 to the aarch64 .dmg (we don't currently ship an x64 mac
 * build, so Intel macs see no asset and the UI falls back to "open
 * release page on GitHub"). For Windows we prefer the .exe NSIS-style
 * installer over the .msi when both exist — the .exe is smaller and
 * works without admin rights on most setups. Linux gets the .AppImage
 * because it's distro-agnostic; .deb is a less-common second choice.
 */
function pickAssetForHost(
  release: DesktopRelease,
  os: string,
  arch: string,
): UpdateAsset | null {
  const order: DesktopAssetKind[] = [];
  if (os === "macos") {
    if (arch === "aarch64" || arch === "arm64") order.push("macos-arm64");
    else order.push("macos-intel", "macos-arm64");
  } else if (os === "windows") {
    order.push("windows-exe", "windows-msi");
  } else if (os === "linux") {
    order.push("linux-appimage", "linux-deb");
  }
  for (const kind of order) {
    const a = release.assets[kind];
    if (a) {
      return { kind: a.kind, name: a.name, size: a.size, url: a.url };
    }
  }
  return null;
}
