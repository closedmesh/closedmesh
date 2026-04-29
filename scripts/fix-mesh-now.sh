#!/usr/bin/env bash
# One-shot fix: rejoin the canonical closedmesh mesh using your existing binary.
#
# Why this exists: install.sh now writes a plist with `--join-url`, but that
# flag only exists in the v0.65.0+ binary. If you upgraded the desktop .app
# without re-running install.sh (or with an older closedmesh-llm release), your
# launchd agent is still using the *old* args (no --join), so your node spins
# up its own private "closedmesh" mesh that the entry node never sees.
#
# This script:
#   1. Fetches the entry node's current invite token from mesh.closedmesh.com.
#   2. Rewrites your launchd plist to use `--join <token>` (works with any
#      closedmesh CLI that ever shipped) instead of `--join-url`.
#   3. Bounces the launchd agent.
#   4. Verifies your model shows up at https://closedmesh.com/api/status.
#
# Once `closedmesh-llm v0.65.0` ships, re-run `curl ... | sh` from
# closedmesh.com and this script becomes obsolete.

set -euo pipefail

BIN="${CLOSEDMESH_BIN:-$HOME/.local/bin/closedmesh}"
LABEL="dev.closedmesh.closedmesh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/closedmesh"
ENTRY_URL="https://mesh.closedmesh.com/api/status"
PUBLIC_STATUS="https://closedmesh.com/api/status"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "0;36" "[fix-mesh] $*"; }
ok()    { color "0;32" "[fix-mesh] $*"; }
warn()  { color "0;33" "[fix-mesh] $*"; }
err()   { color "0;31" "[fix-mesh] $*" >&2; }

if [[ ! -x "$BIN" ]]; then
    err "closedmesh binary not found at $BIN"
    err "Set CLOSEDMESH_BIN=/path/to/closedmesh and re-run, or run install.sh first."
    exit 1
fi

info "Fetching entry node token from $ENTRY_URL …"
TOKEN="$(curl -fsSL --max-time 10 "$ENTRY_URL" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")"
if [[ -z "$TOKEN" ]]; then
    err "Could not fetch a token from the entry node."
    exit 1
fi
ok "Got token: ${TOKEN:0:24}…"

info "Stopping current service …"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

mkdir -p "$LOG_DIR"

info "Writing patched plist to $PLIST …"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BIN</string>
        <string>serve</string>
        <string>--auto</string>
        <string>--mesh-name</string>
        <string>closedmesh</string>
        <string>--join</string>
        <string>$TOKEN</string>
        <string>--headless</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$HOME</string>
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
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
PLIST
ok "Plist written."

info "Starting service …"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
ok "Service started."

info "Waiting 25s for the runtime to boot, join, and publish …"
for i in 25 20 15 10 5; do
    sleep 5
    printf '  %ss…\n' "$i"
done

info "Checking $PUBLIC_STATUS …"
RESP="$(curl -fsSL --max-time 10 "$PUBLIC_STATUS")"
echo "$RESP" | python3 -m json.tool || echo "$RESP"

NODES="$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('nodeCount',0))" 2>/dev/null || echo 0)"
MODELS="$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('models',[])))" 2>/dev/null || echo 0)"

echo
if [[ "$MODELS" -gt 0 ]]; then
    ok "Mesh sees $NODES node(s) and $MODELS model(s). Try chat at https://closedmesh.com 🎉"
else
    warn "Mesh sees $NODES node(s) but $MODELS model(s) yet."
    warn "Tail your runtime logs: tail -f $LOG_DIR/stderr.log"
    warn "And entry node logs: gh run view -R closedmesh/closedmesh-llm (or wait 30s and re-run this curl)."
fi
