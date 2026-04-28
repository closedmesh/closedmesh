//! Bundled Next.js controller sidecar.
//!
//! On launch we spawn a Node.js process running the standalone Next.js
//! bundle that lives in the .app's resource directory. The webview then
//! points at `http://127.0.0.1:<port>/` instead of the user having to
//! install the controller separately as a launchd service.
//!
//! See `desktop/SIDECAR.md` for the architectural overview.
//!
//! Lifecycle:
//!   - `Sidecar::spawn` returns a handle holding the running `Child` plus
//!     the chosen port. Drop kills the child (best-effort).
//!   - `Sidecar::wait_until_ready` polls `/api/control/status` until the
//!     server answers or a timeout fires.
//!   - `mesh::preferred_url` reads the chosen port through a shared
//!     `OnceLock`, so the rest of the app doesn't need to thread the port
//!     value around.

use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Filenames the bundled Node.js binary may go by, in resolution order.
///
/// Tauri's `bundle.externalBin` ships the host-platform variant with
/// the bare prefix name (just `node` / `node.exe`) when copying it into
/// the .app / .msi / .deb. During `cargo run` against an unbundled
/// debug binary, the file still lives at its source path with the
/// target-triple suffix appended (e.g. `node-aarch64-apple-darwin`),
/// because no bundling step has run yet. Probe both — first the
/// bundled convention so the .app starts fast, then the dev one.
fn sidecar_node_filename_candidates() -> [&'static str; 2] {
    if cfg!(windows) {
        [
            "node.exe",
            concat!("node-", env!("CLOSEDMESH_TARGET_TRIPLE"), ".exe"),
        ]
    } else {
        ["node", concat!("node-", env!("CLOSEDMESH_TARGET_TRIPLE"))]
    }
}

/// The port we'd LIKE the bundled controller to bind. Matches the
/// existing `localhost:3000` convention so that:
///
///   - closedmesh.com's cross-origin chat client (which posts to
///     `NEXT_PUBLIC_LOCAL_CONTROLLER_URL`, default `http://localhost:3000`)
///     finds the bundled controller automatically.
///   - Anyone who had the legacy launchd controller before Phase 8b
///     keeps working on the same port if they ever turn it back on.
const PREFERRED_PORT: u16 = 3000;

/// Pick a TCP port for the controller. We try `PREFERRED_PORT` first
/// (so the website's CORS flow keeps working) and fall back to a
/// kernel-assigned random high port if it's busy. Binding to `:0` lets
/// the kernel choose; we drop the listener and immediately pass the
/// port to Node. The brief TOCTOU window between close-and-listen has
/// not been a problem in practice — nothing else on the user's machine
/// is racing for an ephemeral port that just freed.
fn pick_port() -> io::Result<u16> {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        let port = listener.local_addr()?.port();
        return Ok(port);
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

/// Locate the bundled Node.js executable. Tauri ships it next to our
/// own binary in `Contents/MacOS/` (macOS), the install root (Windows),
/// or the bundle root (.AppImage / .deb). We resolve relative to
/// `current_exe` rather than asking Tauri's path API — this works
/// before the Tauri runtime is fully initialized, which matters for
/// the "fail loudly at startup" path below.
fn find_node_binary() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current_exe has no parent"))?;
    let candidates = sidecar_node_filename_candidates();

    // Bundled .app / .msi / .deb / .AppImage layout: the binary sits in
    // the same dir as the main shell binary. On macOS that's
    // Contents/MacOS/.
    for name in candidates {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    // Dev fallback: running `cargo run` from desktop/ leaves the binary
    // at desktop/target/{debug,release}/closedmesh, with the sidecar
    // staged at desktop/sidecar/binaries/node-<triple>.
    if let Some(workspace) = dir.parent().and_then(|d| d.parent()) {
        let sidecar_dir = workspace.join("sidecar").join("binaries");
        for name in candidates {
            let candidate = sidecar_dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "bundled Node.js sidecar not found (tried {:?} next to {})",
            candidates,
            dir.display()
        ),
    ))
}

