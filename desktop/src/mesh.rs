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
///
/// On macOS, before starting the service, we also self-heal the launchd
/// agent's plist. There are two failure modes we observed in the wild:
///
///   1. The user installed the CLI a long time ago (pre-`--auto`/`--join-url`
///      plumbing), so the plist runs `closedmesh serve --headless` with no
///      mesh-discovery flags and the node lives in its own private mesh.
///   2. The user has a current `install.sh`-written plist that uses the new
///      `--join-url https://mesh.closedmesh.com/api/status` flag, but their
///      installed CLI binary predates the flag (e.g. they upgraded the .app
///      without re-running the installer, or they're running a release that
///      shipped before the flag landed). Their service crashes on launch
///      with `error: unexpected argument '--join-url'`.
///
/// Both paths leave `closedmesh.com` showing "0 models" while the user's Mac
/// is in fact running a model — just on the wrong mesh. The fix is to write
/// a plist with arguments the *installed binary* actually understands, and
/// to re-bootstrap the launchd agent. We do this on every launch so users
/// always get the canonical mesh without ever running a terminal command.
pub fn start_service_if_installed() {
    if let Some(bin) = locate_binary() {
        #[cfg(target_os = "macos")]
        repair_launchd_plist(&bin);
        let _ = bin;
        start_service();
    }
}

pub fn start_service() {
    run_cli(&["service", "start"]);
}

pub fn stop_service() {
    run_cli(&["service", "stop"]);
}

// ---------- Launchd self-healing (macOS) --------------------------------

#[cfg(target_os = "macos")]
const SERVICE_LABEL: &str = "dev.closedmesh.closedmesh";

#[cfg(target_os = "macos")]
const ENTRY_STATUS_URL: &str = "https://mesh.closedmesh.com/api/status";

/// Rewrites `~/Library/LaunchAgents/dev.closedmesh.closedmesh.plist` so the
/// service uses arguments compatible with the installed `closedmesh` binary,
/// then bounces the launchd agent. A no-op if we can't locate `$HOME` or if
/// rewriting fails; the user falls back to whatever plist they had, which
/// is no worse than today.
#[cfg(target_os = "macos")]
fn repair_launchd_plist(bin: &std::path::Path) {
    let Some(plist_path) = launchd_plist_path() else { return };

    let supports_join_url = cli_supports_join_url(bin);
    let join_args: Vec<String> = if supports_join_url {
        vec![
            "--join-url".to_string(),
            ENTRY_STATUS_URL.to_string(),
        ]
    } else {
        match fetch_entry_token() {
            Some(token) => vec!["--join".to_string(), token],
            // Couldn't reach the entry node and the binary doesn't support
            // --join-url; we can still write a plist that auto-discovers
            // via Nostr. Worse than joining the canonical mesh directly,
            // but better than leaving a broken `--join-url` arg in place.
            None => Vec::new(),
        }
    };

    let xml = build_launchd_plist_xml(bin, &join_args);

    // Atomic rewrite: write to a sibling tmp file and rename. Avoids a
    // half-written plist if the desktop app is killed mid-write.
    let tmp_path = plist_path.with_extension("plist.tmp");
    if let Some(parent) = plist_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&tmp_path, xml.as_bytes()).is_err() {
        return;
    }
    if std::fs::rename(&tmp_path, &plist_path).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }

    bounce_launchd_agent(&plist_path);
}

#[cfg(target_os = "macos")]
fn launchd_plist_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library")
            .join("LaunchAgents")
            .join(format!("{SERVICE_LABEL}.plist"))
    })
}

/// Probes `closedmesh serve --help` for the `--join-url` token. Cheap (a
/// fork+exec of our own binary printing static help text) and avoids
/// hard-coding a CLI version the desktop has to keep in sync with.
#[cfg(target_os = "macos")]
fn cli_supports_join_url(bin: &std::path::Path) -> bool {
    let Ok(output) = Command::new(bin).args(["serve", "--help"]).output() else {
        return false;
    };
    let combined: Vec<u8> = output
        .stdout
        .into_iter()
        .chain(output.stderr.into_iter())
        .collect();
    String::from_utf8_lossy(&combined).contains("--join-url")
}

