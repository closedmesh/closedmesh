#!/usr/bin/env bash
# desktop/scripts/stage-controller.sh — build the Next.js controller and
# stage it into desktop/sidecar/controller/ where Tauri can bundle it as
# an app resource.
#
# Output:
#     desktop/sidecar/controller/server.js
#     desktop/sidecar/controller/.next/...
#     desktop/sidecar/controller/public/...
#     desktop/sidecar/controller/node_modules/...   (Next.js standalone deps)
#
# What `next build` with `output: "standalone"` produces is a self-contained
# bundle: a single `server.js` plus the minimal `node_modules` it needs at
# runtime. We just have to add back `.next/static` and `public/` (which
# Next.js doesn't copy automatically — see the docs).
#
# Usage:
#     ./desktop/scripts/stage-controller.sh
#     ./desktop/scripts/stage-controller.sh --skip-build   # reuse existing .next/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
STAGE_DIR="$DESKTOP_DIR/sidecar/controller"

SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        -h|--help)
            sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "stage-controller: unknown flag: $arg" >&2; exit 1 ;;
    esac
done

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "0;36" "[stage-controller] $*"; }
ok()    { color "0;32" "[stage-controller] $*"; }
err()   { color "0;31" "[stage-controller] $*" >&2; }

cd "$REPO_ROOT"

if (( ! SKIP_BUILD )); then
    if [[ ! -d node_modules ]]; then
        info "Installing root dependencies (npm ci)…"
        if [[ -f package-lock.json ]]; then
            npm ci --no-audit --no-fund
        else
            npm install --no-audit --no-fund
        fi
    fi

    info "Building Next.js standalone bundle…"
    NEXT_TELEMETRY_DISABLED=1 npm run build
fi

if [[ ! -d ".next/standalone" ]]; then
    err ".next/standalone not found. Confirm next.config.ts has output: \"standalone\"."
    exit 1
fi
if [[ ! -f ".next/standalone/server.js" ]]; then
    err ".next/standalone/server.js missing — Next.js build did not produce a standalone bundle."
    exit 1
fi

info "Staging controller into ${STAGE_DIR}..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

cp -R .next/standalone/. "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/.next"
cp -R .next/static "$STAGE_DIR/.next/static"

if [[ -d public ]]; then
    cp -R public "$STAGE_DIR/public"
fi

if [[ ! -f "$STAGE_DIR/server.js" ]]; then
    err "Expected $STAGE_DIR/server.js after staging the standalone bundle."
    exit 1
fi

# Tauri's resource bundler chokes on absolute symlinks (it tries to
# canonicalize paths inside .app/Contents/Resources at runtime). The
# standalone bundle ships plain files, but be defensive in case Next.js
# starts emitting symlinks for shared chunks in a future version.
if find "$STAGE_DIR" -type l | grep -q .; then
    err "Found symlinks in $STAGE_DIR. Tauri resource bundling can't handle these."
    err "Files:"
    find "$STAGE_DIR" -type l
    exit 1
fi

bundle_size="$(du -sh "$STAGE_DIR" | awk '{print $1}')"
ok "Controller staged. Bundle size: $bundle_size"
