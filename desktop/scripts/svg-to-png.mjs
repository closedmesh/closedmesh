// Rasterize icons/source.svg → icons/source.png at 1024×1024.
//
// Tauri's `tauri icon` CLI only accepts PNG input, but the design source
// of truth is the SVG (so the icon stays in sync with app/components/Logo.tsx
// and the website favicon). We bridge the two with a single ~30-line Node
// script using @resvg/resvg-js, which is a pure-Rust SVG renderer — zero
// native compilation, works the same on macOS, Linux, and Windows CI.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const inputPath = resolve(root, "icons/source.svg");
const outputPath = resolve(root, "icons/source.png");

// `@resvg/resvg-js` accepts either a `string` or a `Uint8Array`; reading
// as utf8 keeps the type unambiguous and avoids `provided data has not an
// UTF-8 encoding` from the Buffer path on some Node versions.
const svg = readFileSync(inputPath, "utf8");

const resvg = new Resvg(svg, {
  // 1024×1024 is what `tauri icon` wants for source assets — it then fans
  // out to every smaller size required by the platform bundlers.
  fitTo: { mode: "width", value: 1024 },
  background: "rgba(0,0,0,0)",
  font: { loadSystemFonts: false },
});

const png = resvg.render().asPng();
writeFileSync(outputPath, png);

console.log(`wrote ${outputPath} (${png.length.toLocaleString()} bytes)`);
