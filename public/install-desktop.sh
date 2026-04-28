#!/usr/bin/env bash
# ClosedMesh Desktop installer — macOS, Linux.
#
#   curl -fsSL https://closedmesh.com/install-desktop.sh | sh
#
# What it does:
#   1. Resolves the latest desktop-v* GitHub Release.
#   2. Downloads the right bundle for this machine:
#        - macOS arm64  → ClosedMesh_*_aarch64.dmg
#        - macOS x86_64 → ClosedMesh_*_x64.dmg
#        - Linux x86_64 → ClosedMesh_*_amd64.AppImage  (or .deb if dpkg)
#   3. Installs it into the conventional location (/Applications,
#      ~/.local/bin, or via dpkg) and clears macOS Gatekeeper quarantine
#      so the first launch doesn't trip the "unidentified developer"
#      dialog. Non-technical teammates can paste the curl line and have
#      a working app a few seconds later.
#
# This is a *companion* to the runtime installer (`install.sh`). The
# desktop app is a UI shell; it doesn't host inference. You still want
# the runtime running on at least one machine on your team — install
# it separately with:
#
#     curl -fsSL https://closedmesh.com/install | sh -s -- --service
#
# Override points (rarely needed):
#   CLOSEDMESH_DESKTOP_REPO=closedmesh/closedmesh
#   CLOSEDMESH_DESKTOP_VERSION=desktop-v0.1.0   # pin a specific release

set -euo pipefail

REPO="${CLOSEDMESH_DESKTOP_REPO:-closedmesh/closedmesh}"
VERSION="${CLOSEDMESH_DESKTOP_VERSION:-}"
TAG_PREFIX="desktop-v"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "0;36" "[closedmesh-desktop] $*"; }
warn()  { color "0;33" "[closedmesh-desktop] $*"; }
fail()  { color "0;31" "[closedmesh-desktop] $*"; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"
}

require curl

OS="$(uname -s)"
ARCH="$(uname -m)"

# ---------------------------------------------------------------------------
# Pick the asset filename pattern for this machine.
#
# Tauri's bundle naming is stable: ClosedMesh_<version>_<arch>.<ext> on
# macOS, closedmesh_<version>_<debarch>.<ext> on Linux. We match by
# substring so a future minor version bump (e.g. _0.2.0_) doesn't require
# touching this script.
# ---------------------------------------------------------------------------
match=""
case "$OS-$ARCH" in
    Darwin-arm64)
        match="aarch64.dmg" ;;
    Darwin-x86_64)
        match="x64.dmg" ;;
    Linux-x86_64)
        # Prefer .deb on apt-based distros (proper integration: PATH entry,
        # menu entry, uninstall via apt). Otherwise fall back to the
        # universal AppImage.
        if command -v dpkg >/dev/null 2>&1; then
            match="amd64.deb"
        else
            match="amd64.AppImage"
        fi
        ;;
    Linux-aarch64)
        # We don't currently publish Linux arm64 bundles. Tell the user
        # how to build from source rather than silently failing.
        fail "Linux arm64 isn't published yet — build from source:
  git clone https://github.com/$REPO
  cd $(basename "$REPO")/desktop
  npm install && ./scripts/build.sh"
        ;;
    *)
        fail "unsupported platform: $OS-$ARCH" ;;
esac

# ---------------------------------------------------------------------------
# Resolve the release tag + asset URL via the GitHub REST API.
#
# We deliberately avoid jq — most curl|sh users won't have it — and use
# a small awk parser that's good enough for the GitHub release schema.
# ---------------------------------------------------------------------------
api() {
    local path="$1"
    local auth=()
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
    fi
    curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${auth[@]}" \
        "https://api.github.com/repos/$REPO$path"
}

if [ -n "$VERSION" ]; then
    info "Pinned to $VERSION"
    release_json="$(api "/releases/tags/$VERSION")"
else
    info "Resolving latest release of $REPO…"
    release_json="$(api "/releases/latest" 2>/dev/null || true)"
    # /releases/latest can return a non-desktop tag (or a 404 on a fresh
    # repo) — fall back to scanning the recent list.
    if ! printf '%s' "$release_json" | grep -q "\"tag_name\": *\"$TAG_PREFIX"; then
        info "Falling back to release list…"
        release_json="$(api "/releases?per_page=20")"
        # Take the first $TAG_PREFIX tag in the JSON. The GitHub API returns
        # newest first, so this is the latest published desktop release.
        release_json="$(printf '%s' "$release_json" | awk -v p="$TAG_PREFIX" '
            BEGIN { depth=0 }
            /^\[/ { next }
            /^]/  { exit }
            /"tag_name":/ {
                if (match($0, "\"" p "[^\"]+\"")) { in_block=1 }
            }
            in_block { print }
            in_block && /^  }/ { exit }
        ')"
    fi
fi

if [ -z "$release_json" ]; then
    fail "couldn't fetch release info from GitHub. Try downloading manually from https://github.com/$REPO/releases"
