#!/usr/bin/env bash
# ClosedMesh installer — macOS arm64, Linux x86_64/aarch64.
#
#   curl -fsSL https://closedmesh.com/install | sh
#   curl -fsSL https://closedmesh.com/install | sh -s -- --service
#
# What it does:
#   1. Detects OS, CPU arch, and (on Linux) preferred GPU backend.
#   2. Downloads the matching closedmesh release tarball from GitHub.
#   3. Installs the `closedmesh` binary into ~/.local/bin (or $CLOSEDMESH_INSTALL_DIR).
#   4. With --service: installs an OS-native autostart unit:
#        - macOS: launchd LaunchAgent (~/Library/LaunchAgents)
#        - Linux: systemd --user unit (~/.config/systemd/user)
#
# No Apple Developer account, no Xcode, no compilation. Just a binary download
# into your home directory. Uninstall with: closedmesh service stop && rm -rf
# ~/.local/bin/closedmesh.
#
# Backend override (Linux):
#   CLOSEDMESH_BACKEND=cuda|rocm|vulkan|cpu  curl ... | sh

set -euo pipefail

REPO="${CLOSEDMESH_INSTALL_REPO:-${FORGEMESH_INSTALL_REPO:-closedmesh/closedmesh-llm}}"
INSTALL_DIR="${CLOSEDMESH_INSTALL_DIR:-${FORGEMESH_INSTALL_DIR:-$HOME/.local/bin}}"
SERVICE_LABEL="dev.closedmesh.closedmesh"
LINUX_SERVICE_NAME="closedmesh"
DATA_DIR="$HOME/.closedmesh"
LEGACY_FORGEMESH_DIR="$HOME/.forgemesh"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
LAUNCHD_PLIST="$LAUNCHD_DIR/$SERVICE_LABEL.plist"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SYSTEMD_UNIT="$SYSTEMD_USER_DIR/$LINUX_SERVICE_NAME.service"
LOG_DIR_DARWIN="$HOME/Library/Logs/closedmesh"
LOG_DIR_LINUX="$HOME/.local/state/closedmesh"
INSTALL_SERVICE=0
START_SERVICE=1

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "0;36" "[closedmesh] $*"; }
ok()    { color "0;32" "[closedmesh] $*"; }
warn()  { color "0;33" "[closedmesh] $*"; }
err()   { color "0;31" "[closedmesh] $*" >&2; }

usage() {
    cat <<EOF
ClosedMesh installer

Usage:
  curl -fsSL https://closedmesh.com/install | sh
  curl -fsSL https://closedmesh.com/install | sh -s -- [options]

Options:
  --service              Also install and start an OS-native autostart unit.
                         (launchd on macOS, systemd --user on Linux.)
  --no-start-service     With --service, install the unit but don't start it yet.
  -h, --help             Show this help.

Environment:
  CLOSEDMESH_INSTALL_REPO   GitHub repo to pull releases from (default: closedmesh/closedmesh-llm)
  CLOSEDMESH_INSTALL_DIR    Where to put the binary (default: \$HOME/.local/bin)
  CLOSEDMESH_BACKEND        Force a Linux GPU backend (cuda, rocm, vulkan, cpu).
                            Overrides auto-detection. Useful when probing fails
                            on exotic hardware. Ignored on macOS.
EOF
}

while (($# > 0)); do
    case "$1" in
        --service)            INSTALL_SERVICE=1 ;;
        --no-start-service)   START_SERVICE=0 ;;
        -h|--help)            usage; exit 0 ;;
        *)                    err "unknown option: $1"; usage >&2; exit 1 ;;
    esac
    shift
done

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "required command not found: $1"
        exit 1
    fi
}

