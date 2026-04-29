import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin Next.js's file-trace root to this directory (the repo root).
  // Without this, Next walks up looking for a workspace root and can
  // pull in unrelated files. With it, traces are bounded to the repo.
  outputFileTracingRoot: path.join(__dirname),
  // Belt + suspenders for the v0.1.12 macOS DMG regression: some control
  // routes (notably app/api/control/update-download/route.ts) use
  // dynamic spawn / path.join calls that trip Turbopack's NFT into
  // "trace the whole project" mode. When that fires, NFT slurps
  // everything under outputFileTracingRoot into .next/standalone/ —
  // including, on a CI machine with the cargo cache restored, the
  // 300+ MB desktop/target/ directory. These excludes make sure
  // build artefacts and other non-runtime trees never end up inside
  // the standalone bundle even if the trace overshoots.
  outputFileTracingExcludes: {
    "*": [
      "desktop/target/**",
      "desktop/sidecar/binaries/**",
      "desktop/sidecar/controller/**",
      "desktop/node_modules/**",
      "**/target/debug/**",
      "**/target/release/**",
      ".git/**",
      ".next/cache/**",
      "node_modules/.cache/**",
      "internal/**",
      "docs/**",
      "scripts/**",
      "**/*.dmg",
      "**/*.msi",
      "**/*.AppImage",
      "**/*.deb",
    ],
  },
  // Dev only: lets you load the dev server from origins other than
  // localhost (e.g. 127.0.0.1, the LAN IP) so you can sanity-test the
  // public-deployment cross-origin path without standing up a second
  // Next process. Has no effect on `next build` / `next start`.
  allowedDevOrigins: ["127.0.0.1", "192.168.0.0/16", "10.0.0.0/8"],
  async rewrites() {
    return [
      {
        source: "/install",
        destination: "/install.sh",
      },
    ];
  },
  async headers() {
    // Tell HTTP caches (including WKWebView in the desktop sidecar) to
    // *never* keep our control HTML around. Each release has new chunk
    // hashes, and a stale cached HTML pointing at /_next/static/chunks/<old hash>
    // 404s in the new bundle, breaking the page until the user manually
    // wipes the webview cache. Static assets under /_next/static/* are
    // content-addressed and stay immutable.
    const noStore = {
      key: "Cache-Control",
      value: "no-store, no-cache, must-revalidate, max-age=0",
    };
    const controlPaths = [
      "/dashboard",
      "/dashboard/:path*",
      "/models",
      "/models/:path*",
      "/nodes",
      "/nodes/:path*",
      "/chat",
      "/chat/:path*",
      "/logs",
      "/logs/:path*",
      "/settings",
      "/settings/:path*",
    ];
    return [
      {
        source: "/install.sh",
        headers: [
          { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
        ],
      },
      ...controlPaths.map((source) => ({ source, headers: [noStore] })),
    ];
  },
};

export default nextConfig;