fi

tag_name="$(printf '%s' "$release_json" | awk -F'"' '/"tag_name":/ { print $4; exit }')"
[ -n "$tag_name" ] || fail "no tag_name in release response"
version="${tag_name#$TAG_PREFIX}"

# Walk the assets array, pick the URL whose filename ends with $match.
asset_url="$(printf '%s' "$release_json" | awk -v m="$match" -F'"' '
    /"browser_download_url":/ {
        url=$4
        n=split(url, parts, "/")
        name=parts[n]
        if (index(name, m) == length(name) - length(m) + 1) {
            print url
            exit
        }
    }
')"

[ -n "$asset_url" ] || fail "no asset matching *$match in release $tag_name. See https://github.com/$REPO/releases/tag/$tag_name"

asset_name="$(basename "$asset_url")"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

info "Downloading $asset_name (v$version)…"
curl -fL --progress-bar "$asset_url" -o "$tmpdir/$asset_name"

# ---------------------------------------------------------------------------
# Per-OS install steps.
# ---------------------------------------------------------------------------
case "$OS" in
    Darwin)
        info "Mounting $asset_name…"
        mount_output="$(hdiutil attach -nobrowse -quiet "$tmpdir/$asset_name")"
        # `hdiutil attach` prints lines like
        #   /dev/disk5    GUID_partition_scheme
        #   /dev/disk5s1  Apple_HFS    /Volumes/ClosedMesh
        # the last whitespace-trimmed field on the last line is the mount
        # point.
        mount_point="$(printf '%s\n' "$mount_output" | awk '/\/Volumes\// { for (i=3; i<=NF; i++) printf "%s%s", $i, (i==NF ? "" : " "); print ""; exit }')"
        [ -n "$mount_point" ] || fail "couldn't determine mount point from hdiutil output"

        app_path="$(/usr/bin/find "$mount_point" -maxdepth 2 -name "*.app" -print -quit)"
        [ -n "$app_path" ] || { hdiutil detach "$mount_point" -quiet >/dev/null || true; fail "no .app inside the .dmg"; }
        app_name="$(basename "$app_path")"

        target="/Applications/$app_name"
        if [ -d "$target" ]; then
            info "Replacing existing $target…"
            rm -rf "$target"
        fi
        info "Copying $app_name to /Applications…"
        cp -R "$app_path" "/Applications/"
        hdiutil detach "$mount_point" -quiet >/dev/null || true

        # Clear the quarantine xattr so first launch skips the "unidentified
        # developer" dialog. This is the same operation Gatekeeper performs
        # after the user does "right-click → Open → Open"; doing it up
        # front means a teammate who paste-runs this script lands directly
        # in the app on first launch.
        if /usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null; then
            info "Cleared Gatekeeper quarantine."
        else
            warn "Couldn't clear Gatekeeper quarantine — first launch may show 'unidentified developer'. Right-click → Open in Finder."
        fi

        info "Installed: $target"
        info "Launching ClosedMesh…"
        open "$target" || warn "Couldn't auto-launch — open it from /Applications."
        ;;

    Linux)
        case "$asset_name" in
            *.deb)
                info "Installing $asset_name via dpkg…"
                if [ "$(id -u)" -eq 0 ]; then
                    dpkg -i "$tmpdir/$asset_name" || apt-get install -fy
                else
                    require sudo
                    sudo dpkg -i "$tmpdir/$asset_name" || sudo apt-get install -fy
                fi
                info "Installed: closedmesh (run from your app launcher or 'closedmesh' on the CLI)."
                ;;
            *.AppImage)
                target_dir="${CLOSEDMESH_DESKTOP_INSTALL_DIR:-$HOME/.local/bin}"
                target="$target_dir/closedmesh-desktop"
                mkdir -p "$target_dir"
                cp "$tmpdir/$asset_name" "$target"
                chmod +x "$target"
                info "Installed: $target"
                # We don't auto-create a .desktop entry — keeping the
                # script side-effect-free outside of $HOME/.local/bin.
                # The AppImage itself can integrate with the desktop on
                # first launch (it'll prompt) if libappimage is around.
                if ! printf '%s' "$PATH" | tr ':' '\n' | grep -Fxq "$target_dir"; then
                    warn "$target_dir is not on your PATH. Add it to your shell rc, or run directly: $target"
                fi
                ;;
            *)
                fail "unexpected asset format: $asset_name"
                ;;
        esac
        ;;

    *)
        fail "unsupported OS: $OS"
        ;;
esac

color "1;32" "[closedmesh-desktop] Done. v$version installed."
echo
echo "Next steps:"
echo "  1. If you haven't already, install the runtime on at least one machine:"
echo "       curl -fsSL https://closedmesh.com/install | sh -s -- --service"
echo "  2. Open ClosedMesh — the system-tray pill should show 'Mesh online'."
echo "  3. Generate an invite for a teammate from the tray menu, or via:"
echo "       closedmesh invite create"