/// One-shot HTTPS GET to the canonical entry node's status endpoint.
/// We deliberately use short timeouts: the desktop is on the launch path
/// and we'd rather start with auto-discovery only than block the GUI for
/// 30s if the user's offline.
#[cfg(target_os = "macos")]
fn fetch_entry_token() -> Option<String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(4))
        .build();
    let payload: InvitePayload = agent
        .get(ENTRY_STATUS_URL)
        .call()
        .ok()?
        .into_json()
        .ok()?;
    payload
        .token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Mirrors the plist `install.sh` writes today, but with the
/// `ProgramArguments` array constructed from `join_args` so the same
/// codepath handles `--join-url`, `--join <token>`, or no join flag at
/// all (Nostr-only fallback).
#[cfg(target_os = "macos")]
fn build_launchd_plist_xml(bin: &std::path::Path, join_args: &[String]) -> String {
    let home = dirs::home_dir()
        .map(|h| h.display().to_string())
        .unwrap_or_else(|| "/".to_string());
    let log_dir = format!("{home}/Library/Logs/closedmesh");

    let mut program_args = vec![
        bin.display().to_string(),
        "serve".to_string(),
        "--auto".to_string(),
        "--mesh-name".to_string(),
        "closedmesh".to_string(),
    ];
    program_args.extend(join_args.iter().cloned());
    program_args.push("--headless".to_string());

    let args_xml = program_args
        .iter()
        .map(|a| format!("        <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{args}
    </array>
    <key>WorkingDirectory</key>
    <string>{home}</string>
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
    <string>{log_dir}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/stderr.log</string>
</dict>
</plist>
"#,
        label = SERVICE_LABEL,
        args = args_xml,
        home = xml_escape(&home),
        log_dir = xml_escape(&log_dir),
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `launchctl bootout` (idempotent — succeeds whether or not the agent is
/// loaded) followed by `launchctl bootstrap` to pick up the rewritten
/// plist. We swallow errors: the worst case is the next `closedmesh
/// service start` call below picks it up, or the service stays on its
/// previous args until the next launch.
#[cfg(target_os = "macos")]
fn bounce_launchd_agent(plist_path: &std::path::Path) {
    let uid = current_uid();
    let target = format!("gui/{uid}");
    let label_target = format!("{target}/{SERVICE_LABEL}");

    let _ = Command::new("launchctl")
        .args(["bootout", &label_target])
        .output();

    let plist_str = plist_path.display().to_string();
    let _ = Command::new("launchctl")
        .args(["bootstrap", &target, &plist_str])
        .output();
}

#[cfg(target_os = "macos")]
fn current_uid() -> u32 {
    // `id -u` is a 1-process fork that prints the numeric UID. We avoid
    // adding a libc dep just for `getuid()` — this codepath runs once at
    // launch and the cost is negligible.
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
        })
        .unwrap_or(501)
}

/// Reads the `keepMeshRunningAfterQuit` toggle from the controller's
/// settings file. The Settings page writes to this same JSON, so the
/// preference is shared without any IPC. Returns `false` (the default
/// — i.e. "stop the runtime on quit") when the file is missing,
/// unparseable, or the field is absent. We deliberately don't depend
/// on `serde_json` for this one bool: a regex is robust enough and
/// keeps the desktop binary lean.
pub fn keep_running_after_quit() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let path = home.join(".closedmesh").join("controller-settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    // Tolerant scan — handles `"keepMeshRunningAfterQuit":true` and
    // `"keepMeshRunningAfterQuit": true` and trailing comma variants.
    // serde_json would be 30 LoC less but pulls in another dep.
    let needle = "\"keepMeshRunningAfterQuit\"";
    let Some(idx) = raw.find(needle) else {
        return false;
    };
    let after = &raw[idx + needle.len()..];
    // Skip the colon + whitespace, then look for the literal `true` /
    // `false` token.
    let trimmed = after.trim_start_matches([':', ' ', '\t', '\n', '\r']);
    trimmed.starts_with("true")
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
