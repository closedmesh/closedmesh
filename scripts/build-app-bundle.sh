#!/usr/bin/env bash
# scripts/build-app-bundle.sh — build a tiny ClosedMesh.app launcher.
#
# The .app is a thin wrapper that opens http://localhost:3000/control in the
# default browser. The actual server is the launchd controller that
# `scripts/install-controller.sh` set up. We use osacompile so this works on
# any Mac without Apple Developer account, Xcode, or codesigning.
#
# Output:
#   dist/ClosedMesh.app
#   dist/ClosedMesh.app.zip   (handy for distribution)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DIST_DIR="$REPO_ROOT/dist"
APP_PATH="$DIST_DIR/ClosedMesh.app"
ZIP_PATH="$DIST_DIR/ClosedMesh.app.zip"
BUNDLE_ID="com.closedmesh.app"
PORT="${CLOSEDMESH_CONTROLLER_PORT:-3000}"
URL="http://localhost:${PORT}/control"

mkdir -p "$DIST_DIR"
rm -rf "$APP_PATH" "$ZIP_PATH"

if ! command -v osacompile >/dev/null 2>&1; then
    echo "osacompile not found (it ships with macOS — are you on macOS?)" >&2
    exit 1
fi

echo "==> osacompile ClosedMesh.app"

# The applet:
#   1. Quietly checks if the controller is up.
#   2. If down, tries to install/start it via the install-controller.sh script
#      from our home dir (best-effort; if the script isn't there, we just open
#      a friendly tab with instructions).
#   3. Opens the /control page.

read -r -d '' SCRIPT <<APPLE_SCRIPT || true
on run
    set portNum to "${PORT}"
    set targetURL to "${URL}"
    set installerHint to "https://closedmesh.com/install"
    set installerScript to (POSIX path of (path to home folder)) & ".closedmesh/controller/install-controller.sh"

    -- Try to reach the controller.
    set isUp to false
    try
        do shell script "curl -fsS --max-time 2 http://127.0.0.1:" & portNum & "/api/control/status > /dev/null"
        set isUp to true
    end try

    if not isUp then
        try
            -- If the user has the source repo around, try to start the controller
            -- via the install-controller script. We do not block on its output.
            do shell script "test -x " & quoted form of installerScript & " && nohup bash " & quoted form of installerScript & " > /dev/null 2>&1 &"
        end try
        -- Give launchd a moment, then check again.
        delay 1
        repeat 8 times
            try
                do shell script "curl -fsS --max-time 1 http://127.0.0.1:" & portNum & "/api/control/status > /dev/null"
                set isUp to true
                exit repeat
            end try
            delay 1
        end repeat
    end if

    if isUp then
        do shell script "open " & quoted form of targetURL
    else
        display dialog "ClosedMesh isn't running yet on this Mac." & return & return & "Install it with:" & return & "    curl -fsSL " & installerHint & " | sh -s -- --service" & return & return & "Then run scripts/install-controller.sh from the closedmesh repo to bring up the local control panel." buttons {"OK"} default button "OK" with title "ClosedMesh"
    end if
end run
APPLE_SCRIPT

osacompile -o "$APP_PATH" -e "$SCRIPT"

# Patch Info.plist for branding.
PLIST="$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName ClosedMesh" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleName string ClosedMesh" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ClosedMesh" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string ClosedMesh" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string ${BUNDLE_ID}" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.0" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string 0.1.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :LSUIElement YES" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :LSUIElement bool YES" "$PLIST"

# Optional icon: drop one at branding/closedmesh.icns and we'll use it.
if [[ -f "$REPO_ROOT/branding/closedmesh.icns" ]]; then
    cp "$REPO_ROOT/branding/closedmesh.icns" "$APP_PATH/Contents/Resources/applet.icns"
fi

echo "==> packaging ${ZIP_PATH}"
( cd "$DIST_DIR" && zip -qry "$(basename "$ZIP_PATH")" "$(basename "$APP_PATH")" )

cat <<EOF

  Built: $APP_PATH
  Zip:   $ZIP_PATH

  Drag ClosedMesh.app into /Applications. Double-click it to open the control
  panel in your browser.

EOF
