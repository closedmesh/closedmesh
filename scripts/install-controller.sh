#!/usr/bin/env bash
# scripts/install-controller.sh — install the ClosedMesh Next.js controller as
# a launchd service that auto-starts on login.
#
# What this does:
#   1. Builds a self-contained Next.js bundle (next build with output=standalone).
#   2. Copies the bundle into ~/.closedmesh/controller/.
#   3. Writes ~/Library/LaunchAgents/dev.closedmesh.controller.plist.
#   4. Bootstraps the launchd service so the chat UI + /control panel are
#      available at http://localhost:3000 every time you log in.
#
# Uninstall:
#   launchctl bootout gui/$(id -u)/dev.closedmesh.controller
#   rm -rf ~/.closedmesh/controller \
#          ~/Library/LaunchAgents/dev.closedmesh.controller.plist \
#          ~/Library/Logs/closedmesh/controller.{stdout,stderr}.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LABEL="dev.closedmesh.controller"
TARGET_DIR="$HOME/.closedmesh/controller"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCHD_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/closedmesh"
PORT="${CLOSEDMESH_CONTROLLER_PORT:-3000}"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { color "0;36" "[closedmesh] $*"; }
ok()   { color "0;32" "[closedmesh] $*"; }
warn() { color "0;33" "[closedmesh] $*"; }
err()  { color "0;31" "[closedmesh] $*" >&2; }

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "required command not found: $1"
        exit 1
    fi
}

require node
require npm

NODE_BIN="$(command -v node)"
info "Using node: $NODE_BIN"

info "Installing dependencies (npm ci)…"
if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
else
    npm install --no-audit --no-fund
fi

info "Building Next.js standalone bundle…"
NEXT_TELEMETRY_DISABLED=1 npm run build

if [[ ! -d ".next/standalone" ]]; then
    err "Next.js standalone bundle not found at .next/standalone."
    err "Confirm next.config.ts has  output: \"standalone\"."
    exit 1
fi

info "Staging controller into $TARGET_DIR…"
mkdir -p "$TARGET_DIR" "$LOG_DIR" "$LAUNCHD_DIR"
rm -rf "$TARGET_DIR"/*

cp -R .next/standalone/. "$TARGET_DIR/"
mkdir -p "$TARGET_DIR/.next"
cp -R .next/static "$TARGET_DIR/.next/static"
if [[ -d public ]]; then
    cp -R public "$TARGET_DIR/public"
fi

if [[ ! -f "$TARGET_DIR/server.js" ]]; then
    err "Expected $TARGET_DIR/server.js after staging the standalone bundle."
    exit 1
fi
ok "Controller staged."

info "Writing launchd agent: $PLIST"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${TARGET_DIR}/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${TARGET_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>HOSTNAME</key>
        <string>127.0.0.1</string>
        <key>PORT</key>
        <string>${PORT}</string>
        <key>NEXT_TELEMETRY_DISABLED</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/controller.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/controller.stderr.log</string>
</dict>
</plist>
PLIST

TARGET="gui/$(id -u)"
info "(Re)bootstrapping launchd service ${LABEL}…"
launchctl bootout "$TARGET/$LABEL" >/dev/null 2>&1 || true
if launchctl bootstrap "$TARGET" "$PLIST" >/dev/null 2>&1; then
    ok "Service bootstrapped."
else
    err "launchctl bootstrap failed. Try: launchctl print $TARGET/$LABEL"
    exit 1
fi

# Tiny readiness wait.
for _ in $(seq 1 15); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/control/status" >/dev/null 2>&1; then
        ok "Controller is responding on http://localhost:${PORT}"
        break
    fi
    sleep 1
done

cat <<EOF

  ClosedMesh controller installed.

  Open:    http://localhost:${PORT}/control
  Chat:    http://localhost:${PORT}
  Logs:    ${LOG_DIR}/controller.{stdout,stderr}.log
  Stop:    launchctl bootout ${TARGET}/${LABEL}

EOF