# detect_target — produce the platform-suffix used in the release asset name.
#
# Returns one of (matches the matrix in closedmesh-llm/scripts/release-closedmesh.sh):
#   darwin-aarch64
#   linux-x86_64-{cpu,cuda,rocm,vulkan}
#   linux-aarch64-{cpu,vulkan}
#
# Anything else -> aborts with a "build from source" message.
detect_target() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$arch" in
        x86_64|amd64) arch="x86_64" ;;
        arm64|aarch64) arch="aarch64" ;;
    esac

    case "$os" in
        Darwin)
            if [[ "$arch" != "aarch64" ]]; then
                err "ClosedMesh on macOS requires Apple Silicon (arm64). Detected Intel Mac."
                err "Build from source: https://github.com/$REPO"
                exit 1
            fi
            echo "darwin-aarch64"
            return 0
            ;;
        Linux)
            local backend
            backend="${CLOSEDMESH_BACKEND:-$(detect_linux_backend)}"
            case "$arch/$backend" in
                x86_64/cuda|x86_64/rocm|x86_64/vulkan|x86_64/cpu)
                    echo "linux-x86_64-$backend"
                    return 0
                    ;;
                aarch64/vulkan|aarch64/cpu)
                    echo "linux-aarch64-$backend"
                    return 0
                    ;;
                aarch64/cuda)
                    # Jetson / NVIDIA ARM. Not yet shipping a tarball — fall back to CPU
                    # so installs succeed and CUDA acceleration kicks in once we ship.
                    warn "No CUDA tarball for aarch64 yet; falling back to CPU backend."
                    echo "linux-aarch64-cpu"
                    return 0
                    ;;
                *)
                    err "Unsupported Linux target: $arch with backend $backend."
                    err "Set CLOSEDMESH_BACKEND=cpu|cuda|rocm|vulkan to override."
                    err "Or build from source: https://github.com/$REPO"
                    exit 1
                    ;;
            esac
            ;;
        *)
            err "ClosedMesh ships pre-built binaries for macOS arm64 and Linux only."
            err "Detected: $os $arch."
            err "On Windows, install via PowerShell:"
            err "  iwr -useb https://closedmesh.com/install.ps1 | iex"
            err "Or build from source: https://github.com/$REPO"
            exit 1
            ;;
    esac
}

# detect_linux_backend — pick a reasonable default GPU backend on Linux.
#
# Priority: NVIDIA -> AMD -> Intel/Vulkan -> CPU. Probes both running drivers
# (e.g. nvidia-smi) and present devices via /sys, so it works in containers
# without nvidia-smi installed (e.g. podman with --device=nvidia.com/gpu).
detect_linux_backend() {
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
        echo cuda; return
    fi
    if [[ -e /proc/driver/nvidia/version ]]; then
        echo cuda; return
    fi
    if command -v rocminfo >/dev/null 2>&1 && rocminfo >/dev/null 2>&1; then
        echo rocm; return
    fi
    if [[ -e /dev/kfd ]]; then
        echo rocm; return
    fi
    if command -v vulkaninfo >/dev/null 2>&1 && vulkaninfo --summary >/dev/null 2>&1; then
        echo vulkan; return
    fi
    # /dev/dri/renderD* is the catch-all for "this machine has a GPU we could
    # talk to via Vulkan if vulkaninfo were installed."
    if compgen -G "/dev/dri/renderD*" >/dev/null 2>&1; then
        echo vulkan; return
    fi
    echo cpu
}

asset_extension_for_target() {
    case "$1" in
        windows-*) echo "zip" ;;
        *)         echo "tar.gz" ;;
    esac
}

legacy_dir_hint() {
    if [[ -d "$LEGACY_FORGEMESH_DIR" && ! -d "$DATA_DIR" ]]; then
        warn "Found legacy data at $LEGACY_FORGEMESH_DIR. ClosedMesh will auto-migrate"
        warn "it to $DATA_DIR on first launch, or you can do it now:"
        warn "  mv $LEGACY_FORGEMESH_DIR $DATA_DIR"
    fi
}

download_binary() {
    local target="$1"
    local ext
    ext="$(asset_extension_for_target "$target")"
    local asset="closedmesh-${target}.${ext}"
    local url="https://github.com/${REPO}/releases/latest/download/${asset}"
    local tmpdir
    tmpdir="$(mktemp -d)"
    trap "rm -rf '$tmpdir'" RETURN

    info "Downloading ${asset} from ${REPO}…"
    if ! curl -fsSL --retry 3 "$url" -o "$tmpdir/$asset"; then
        err "Failed to download $url"
        err "If your hardware doesn't have a release artifact yet, try"
        err "  CLOSEDMESH_BACKEND=cpu curl -fsSL https://closedmesh.com/install | sh"
        err "or build from source: cd $REPO && cargo build --release"
        exit 1
    fi

    info "Extracting…"
    case "$ext" in
        tar.gz) tar -xzf "$tmpdir/$asset" -C "$tmpdir" ;;
        zip)    require unzip; unzip -q "$tmpdir/$asset" -d "$tmpdir" ;;
    esac

    if [[ ! -x "$tmpdir/closedmesh" ]]; then
        err "Extracted tarball did not contain a 'closedmesh' executable."
        exit 1
    fi

    mkdir -p "$INSTALL_DIR"
    install -m 0755 "$tmpdir/closedmesh" "$INSTALL_DIR/closedmesh"
    ok "Installed: $INSTALL_DIR/closedmesh"
}

