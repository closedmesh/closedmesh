//! Talks to the local `closedmesh` runtime — both the admin HTTP API for
//! status, and the `closedmesh` CLI for service control. Mirrors what the
//! deprecated Swift `MeshService.swift` did, but cross-platform.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

#[derive(Debug, Deserialize, Default)]
struct InvitePayload {
    #[serde(default)]
    token: Option<String>,
}

/// Snapshot of the local mesh state, polled from `127.0.0.1:3131/api/status`
/// every few seconds and rendered into the tray tooltip + title.
///
/// `PartialEq` is load-bearing: the tray applies a fresh status to the
/// `NSStatusItem`'s menu only when something actually changed. Replacing
/// the menu mid-track on macOS dismisses an open menu (AppKit drops the
/// `NSMenuTracking` when the menu pointer flips), so blind 5-second
/// rebuilds make the menu look like it "closes on hover".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MeshStatus {
    pub online: bool,
    pub node_count: usize,
    pub model: Option<String>,
    pub backend: Option<String>,
}

/// Loose deserialization shim for the admin payload. The real schema is
/// richer (see `app/api/status/route.ts`); we only pluck the fields we
/// surface in the tray. Anything missing falls back to a default — the
/// admin API has churned a couple of times during early development and
/// we'd rather degrade gracefully than crash on a missing field.
#[derive(Debug, Deserialize, Default)]
struct StatusPayload {
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    node_count: Option<usize>,
    #[serde(default)]
    nodes: Option<Vec<NodeRow>>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    loaded_models: Option<Vec<String>>,
    #[serde(default)]
    capability: Option<Capability>,
}

#[derive(Debug, Deserialize, Default)]
struct NodeRow {
    #[serde(default)]
    capability: Option<Capability>,
}

#[derive(Debug, Deserialize, Default)]
struct Capability {
    #[serde(default)]
    backend: Option<String>,
}

const ADMIN_STATUS_URL: &str = "http://127.0.0.1:3131/api/status";
const LEGACY_LOCAL_CONTROLLER_URL: &str = "http://localhost:3000";
const REMOTE_CHAT_URL: &str = "https://closedmesh.com";

/// Returns the URL the WebView should load.
///
/// Order (after Phase 8b — the sidecar is now the default):
///   1. `CLOSEDMESH_APP_URL` env var (dev / staging override)
///   2. `http://127.0.0.1:<sidecar_port>` if the bundled Next.js
///      controller spawned successfully (the common case)
///   3. `http://localhost:3000` if a user-installed launchd controller
///      is still around from before the sidecar (legacy install) AND it
///      positively identifies as a closedmesh controller
///   4. `https://closedmesh.com` as a marketing/install fallback
pub fn preferred_url() -> String {
    if let Ok(u) = std::env::var("CLOSEDMESH_APP_URL") {
        if !u.is_empty() {
            return u;
        }
    }
    if let Some(port) = crate::sidecar::current_port() {
        return format!("http://127.0.0.1:{port}");
    }
    if legacy_controller_up() {
        return LEGACY_LOCAL_CONTROLLER_URL.to_string();
    }
    REMOTE_CHAT_URL.to_string()
}

/// Header the closedmesh controller stamps onto `/api/control/status`
/// responses. The desktop shell looks for it before trusting whatever's on
/// `:3000` to be ours — without the marker we'd happily load an unrelated
/// Next.js / Vite / static server the user happens to be running on the
/// same port into the WebView, which is a confusing failure that's worse
/// than just falling through to closedmesh.com.
const CONTROLLER_HEADER: &str = "x-closedmesh-controller";

/// HTTP probe of `:3000` that *positively* confirms it's the closedmesh
/// controller, not just any server willing to accept a TCP connection.
/// We deliberately don't fall back to a bare TCP probe — a "yes it answered"
/// from someone else's Next.js dev server is exactly the failure we're
/// trying to avoid here.
fn legacy_controller_up() -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(250))
        .timeout_read(Duration::from_millis(750))
        .build();
    match agent
        .get("http://127.0.0.1:3000/api/control/status")
        .call()
    {
        Ok(resp) => resp.header(CONTROLLER_HEADER).is_some(),
        Err(_) => false,
    }
}

/// Where the controller writes stdout/stderr logs. Used by `Sidecar` to
/// redirect Node's output, and by the tray "Show Logs" menu item to
/// reveal the dir in Finder / Explorer / xdg-open.
pub fn default_log_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Logs/closedmesh"))
    } else if cfg!(target_os = "linux") {
        Some(home.join(".local/state/closedmesh"))
    } else {
        dirs::data_dir().map(|d| d.join("closedmesh").join("logs"))
    }
}

