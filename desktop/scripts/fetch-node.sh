#!/usr/bin/env bash
# desktop/scripts/fetch-node.sh — download the official Node.js binary for
# the host (or an explicit Tauri target triple) and stage it under
# desktop/sidecar/binaries/ with the platform-suffixed filename Tauri's
# `bundle.externalBin` expects.
#
# Output:
#     desktop/sidecar/binaries/node-<target-triple>          (executable)
#     desktop/sidecar/binaries/node-<target-triple>.exe      (Windows)
#
# Usage:
#     ./desktop/scripts/fetch-node.sh                        # host platform
#     ./desktop/scripts/fetch-node.sh --target aarch64-apple-darwin
#
# Why fetch instead of vendor: a 28MB binary per platform × 5 platforms in
# git is wasteful, and we'd need to re-vendor on every Node LTS bump. CI
# fetches per-target inside each matrix job; local builds fetch once and
# cache.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$DESKTOP_DIR/sidecar/binaries"

# Pin to a specific Node LTS release so the .app behaves identically across
# CI runs and local dev. Bump this deliberately; don't drift.
NODE_VERSION="v22.11.0"

TARGET=""
for arg in "$@"; do
    case "$arg" in
        --target)         shift; TARGET="$1"; shift ;;
        --target=*)       TARGET="${arg#--target=}" ;;
        -h|--help)
            sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
    esac
done

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "0;36" "[fetch-node] $*"; }
ok()    { color "0;32" "[fetch-node] $*"; }
err()   { color "0;31" "[fetch-node] $*" >&2; }

# Detect the host's Tauri-style target triple if --target wasn't passed.
detect_host_target() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch="x86_64" ;;
        arm64|aarch64) arch="aarch64" ;;
    esac
    case "$os/$arch" in
        Darwin/aarch64) echo "aarch64-apple-darwin" ;;
        Darwin/x86_64)  echo "x86_64-apple-darwin" ;;
        Linux/x86_64)   echo "x86_64-unknown-linux-gnu" ;;
        Linux/aarch64)  echo "aarch64-unknown-linux-gnu" ;;
        # On Git Bash / MSYS we get MINGW*; CI is the only place that hits the
        # Windows triple in practice and it'll always pass --target there.
        *) err "could not detect host target ($os/$arch); pass --target explicitly"; exit 1 ;;
    esac
}

if [[ -z "$TARGET" ]]; then
    TARGET="$(detect_host_target)"
fi

# Map Tauri target → Node.js release asset suffix.
case "$TARGET" in
    aarch64-apple-darwin)        NODE_SUFFIX="darwin-arm64";  NODE_EXT="tar.gz"; OUT_EXT="" ;;
    x86_64-apple-darwin)         NODE_SUFFIX="darwin-x64";    NODE_EXT="tar.gz"; OUT_EXT="" ;;
    x86_64-unknown-linux-gnu)    NODE_SUFFIX="linux-x64";     NODE_EXT="tar.xz"; OUT_EXT="" ;;
    aarch64-unknown-linux-gnu)   NODE_SUFFIX="linux-arm64";   NODE_EXT="tar.xz"; OUT_EXT="" ;;
    x86_64-pc-windows-msvc)      NODE_SUFFIX="win-x64";       NODE_EXT="zip";    OUT_EXT=".exe" ;;
    *) err "unsupported target: $TARGET"; exit 1 ;;
esac

OUT_PATH="$BIN_DIR/node-${TARGET}${OUT_EXT}"

if [[ -x "$OUT_PATH" || -f "$OUT_PATH" ]]; then
    # Skip re-fetch if the target file already exists. Bumping NODE_VERSION
    # invalidates the cache by changing what the asset name *would* be — but
    # we don't track version-in-filename, so callers should `rm -rf
    # sidecar/binaries` after a Node bump. Cheap to be explicit.
    info "$OUT_PATH already present — skipping download."
    info "(rm desktop/sidecar/binaries to re-fetch.)"
    exit 0
fi

mkdir -p "$BIN_DIR"

archive_name="node-${NODE_VERSION}-${NODE_SUFFIX}.${NODE_EXT}"
url="https://nodejs.org/dist/${NODE_VERSION}/${archive_name}"
tmpdir="$(mktemp -d)"
trap "rm -rf '$tmpdir'" EXIT

info "Downloading $archive_name from nodejs.org…"
if ! curl -fsSL --retry 3 "$url" -o "$tmpdir/$archive_name"; then
    err "failed to download $url"
    exit 1
fi

info "Extracting…"
case "$NODE_EXT" in
    tar.gz) tar -xzf "$tmpdir/$archive_name" -C "$tmpdir" ;;
    tar.xz)
        if command -v xz >/dev/null 2>&1; then
            tar -xJf "$tmpdir/$archive_name" -C "$tmpdir"
        else
            err "xz not installed; can't extract Linux Node tarball"
            exit 1
        fi
        ;;
    zip)
        if ! command -v unzip >/dev/null 2>&1; then
            err "unzip not installed; can't extract Windows Node zip"
            exit 1
        fi
        unzip -q "$tmpdir/$archive_name" -d "$tmpdir"
        ;;
esac

extracted_dir="$tmpdir/node-${NODE_VERSION}-${NODE_SUFFIX}"
if [[ ! -d "$extracted_dir" ]]; then
    err "expected $extracted_dir to exist after extraction"
    exit 1
fi

if [[ -n "$OUT_EXT" ]]; then
    src="$extracted_dir/node.exe"
else
    src="$extracted_dir/bin/node"
fi

if [[ ! -f "$src" ]]; then
    err "Node binary not found at $src"
    exit 1
fi

install -m 0755 "$src" "$OUT_PATH"
ok "Node $NODE_VERSION installed at $OUT_PATH"