install_from_local_build() {
    # If the caller already has a local build (rare; mostly for the host
    # who shipped the release), allow installing from that path via env.
    local src="${CLOSEDMESH_LOCAL_BINARY:-${FORGEMESH_LOCAL_BINARY:-}}"
    if [[ -n "$src" && -x "$src" ]]; then
        mkdir -p "$INSTALL_DIR"
        install -m 0755 "$src" "$INSTALL_DIR/closedmesh"
        ok "Installed (from local build): $INSTALL_DIR/closedmesh"
        return 0
    fi
    return 1
}

write_launchd_plist() {
    mkdir -p "$LAUNCHD_DIR" "$LOG_DIR_DARWIN" "$DATA_DIR"
    # `--auto --mesh-name closedmesh` makes this node discover and join the
    # ClosedMesh public mesh on Nostr (the named mesh "closedmesh", whose
    # entry point is published from our infrastructure). Without `--auto`
    # the runtime would never find the mesh; without `--mesh-name closedmesh`
    # it would land in the unnamed community pool of strangers' nodes
    # instead of our mesh.
    #
    # `--join-url https://mesh.closedmesh.com/api/status` is the bootstrap
    # pointer to the canonical entry node. The runtime fetches the URL on
    # startup, pulls the entry node's current invite token, and treats it
    # as `--join <token>` — guaranteeing every fresh install lands in the
    # same mesh as everyone else, even if Nostr discovery is slow or the
    # local node's listing happens to outrank the entry's. The entry's
    # token can rotate on every restart of the entry container without
    # invalidating any installed plist; only the URL is stable.
    #
    # `--headless` keeps the embedded web console on its loopback port
    # but turns off the TTY UI — matters because launchd runs the agent
    # without a real terminal.
    cat >"$LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/closedmesh</string>
        <string>serve</string>
        <string>--auto</string>
        <string>--mesh-name</string>
        <string>closedmesh</string>
        <string>--join-url</string>
        <string>https://mesh.closedmesh.com/api/status</string>
        <string>--headless</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${HOME}</string>
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
    <string>${LOG_DIR_DARWIN}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR_DARWIN}/stderr.log</string>
</dict>
</plist>
PLIST
    ok "Wrote launchd agent: $LAUNCHD_PLIST"
}

start_launchd_service() {
    local target="gui/$(id -u)"
    launchctl bootout "$target/$SERVICE_LABEL" >/dev/null 2>&1 || true
    if launchctl bootstrap "$target" "$LAUNCHD_PLIST" >/dev/null 2>&1; then
        ok "Started ClosedMesh service ($SERVICE_LABEL)"
    else
        warn "Could not auto-start the service. Try: closedmesh service start"
    fi
}

write_systemd_user_unit() {
    if ! command -v systemctl >/dev/null 2>&1; then
        warn "systemctl not found — skipping --service install."
        warn "Run manually: $INSTALL_DIR/closedmesh serve --auto --mesh-name closedmesh"
        return 1
    fi

    mkdir -p "$SYSTEMD_USER_DIR" "$LOG_DIR_LINUX" "$DATA_DIR"
    cat >"$SYSTEMD_UNIT" <<UNIT
[Unit]
Description=ClosedMesh — peer-to-peer LLM mesh node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/closedmesh serve --auto --mesh-name closedmesh --join-url https://mesh.closedmesh.com/api/status --headless
WorkingDirectory=${HOME}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_DIR_LINUX}/stdout.log
StandardError=append:${LOG_DIR_LINUX}/stderr.log

[Install]
WantedBy=default.target
UNIT
    ok "Wrote systemd user unit: $SYSTEMD_UNIT"
    return 0
}

