# Bundled controller sidecar (Phase 8b)

## What this solves

Today the Tauri desktop shell is a webview that loads either:

- `http://localhost:3000` if the user separately ran
  `scripts/install-controller.sh` to install the Next.js controller as a
  launchd service, or
- `https://closedmesh.com` if no local controller is responding.

That second path *also* ultimately needs a controller on `localhost:3000`
because the public site's chat client posts back to it via CORS. So the
"download .app and use it" flow currently dead-ends unless the user
runs a separate curl-bash from the terminal.

This sidecar bundles the controller into the `.app` so the user only
needs the one download.

## Architecture

```
ClosedMesh.app
├── Contents/
│   ├── MacOS/
│   │   ├── closedmesh                ← Tauri shell (Rust binary)
│   │   └── node-aarch64-apple-darwin ← bundled Node.js (sidecar binary)
│   └── Resources/
│       └── controller/               ← Next.js standalone bundle
│           ├── server.js
│           ├── .next/
│           ├── public/
│           └── node_modules/         ← prod deps Next standalone needs
```

On launch, `main.rs`:

1. Picks a free port (`TcpListener::bind("127.0.0.1:0")`).
2. Spawns `node $RESOURCES/controller/server.js` with
   `PORT=<port> HOSTNAME=127.0.0.1 NODE_ENV=production`.
3. Polls `http://127.0.0.1:<port>/api/control/status` until it answers
   (~1–3s on warm SSDs).
4. Tells the webview to load `http://127.0.0.1:<port>/`.
5. Stores the `Child` handle and kills the sidecar in the
   `RunEvent::Exit` hook.

`mesh::preferred_url()` becomes:

```
1. CLOSEDMESH_APP_URL env (dev override)              — unchanged
2. http://127.0.0.1:<sidecar_port>/                   — NEW (default)
3. (dev only) http://localhost:3000 if a real Next.js dev server is up
4. https://closedmesh.com                             — last resort
```

## Why Node.js (not Bun, not single-binary)

Trade-offs we considered:

| Option                | .app size impact | Compatibility | Risk     |
| --------------------- | ---------------- | ------------- | -------- |
| **Node.js sidecar**   | +60–80MB        | 100% — Next.js targets Node | low |
| Bun sidecar           | +50MB           | Mostly works on Next.js but not officially supported | medium |
| Node SEA (single-exe) | +40MB (no node_modules, just the bundled Next standalone) | Experimental; spawning child processes from a SEA has rough edges | high |
| Static export         | +0MB             | Doesn't work — our /api/control/* routes need a Node runtime to spawn the closedmesh CLI | n/a |

Node.js is the boring choice. We can revisit Bun once it has a track
record with our exact Next.js feature set.

## Per-platform Node.js binary

We fetch the official Node.js LTS distribution from `nodejs.org`:

| Tauri target               | Node.js asset                                |
| -------------------------- | -------------------------------------------- |
| `aarch64-apple-darwin`     | `node-vXX.XX.X-darwin-arm64.tar.gz`         |
| `x86_64-apple-darwin`      | `node-vXX.XX.X-darwin-x64.tar.gz`           |
| `x86_64-unknown-linux-gnu` | `node-vXX.XX.X-linux-x64.tar.xz`            |
| `aarch64-unknown-linux-gnu`| `node-vXX.XX.X-linux-arm64.tar.xz`          |
| `x86_64-pc-windows-msvc`   | `node-vXX.XX.X-win-x64.zip` (extract `node.exe`) |

Tauri's `bundle.externalBin` requires platform-suffixed names:

```
desktop/sidecar/binaries/
├── node-aarch64-apple-darwin
├── node-x86_64-apple-darwin
├── node-x86_64-unknown-linux-gnu
├── node-aarch64-unknown-linux-gnu
└── node-x86_64-pc-windows-msvc.exe
```

`desktop/scripts/fetch-node.sh` downloads only the binary for the host
target on local builds; CI fetches all of them in parallel jobs (matrix
in `desktop-release.yml`).

## Build pipeline

Local build (`desktop/scripts/build.sh`) now does:

1. `cd .. && npm ci && npm run build`  — produce
   `.next/standalone/` + `.next/static/` in the repo root.
2. `desktop/scripts/stage-controller.sh` — copy the standalone bundle
   into `desktop/sidecar/controller/`, including `.next/static` and
   `public/`.
3. `desktop/scripts/fetch-node.sh` — download the host-platform Node
   binary into `desktop/sidecar/binaries/node-<target-triple>`.
4. `tauri build` — bundles everything into the platform installers.

CI (`.github/workflows/desktop-release.yml`) runs steps 1–3 inside each
matrix job (we already do `npm ci` for the desktop's own deps); step 4
is unchanged.

## Lifecycle / robustness

- The sidecar is owned by the parent process. Tauri's
  `RunEvent::Exit` hook calls `Child::kill()` synchronously.
- On macOS, when the user force-quits via the tray Quit item or
  Cmd+Q, we go through `app.exit(0)` which fires the same hook.
- If the sidecar crashes mid-session, we restart it once (logged
  to the console). If it crashes again within 30s, we surface a
  toast and stop trying — the webview goes to the
  `closedmesh.com` fallback so the user can still see the
  marketing/install page.
- The sidecar's logs go to
  `~/Library/Logs/closedmesh/controller.{stdout,stderr}.log` (same
  location as today's launchd-installed controller, for continuity).

## What this replaces

`scripts/install-controller.sh` becomes a fallback for headless /
power-user scenarios (CI testing, running the controller without the
GUI shell). The "happy path" is now the .app sidecar.

## Open questions

- **macOS notarization.** Currently ad-hoc signed (Gatekeeper bypass
  required on first launch). Adding a sidecar binary doesn't change
  this — but it does mean we ship more code that hits Gatekeeper, so
  the first-launch dialog count may increase. Worth verifying.
- **.dmg size budget.** Measured on macOS arm64: Node v22.11.0 binary
  is ~120MB, the Next.js standalone bundle is ~39MB. With the Tauri
  shell + icons + framework on top, the macOS .dmg lands around
  180–200MB. That's notably bigger than the 100MB budget the original
  plan assumed; it's still acceptable for a desktop product (compare
  with VS Code at ~190MB and Slack at ~250MB) but we should mention it
  in the release notes so users on slow connections aren't surprised.
  If we ever want to shrink: switch to a smaller JS runtime (Bun is
  ~50MB), or strip node_modules in the Next.js standalone bundle that
  we don't actually load.
- **Auto-update.** Out of scope for this phase. When we add the Tauri
  updater, both the shell binary and the sidecar bundle update
  together (the latter is just files in `Contents/Resources/`).
