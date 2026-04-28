#!/usr/bin/env bash
# Smoke-test the local node's capability surfacing.
#
# Run this on each machine you bring into the mesh. It hits the local admin
# API, asserts the capability fields are present, and prints a one-line
# summary so you can eyeball whether the right backend was picked.
#
#   ./scripts/smoke-capability.sh
#   ./scripts/smoke-capability.sh http://other-host:3131  # remote admin port
#
# Exit codes:
#   0 — admin API reachable, capability fields present and non-empty
#   1 — admin API unreachable
#   2 — capability fields missing/empty (the runtime is too old or misbuilt)

set -euo pipefail

ADMIN_URL="${1:-${CLOSEDMESH_ADMIN_URL:-http://127.0.0.1:3131}}"

if ! command -v jq >/dev/null 2>&1; then
    echo "[smoke-capability] this script needs jq (brew install jq / apt install jq)" >&2
    exit 1
fi

if ! body="$(curl -fsS --max-time 5 "$ADMIN_URL/api/status" 2>/dev/null)"; then
    echo "[smoke-capability] could not reach $ADMIN_URL/api/status" >&2
    echo "[smoke-capability] is 'closedmesh serve' running on this machine?" >&2
    exit 1
fi

backend="$(jq -r '.capability.backend // empty' <<<"$body")"
vendor="$(jq -r '.capability.vendor // empty' <<<"$body")"
vram="$(jq -r '.capability.vram_total_mb // 0' <<<"$body")"
compute="$(jq -r '.capability.compute_class // empty' <<<"$body")"
peer_count="$(jq -r '(.peers // []) | length' <<<"$body")"

if [[ -z "$backend" || -z "$vendor" ]]; then
    echo "[smoke-capability] capability fields missing in /api/status — runtime too old?" >&2
    echo "$body" | jq -r '.capability // "(no capability field)"' >&2
    exit 2
fi

printf '[smoke-capability] %s\n' "$ADMIN_URL"
printf '  backend       : %s\n' "$backend"
printf '  vendor        : %s\n' "$vendor"
printf '  vram_total_mb : %s\n' "$vram"
printf '  compute_class : %s\n' "$compute"
printf '  peer_count    : %s\n' "$peer_count"

if [[ "$peer_count" -gt 0 ]]; then
    echo '  peers         :'
    jq -r '.peers[] | "    - \(.id[:8]) backend=\(.capability.backend // "?") vendor=\(.capability.vendor // "?") vram_mb=\(.capability.vram_total_mb // 0)"' <<<"$body"
fi