/// One status poll. Returns `MeshStatus::default()` (offline) on any error
/// — the caller renders that as "no mesh detected", which is the right
/// answer whether the runtime is missing, crashed, or just starting up.
pub fn fetch_status() -> MeshStatus {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(800))
        .timeout_read(Duration::from_millis(1500))
        .build();

    let payload: StatusPayload = match agent.get(ADMIN_STATUS_URL).call() {
        Ok(resp) => match resp.into_json() {
            Ok(p) => p,
            Err(_) => return MeshStatus::default(),
        },
        Err(_) => return MeshStatus::default(),
    };

    let node_count = payload
        .node_count
        .or_else(|| payload.nodes.as_ref().map(|n| n.len()))
        .unwrap_or_else(|| if payload.online == Some(true) { 1 } else { 0 });

    let model = payload
        .model
        .or_else(|| payload.models.as_ref().and_then(|m| m.first().cloned()))
        .or_else(|| payload.loaded_models.as_ref().and_then(|m| m.first().cloned()));

    let backend = payload
        .capability
        .as_ref()
        .and_then(|c| c.backend.clone())
        .or_else(|| {
            payload
                .nodes
                .as_ref()
                .and_then(|n| n.first())
                .and_then(|n| n.capability.as_ref())
                .and_then(|c| c.backend.clone())
        });

    MeshStatus {
        online: node_count > 0,
        node_count,
        model,
        backend,
    }
}

// ---------- Service control ---------------------------------------------

/// Best-effort `closedmesh service start` on launch. Silently no-ops if
/// the CLI isn't installed yet — the user just gets the offline empty
/// state (handled by the chat UI) until they install it.
pub fn start_service_if_installed() {
    if locate_binary().is_some() {
        start_service();
    }
}

pub fn start_service() {
    run_cli(&["service", "start"]);
}

pub fn stop_service() {
    run_cli(&["service", "stop"]);
}

/// Returns the local node's join token — the value a teammate pastes on
/// their machine to join this mesh. The runtime mints the token at startup
/// and publishes it on the admin status endpoint; there is intentionally no
/// `closedmesh invite create` CLI subcommand because the token is just an
/// addressable identity for the local node, regenerated each time the
/// service starts. Same value the CLI consumes via `--join <token>`.
pub fn create_invite() -> Option<String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(800))
        .timeout_read(Duration::from_millis(1500))
        .build();
    let payload: InvitePayload = agent.get(ADMIN_STATUS_URL).call().ok()?.into_json().ok()?;
    payload
        .token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Returns a path to reveal in the OS file browser when the user picks
/// "Show Logs" from the tray. The runtime + installer + sidecar all
/// write logs to the platform-specific dir returned by
/// `default_log_dir()`; this just additionally filters on existence so
/// we don't open an empty Finder window pre-first-launch.
pub fn log_dir() -> Option<PathBuf> {
    let candidate = default_log_dir()?;
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

// ---------- Binary discovery --------------------------------------------

/// Resolves the `closedmesh` binary. Order matches the deprecated Swift
/// implementation, plus Windows-specific install locations.
fn locate_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CLOSEDMESH_BIN") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/closedmesh"));
        if cfg!(windows) {
            candidates.push(home.join(".local/bin/closedmesh.exe"));
            candidates.push(home.join("AppData/Local/closedmesh/closedmesh.exe"));
        }
    }
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/bin/closedmesh"));
        candidates.push(PathBuf::from("/usr/local/bin/closedmesh"));
    } else if cfg!(target_os = "linux") {
        candidates.push(PathBuf::from("/usr/local/bin/closedmesh"));
        candidates.push(PathBuf::from("/usr/bin/closedmesh"));
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    // Last resort: walk $PATH. `which` is the canonical Unix tool but
    // pulling the `which` crate just for this would be silly.
    if let Ok(path_env) = std::env::var("PATH") {
        let exe_name = if cfg!(windows) {
            "closedmesh.exe"
        } else {
            "closedmesh"
        };
        let separator = if cfg!(windows) { ';' } else { ':' };
        for dir in path_env.split(separator) {
            let candidate = PathBuf::from(dir).join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn run_cli(args: &[&str]) {
    let Some(bin) = locate_binary() else { return };
    // Discard output — the tray polls `:3131/api/status` for ground truth
    // anyway, so the next refresh tells us whether the start/stop took.
    let _ = Command::new(bin).args(args).output();
}
