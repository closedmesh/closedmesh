#!/usr/bin/env bash
# desktop/scripts/build.sh — produce platform bundles from the Tauri shell.
#
# Outputs (depending on the host OS):
#   macOS:    src-tauri/target/release/bundle/{macos,dmg}/ClosedMesh.app + .dmg
#   Windows:  src-tauri/target/release/bundle/{msi,nsis}/ClosedMesh*.{msi,exe}
#   Linux:    src-tauri/target/release/bundle/{deb,appimage}/ClosedMesh*.{deb,AppImage}
#
# (We use the default Cargo target dir, not src-tauri/, but the bundle
#  layout is identical to a stock Tauri 2 project.)
#
# Usage:
#   ./scripts/build.sh              # full release build for the host OS
#   ./scripts/build.sh --debug      # debug profile, faster compile
#   ./scripts/build.sh --skip-icons # don't regenerate raster icons
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEBUG=0
SKIP_ICONS=0
for arg in "$@"; do
    case "$arg" in
        --debug)      DEBUG=1 ;;
        --skip-icons) SKIP_ICONS=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 1 ;;
    esac
done

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { color "0;36" "[desktop] $*"; }
ok()   { color "0;32" "[desktop] $*"; }

# 1. Make sure the Tauri CLI is available. We pin it to ^2 in package.json
#    so this is repeatable across machines / CI.
if [[ ! -d node_modules ]]; then
    info "Installing @tauri-apps/cli (one-time)…"
    npm install --no-fund --no-audit
fi

# 2. Regenerate raster icon variants from the SVG source-of-truth. The
#    Tauri CLI's `icon` subcommand handles every required output format —
#    .icns for macOS, .ico for Windows, multi-resolution PNGs for Linux,
#    plus the MS Store tile PNGs. Cheap (~2s); always do it unless the
#    caller explicitly skips.
if (( ! SKIP_ICONS )); then
    info "Rasterizing icons/source.svg → icons/source.png…"
    node scripts/svg-to-png.mjs >/dev/null

    info "Fanning out platform icon variants…"
    npx --no-install tauri icon icons/source.png --output icons >/dev/null
fi

# 3. Bundle. `tauri build` wraps `cargo build --release` and then runs the
#    bundlers for whichever platform we're on (cargo-bundle on macOS, WiX
#    on Windows, a couple of shell tools on Linux). With `--debug` we get
#    a debug-profile build skipped through the same bundler — much faster
#    iteration when working on tray/menu code.
if (( DEBUG )); then
    info "Bundling debug build (host OS)…"
    npx --no-install tauri build --debug
else
    info "Bundling release build (host OS)…"
    npx --no-install tauri build
fi

# 4. Surface the artifacts. The exact paths differ slightly per OS; we
#    just point the user at the bundle root and let them browse.
case "$(uname -s)" in
    Darwin)
        ART_DIR="$ROOT_DIR/target/release/bundle"
        if (( DEBUG )); then ART_DIR="$ROOT_DIR/target/debug/bundle"; fi
        ;;
    Linux)
        ART_DIR="$ROOT_DIR/target/release/bundle"
        if (( DEBUG )); then ART_DIR="$ROOT_DIR/target/debug/bundle"; fi
        ;;
    *)
        ART_DIR="$ROOT_DIR/target/release/bundle"
        ;;
esac

ok "Bundles written under: $ART_DIR"
ls "$ART_DIR" 2>/dev/null || true
