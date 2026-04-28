// Rasterize icons/source.svg -> all the PNG/ICO/ICNS variants the project
// needs, from one source of truth. Two consumers:
//
//   1. Tauri's `tauri icon` CLI (run right after this script via `npm run
//      icons`) only accepts PNG input, so we emit `icons/source.png` at
//      1024x1024 for it to fan out into per-platform variants.
//
//   2. The Next.js website needs its own favicon / apple-touch-icon /
//      generic PNG set. Those live in the web tree (`app/` and `public/`)
//      and are committed to git so Vercel can serve them without a build
//      step. We emit those here too — same SVG, one rebrand point.
//
// We use @resvg/resvg-js (pure-Rust, zero native compilation) so this works
// the same on macOS, Linux, and Windows CI.
//
// Note: ICO output for the web favicon is produced by `tauri icon` (it
// generates a multi-resolution `icons/icon.ico`); the surrounding
// `npm run icons` script copies that file into `app/favicon.ico`.

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");

const inputPath = resolve(desktopRoot, "icons/source.svg");

// `@resvg/resvg-js` accepts either a `string` or a `Uint8Array`; reading
// as utf8 keeps the type unambiguous and avoids `provided data has not an
// UTF-8 encoding` from the Buffer path on some Node versions.
const svg = readFileSync(inputPath, "utf8");

function rasterize(size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

function emit(size, outPath) {
  const png = rasterize(size);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${size}x${size}, ${png.length.toLocaleString()} bytes)`);
}

// 1024x1024 master for `tauri icon` to fan out into all the per-platform
// sizes the desktop bundlers need.
emit(1024, resolve(desktopRoot, "icons/source.png"));

// Web targets. Next.js' filesystem-based icon convention auto-mounts
// `app/icon.svg` as `<link rel="icon" type="image/svg+xml">` and
// `app/apple-icon.png` as `<link rel="apple-touch-icon">`, so dropping
// the files in those exact paths is enough — no `metadata.icons` wiring
// needed. The `public/icon-*.png` variants are referenced explicitly
// from layout.tsx for OpenGraph / PWA-style use cases.
copyFileSync(inputPath, resolve(repoRoot, "app/icon.svg"));
console.log(`copied ${inputPath} -> app/icon.svg`);

emit(180, resolve(repoRoot, "app/apple-icon.png"));
emit(192, resolve(repoRoot, "public/icon-192.png"));
emit(512, resolve(repoRoot, "public/icon-512.png"));