start_systemd_service() {
    if ! systemctl --user daemon-reload >/dev/null 2>&1; then
        warn "systemctl --user daemon-reload failed (no user session bus?)."
        warn "Try logging out + back in, then: systemctl --user enable --now closedmesh"
        return 1
    fi
    if systemctl --user enable --now "$LINUX_SERVICE_NAME" >/dev/null 2>&1; then
        ok "Started ClosedMesh user service ($LINUX_SERVICE_NAME)"
        # Linger keeps the service running when the user logs out — opt-in
        # because it requires `loginctl enable-linger` (no sudo on most distros
        # but technically a privileged op).
        info "To keep ClosedMesh running when you log out:"
        info "  loginctl enable-linger \$USER"
    else
        warn "Could not auto-start the service. Try: systemctl --user enable --now $LINUX_SERVICE_NAME"
    fi
}

install_service() {
    case "$(uname -s)" in
        Darwin)
            write_launchd_plist
            if (( START_SERVICE )); then
                start_launchd_service
            else
                ok "Service installed (not started). Start later: closedmesh service start"
            fi
            ;;
        Linux)
            if write_systemd_user_unit && (( START_SERVICE )); then
                start_systemd_service
            elif (( ! START_SERVICE )); then
                ok "Service installed (not started). Start later: systemctl --user enable --now $LINUX_SERVICE_NAME"
            fi
            ;;
        *)
            warn "--service is not supported on this OS yet."
            ;;
    esac
}

# Drop a default ~/.closedmesh/config.toml on first install so the runtime
# has something to load. `closedmesh serve` exits with a "needs at least one
# startup model" warning if neither config nor --model is supplied; that's
# the right behavior for the CLI but a bad first-run experience for the
# desktop app, which can't easily edit launchd args after the fact. The
# stub here lists the recommended-for-Apple-Silicon model commented out so
# users can uncomment after `closedmesh download Qwen3-8B-Q4_K_M`.
seed_default_config() {
    mkdir -p "$DATA_DIR"
    local cfg="$DATA_DIR/config.toml"
    if [[ -f "$cfg" ]]; then
        info "Existing config preserved: $cfg"
        return 0
    fi
    cat >"$cfg" <<'TOML'
# ClosedMesh node config — written by the installer on first run.
#
# At least one [[models]] entry must be uncommented (and the matching
# model downloaded with `closedmesh download <id>`) before the runtime
# will start serving. Pick whichever fits your machine:
#
#   closedmesh gpus                       # what backend / how much VRAM
#   closedmesh models recommended         # the curated catalog
#   closedmesh download Qwen3-8B-Q4_K_M   # ~5 GB, fits an M2/M3 Mac
#
# Then uncomment the matching block below and restart the service:
#
#   closedmesh service stop
#   closedmesh service start

# [[models]]
# model = "Qwen3-8B-Q4_K_M"
# ctx_size = 8192

# [[models]]
# model = "Qwen2.5-3B-Instruct-Q4_K_M"
# ctx_size = 4096
TOML
    ok "Wrote starter config: $cfg"
}

ensure_path_hint() {
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) return 0 ;;
    esac
    warn "Note: $INSTALL_DIR is not on your PATH."
    case "$(uname -s)" in
        Darwin) warn "Add this to ~/.zshrc:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
        Linux)  warn "Add this to ~/.bashrc / ~/.zshrc:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
    esac
}

main() {
    require curl
    require tar

    info "Installing ClosedMesh — private LLM mesh on the compute you already own."
    info "Repo:    https://github.com/$REPO"
    info "Bin dir: $INSTALL_DIR"

    local target
    target="$(detect_target)"
    info "Target:  $target"

    legacy_dir_hint

    if ! install_from_local_build; then
        download_binary "$target"
    fi

    "$INSTALL_DIR/closedmesh" --version >/dev/null 2>&1 || {
        err "Installed binary did not run cleanly. Aborting."
        exit 1
    }

    seed_default_config

    if (( INSTALL_SERVICE )); then
        install_service
    fi

    ensure_path_hint

    cat <<EOF

  ClosedMesh installed.

  Try:
    closedmesh --version
    closedmesh serve --auto --mesh-name closedmesh   # foreground (joins the closedmesh public mesh, logs in your terminal)
$( (( INSTALL_SERVICE )) && echo '    closedmesh service status            # check the autostart service' )
$( (( INSTALL_SERVICE )) && echo '    closedmesh service stop              # stop the autostart service' )

  Open the chat at https://closedmesh.com (or http://localhost:3000 if you ran the local app).

EOF
}

main "$@"