/// Locate the staged Next.js controller bundle.
///
/// Tauri exposes a `resource_dir()` helper, but it errors out in some
/// run modes (notably `cargo run` against a debug bundle), so we resolve
/// the path ourselves from `current_exe()`. The .app / .deb / .msi
/// layouts are well-defined and stable.
fn find_controller_dir() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current_exe has no parent"))?;

    // macOS .app bundle:  Contents/MacOS/closedmesh
    //   → resources at:   Contents/Resources/sidecar/controller/
    if cfg!(target_os = "macos") {
        if let Some(bundle_resources) = exe_dir
            .parent()
            .map(|d| d.join("Resources").join("sidecar").join("controller"))
        {
            if bundle_resources.join("server.js").is_file() {
                return Ok(bundle_resources);
            }
        }
    }

    // Linux .deb / .AppImage and Windows .msi place resources in the same
    // directory as the binary (Tauri's bundler convention).
    let next_to_exe = exe_dir.join("sidecar").join("controller");
    if next_to_exe.join("server.js").is_file() {
        return Ok(next_to_exe);
    }

    // Dev fallback for `cargo run` from desktop/: walk up out of
    // target/{debug,release}/ to find desktop/sidecar/controller/.
    if let Some(workspace) = exe_dir.parent().and_then(|d| d.parent()) {
        let dev = workspace.join("sidecar").join("controller");
        if dev.join("server.js").is_file() {
            return Ok(dev);
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "bundled Next.js controller not found near {}",
            exe_dir.display()
        ),
    ))
}

/// Owned handle for the running sidecar process. Dropping kills it.
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    port: u16,
}

impl Sidecar {
    /// Spawn the bundled Next.js controller. Returns immediately; the
    /// caller should `wait_until_ready` before pointing the webview at
    /// the resulting URL.
    pub fn spawn(log_dir: Option<&Path>) -> io::Result<Self> {
        let node = find_node_binary()?;
        let controller_dir = find_controller_dir()?;
        let server_js = controller_dir.join("server.js");
        let port = pick_port()?;

        // Set up stdout/stderr redirection. We send the Next.js server's
        // output to the same log dir today's launchd controller uses, so
        // existing log-tailing tooling (and the in-app /logs page) keeps
        // working without changes.
        let (stdout_target, stderr_target) = match log_dir {
            Some(dir) => {
                let _ = std::fs::create_dir_all(dir);
                let stdout = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("controller.stdout.log"))
                    .ok();
                let stderr = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("controller.stderr.log"))
                    .ok();
                (
                    stdout.map(Stdio::from).unwrap_or_else(Stdio::null),
                    stderr.map(Stdio::from).unwrap_or_else(Stdio::null),
                )
            }
            None => (Stdio::null(), Stdio::null()),
        };

        let child = Command::new(&node)
            .arg(&server_js)
            // Next.js standalone reads HOSTNAME / PORT and binds there.
            // 127.0.0.1 (not 0.0.0.0) is deliberate — the controller is
            // only meant to be reached from this machine; cross-origin
            // calls from closedmesh.com still go through `localhost` per
            // the W3C "potentially trustworthy origin" rule.
            .env("PORT", port.to_string())
            .env("HOSTNAME", "127.0.0.1")
            .env("NODE_ENV", "production")
            .env("NEXT_TELEMETRY_DISABLED", "1")
            // Run from the controller dir so relative paths inside the
            // standalone bundle resolve correctly.
            .current_dir(&controller_dir)
            .stdin(Stdio::null())
            .stdout(stdout_target)
            .stderr(stderr_target)
            .spawn()?;

        Ok(Sidecar {
            child: Mutex::new(Some(child)),
            port,
        })
    }

    /// Block until the sidecar's `/api/control/status` endpoint answers
    /// or `timeout` elapses. Returns Ok if the controller came up,
    /// `WouldBlock` on timeout. Cold-start on a warm SSD is ~1–2s; we
    /// give it plenty of headroom.
    pub fn wait_until_ready(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        let url = format!("http://127.0.0.1:{}/api/control/status", self.port);
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_millis(250))
            .timeout_read(Duration::from_millis(500))
            .build();
        loop {
            // Even a 4xx counts as "the server is up enough to answer".
            // We're not validating the body, just the TCP handshake +
            // any HTTP response.
            if agent.get(&url).call().is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "sidecar did not become ready before timeout",
                ));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Best-effort SIGTERM. Called from the Tauri exit hook. The OS
    /// will clean up if we don't get here (process group ties the
    /// sidecar to our pid on macOS / Linux), but explicit is better.
    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Process-wide handle to the active sidecar's port. Set once at
/// startup; read by `mesh::preferred_url` and the menu actions that
/// need to construct controller URLs (Open Chat, Reload).
static SIDECAR_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

pub fn record_port(port: u16) {
    let _ = SIDECAR_PORT.set(port);
}

pub fn current_port() -> Option<u16> {
    SIDECAR_PORT.get().copied()
}
