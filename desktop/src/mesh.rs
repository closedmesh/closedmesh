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
///
/// Field coverage as of v0.65 of the runtime: the runtime's own
/// `127.0.0.1:3131/api/status` exposes `peers` (an array of remote nodes),
/// `models`, `serving_models`, `node_status`, and `capability` — but
/// neither `online` nor `node_count` nor `nodes` (those names are only
/// emitted by the website's higher-level `/api/status` aggregator). The
/// previous version of this struct only knew about the website's names,
/// so against a live runtime the parse would succeed but every field
/// would be `None`, leaving `online: false` — and the tray's Start/Stop
/// menu item permanently stuck on "Start" while the service was very
/// much running.
#[derive(Debug, Deserialize, Default)]
struct StatusPayload {
    #[serde(default)]
    node_count: Option<usize>,
    #[serde(default)]
    nodes: Option<Vec<NodeRow>>,
    /// Runtime emits this; website aggregator emits `nodes` instead.
    /// Either is treated as proof the runtime is up + a way to count
    /// peers.
    #[serde(default)]
    peers: Option<Vec<NodeRow>>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    serving_models: Option<Vec<String>>,
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
    match agent.get("http://127.0.0.1:3000/api/control/status").call() {
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

    // A successful HTTP 200 from the runtime's admin port is itself
    // proof the runtime is up — counting nodes/peers refines the tooltip
    // but doesn't gate the Start/Stop menu item. Treating a parse-able
    // 200 as `online: true` even when the body is unexpected is the
    // safer default; the previous behavior (return `default()` on any
    // missing field) painted "Start ClosedMesh Service" over a service
    // that was actively serving a model.
    let payload: StatusPayload = match agent.get(ADMIN_STATUS_URL).call() {
        Ok(resp) => match resp.into_json() {
            Ok(p) => p,
            Err(_) => {
                return MeshStatus {
                    online: true,
                    node_count: 1,
                    model: None,
                    backend: None,
                };
            }
        },
        Err(_) => return MeshStatus::default(),
    };

    let peer_count = payload
        .peers
        .as_ref()
        .map(|p| p.len())
        .or_else(|| payload.nodes.as_ref().map(|n| n.len()))
        .unwrap_or(0);

    // We talked to the admin port and got JSON back — the runtime is up.
    // `node_count` always includes self (peers + 1), or falls back to
    // the website-aggregator's pre-counted value when the response
    // happens to come from there instead of the runtime directly.
    let node_count = payload.node_count.unwrap_or(peer_count + 1).max(1);

    let model = payload
        .model
        .or(payload.model_name)
        .or_else(|| {
            payload
                .serving_models
                .as_ref()
                .and_then(|m| m.first().cloned())
        })
        .or_else(|| payload.models.as_ref().and_then(|m| m.first().cloned()))
        .or_else(|| {
            payload
                .loaded_models
                .as_ref()
                .and_then(|m| m.first().cloned())
        })
        // Empty placeholders like "(standby)" come back from a router-only
        // entry node when the local runtime is in standby — not useful in
        // the tray title, so suppress them.
        .filter(|m| !m.starts_with('(') && !m.is_empty());

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
        })
        .or_else(|| {
            payload
                .peers
                .as_ref()
                .and_then(|n| n.first())
                .and_then(|n| n.capability.as_ref())
                .and_then(|c| c.backend.clone())
        });

    MeshStatus {
        online: true,
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
    // Locate an existing runtime binary or install a fresh one. When a
    // binary is already present we also verify that it meets the minimum
    // version requirement. Old installs (v0.1.16 era, pre-rc2) may have
    // a binary that predates the --relay / --headless / --join flags we
    // emit in the launchd plist. If the version is too old we delete the
    // binary and let ensure_runtime_installed fetch the current release.
    let bin = match locate_binary() {
        Some(b) => {
            if runtime_meets_minimum(&b) {
                Some(b)
            } else {
                eprintln!(
                    "[closedmesh] runtime at {} is below minimum version; \
                     reinstalling from GitHub releases",
                    b.display()
                );
                let _ = std::fs::remove_file(&b);
                ensure_runtime_installed()
            }
        }
        None => ensure_runtime_installed(),
    };

    if let Some(bin) = bin {
        // Start the runtime immediately with whatever plist exists.
        // We do NOT block here waiting for a token fetch — that can take
        // up to 40s on a cold network, during which the runtime isn't
        // running at all and the user sees a frozen yellow "checking
        // status" circle. The async retry loop below injects --join as
        // soon as a token is available.
        start_service();

        // Self-heal: inject --join token in the background. First
        // attempt fires in 3 s (covers the common case where the
        // network was just a beat behind the app launch). Subsequent
        // attempts at 8 s, 15 s, 30 s, then every 60 s for 15 min,
        // then every 5 min for an hour. Once --join is in the plist the
        // byte-equality guard makes further calls no-ops.
        #[cfg(target_os = "macos")]
        spawn_self_heal_retry_loop(bin.clone());

        let _ = bin;
    }
}

/// Background retry loop for `repair_launchd_plist`.
///
/// Fires at rapidly decreasing intervals initially (3 s, 8 s, 15 s,
/// 30 s) to handle the common "network catches up just after launch"
/// case quickly, then at 60 s intervals for 15 min, then 5 min for an
/// hour. The whole loop lives in a dedicated OS thread; it terminates
/// when the app exits or after the hour is up.
///
/// repair_launchd_plist short-circuits via byte-equality when the plist
/// already matches what we'd write — so a healthy install (plist
/// already has --join from the previous run) costs nothing more than
/// one HTTPS request per interval.
#[cfg(target_os = "macos")]
fn spawn_self_heal_retry_loop(bin: PathBuf) {
    std::thread::spawn(move || {
        // Quick bursts — covers "captive portal cleared" / "DNS just
        // resolved" / "Vercel cold start warmed up" within the first
        // ~30 s of the user's session.
        for secs in [3u64, 8, 15, 30] {
            std::thread::sleep(Duration::from_secs(secs));
            repair_launchd_plist(&bin);
        }
        // Steady phase 1: every 60 s for 15 min.
        for _ in 0..15 {
            std::thread::sleep(Duration::from_secs(60));
            repair_launchd_plist(&bin);
        }
        // Steady phase 2: every 5 min for another 45 min.
        for _ in 0..9 {
            std::thread::sleep(Duration::from_secs(300));
            repair_launchd_plist(&bin);
        }
    });
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

/// Fallback join token baked in at build time.
///
/// The canonical entry node (mesh.closedmesh.com) runs in Docker on AWS
/// Lightsail with a persistent volume that preserves its Iroh identity. Its
/// node ID — and therefore its Iroh ticket — is stable across container
/// restarts. We bake the current token here so that users who can't reach
/// mesh.closedmesh.com (captive portal, restrictive firewall, DNS failure,
/// offline cold start) still get `--join` injected and can connect via the
/// relay leg of the ticket. If the live fetch succeeds it always wins
/// (fresher addresses); the fallback is only used when the HTTP call fails.
///
/// Update this constant whenever the entry node's identity changes (i.e. the
/// Lightsail instance or Docker volume is rebuilt from scratch).
#[cfg(target_os = "macos")]
const FALLBACK_JOIN_TOKEN: &str = "eyJpZCI6IjczNGVkYjJhMWRhMjQ0OWMyZWIyNGQyMzBjNDZkMDE0YTRkOWY2MmVmY2JkYjJlYmRmNzlmM2NiMGMyNzFhZmUiLCJhZGRycyI6W3siUmVsYXkiOiJodHRwczovL3VzZTEtMS5yZWxheS5uMC5pcm9oLWNhbmFyeS5pcm9oLmxpbmsuLyJ9LHsiSXAiOiIzLjIxMC4zMC41ODo1MTgyMCJ9LHsiSXAiOiIxNzIuMTcuMC4xOjUxODIwIn0seyJJcCI6IjE3Mi4yNi4zLjkxOjUxODIwIn0seyJJcCI6IlsyNjAwOjFmMTg6NTI2Zjo0OTAwOjY4NjU6YzY4NzoxYTc0OjRiOWJdOjU2NDA0In1dfQ";

/// Public Iroh relays we explicitly hand to the runtime via `--relay`.
///
/// closedmesh-llm v0.65.0-rc2 (the latest published release at the time
/// of writing) hard-codes a default relay map of
/// `*.michaelneale.mesh-llm.iroh.link` URLs that no longer resolve, so
/// without an override the runtime can't punch through NAT to reach the
/// public entry node — which is exactly the failure that surfaces on
/// `closedmesh.com` as "Mesh online · 0 models" even when a user is
/// running a model locally. Until the runtime ships a fix we override
/// the relay map at the launchd plist level. n0's canary relays are
/// public and operationally maintained by the iroh team.
#[cfg(target_os = "macos")]
const DEFAULT_RELAYS: &[&str] = &[
    "https://use1-1.relay.n0.iroh-canary.iroh.link./",
    "https://euw-1.relay.n0.iroh-canary.iroh.link./",
];

/// Rewrites `~/Library/LaunchAgents/dev.closedmesh.closedmesh.plist` so the
/// service uses arguments compatible with the installed `closedmesh` binary,
/// then bounces the launchd agent. A no-op if we can't locate `$HOME` or if
/// rewriting fails; the user falls back to whatever plist they had, which
/// is no worse than today.
///
/// Strategy:
///   1. Probe the installed CLI for `--join-url` support (added in
///      closedmesh-llm v0.65.0). If present, embed the canonical entry
///      URL — the runtime then re-fetches the token on every restart,
///      which means an entry-node restart that rotates its node id
///      doesn't permanently strand existing installs.
///   2. Otherwise (older CLI), fetch a token from the entry's HTTP API
///      *now* and embed it as a literal `--join <token>`. This copy of
///      the token is good for as long as the entry's node id is stable;
///      after that the user's next desktop launch will refresh it.
///   3. If both strategies fail (no `--join-url`, no reachable entry),
///      we still write a plist with `--auto --publish` so the service
///      at least advertises itself on Nostr and other peers can find
///      it via auto-discovery — strictly better than the previous
///      behavior of writing a private-by-default plist.
#[cfg(target_os = "macos")]
fn repair_launchd_plist(bin: &std::path::Path) {
    let Some(plist_path) = launchd_plist_path() else {
        return;
    };

    let supports_join_url = cli_supports_join_url(bin);
    let join_args: Vec<String> = if supports_join_url {
        vec!["--join-url".to_string(), ENTRY_STATUS_URL.to_string()]
    } else {
        // fetch_entry_token always returns a token — either live from
        // mesh.closedmesh.com or the built-in fallback. Either way we
        // always get --join in the plist.
        let token = fetch_entry_token();
        vec!["--join".to_string(), token]
    };

    let xml = build_launchd_plist_xml(bin, &join_args);

    let existing = std::fs::read(&plist_path).ok();

    // If the plist is already byte-identical to what we'd write, skip
    // the rewrite entirely. Avoids a needless launchd bounce on every
    // app launch (which would race against a freshly-started runtime).
    if let Some(bytes) = &existing {
        if bytes == xml.as_bytes() {
            return;
        }
    }

    // Some users (and at least one previous incarnation of this code,
    // when manually patching plists during outages) set `chflags uchg`
    // on the plist to lock it. Best-effort clear that flag before we
    // try to rewrite — if the user really did intend it as a hard lock,
    // chflags will succeed but std::fs::write may still fail, and we
    // early-return.
    let _ = Command::new("chflags")
        .args(["nouchg"])
        .arg(&plist_path)
        .output();

    let tmp_path = plist_path.with_extension("plist.tmp");
    if let Some(parent) = plist_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&tmp_path, xml.as_bytes()) {
        eprintln!(
            "[closedmesh] self-heal: failed to write {}: {e}",
            tmp_path.display()
        );
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, &plist_path) {
        eprintln!(
            "[closedmesh] self-heal: failed to rename {} -> {}: {e}",
            tmp_path.display(),
            plist_path.display()
        );
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }

    // Loud success message so an operator tailing stderr.log knows when
    // self-heal finally took. Especially useful for the retry-loop case
    // where the *first* launch failed to fetch the token but a later
    // attempt converged — without this log, success looks identical to
    // "nothing changed" in the byte-equality short-circuit above.
    let join_kind = if join_args
        .iter()
        .any(|a| a == "--join-url")
    {
        "--join-url"
    } else if join_args.iter().any(|a| a == "--join") {
        "--join <token>"
    } else {
        "Nostr-only fallback (no token fetched)"
    };
    eprintln!(
        "[closedmesh] self-heal: wrote plist with {join_kind}; bouncing launchd"
    );

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
///
/// Logs each failure mode to stderr (which lands in
/// `~/Library/Logs/closedmesh/stderr.log` once launchd takes over the
/// process). The previous implementation used `.ok()?` to swallow every
/// error — when this silently returned `None` for a v0.1.16 user we had
/// no way to tell whether DNS, TLS, the HTTP fetch, or the JSON decode
/// was the problem, and the user's plist quietly fell back to a private
/// mesh of one.
#[cfg(target_os = "macos")]
fn fetch_entry_token() -> String {
    // 5 s connect, 10 s read. Each attempt is called from the retry loop
    // (T+3 s, T+8 s, T+15 s, T+30 s, then every 60 s) so a slow attempt
    // doesn't stall the next try for long.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .build();

    let live = (|| {
        let resp = agent.get(ENTRY_STATUS_URL).call().map_err(|e| {
            eprintln!("[closedmesh] self-heal: GET {ENTRY_STATUS_URL} failed: {e}");
            e.to_string()
        })?;
        let payload: InvitePayload = resp.into_json().map_err(|e| {
            eprintln!("[closedmesh] self-heal: parse {ENTRY_STATUS_URL} body failed: {e}");
            e.to_string()
        })?;
        let t = payload
            .token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        t.ok_or_else(|| {
            eprintln!("[closedmesh] self-heal: {ENTRY_STATUS_URL} returned no `token` field");
            "no token field".to_string()
        })
    })();

    match live {
        Ok(t) => {
            eprintln!("[closedmesh] self-heal: fetched live entry token");
            t
        }
        Err(_) => {
            eprintln!(
                "[closedmesh] self-heal: live fetch failed — using built-in fallback token \
                 (relay-based connection will still work)"
            );
            FALLBACK_JOIN_TOKEN.to_string()
        }
    }
}

/// Mirrors the plist `install.sh` writes today, but with the
/// `ProgramArguments` array constructed from `join_args` so the same
/// codepath handles `--join-url`, `--join <token>`, or no join flag at
/// all (Nostr-only fallback).
///
/// `--publish` is required even when joining via `--join` / `--join-url`:
/// without it, the local node is in private mode and won't broadcast
/// itself on Nostr — meaning peers (and the public entry node behind
/// `mesh.closedmesh.com`) can't discover it, and `closedmesh.com` shows
/// "0 models" even though we successfully joined the canonical mesh.
/// This was the headline bug in v0.1.16.
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
        "--publish".to_string(),
        "--mesh-name".to_string(),
        "closedmesh".to_string(),
    ];
    program_args.extend(join_args.iter().cloned());
    for relay in DEFAULT_RELAYS {
        program_args.push("--relay".to_string());
        program_args.push((*relay).to_string());
    }
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


// ---------- Runtime auto-install ----------------------------------------

/// GitHub "latest release" asset URL for the closedmesh-llm runtime. The
/// `/releases/latest/download/<asset>` shape redirects to whatever GitHub
/// currently considers the latest non-prerelease — meaning desktop builds
/// don't have to know specific tag names, the runtime can ship updates
/// independently, and the desktop self-installer picks them up on the
/// next first-launch (or any launch where the user has nuked the binary).
const RUNTIME_RELEASE_BASE: &str =
    "https://github.com/closedmesh/closedmesh-llm/releases/latest/download";

/// Return `true` if the installed runtime binary is new enough to support
/// all the flags we emit in the launchd plist (`--relay`, `--join`,
/// `--headless`, `--publish`). The minimum acceptable version is
/// `0.65.0-rc2`; anything older (rc1, 0.64.x, …) gets replaced.
///
/// We call `closedmesh --version`, parse the `major.minor.patch` triplet
/// from the first token that looks like a semantic version, and compare
/// against the threshold (0, 65, 0). The pre-release suffix is handled
/// as a special case: among 0.65.0 pre-releases only rc2 and above are
/// accepted (rc1 lacked `--relay` support).
///
/// Any binary that refuses to run, produces no version output, or has an
/// unparseable version string is conservatively rejected so it gets
/// replaced with a known-good download.
fn runtime_meets_minimum(bin: &std::path::Path) -> bool {
    let out = match Command::new(bin).arg("--version").output() {
        Ok(o) => o,
        Err(e) => {
            eprintln!(
                "[closedmesh] runtime version check failed ({}): {e}",
                bin.display()
            );
            return false;
        }
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    eprintln!("[closedmesh] runtime reports version: {text:?}");

    // Find the first substring that looks like "MAJOR.MINOR.PATCH…"
    let version_token = text
        .split_whitespace()
        .find(|t| t.chars().next().map_or(false, |c| c.is_ascii_digit()))
        .unwrap_or(text);

    // Parse "0.65.0-rc2" → (0, 65, 0, Some("rc2"))
    let (maj, min, patch, pre) = parse_semver(version_token);

    // Accept any version that is strictly greater than 0.65.0, or is
    // exactly 0.65.0 without a pre-release suffix, or is exactly
    // 0.65.0-rc2.
    if (maj, min, patch) > (0, 65, 0) {
        return true;
    }
    if (maj, min, patch) == (0, 65, 0) {
        return match pre.as_deref() {
            None => true,            // 0.65.0 full release
            Some("rc2") => true,    // exact minimum we need
            Some(_) => false,       // rc1 or any other pre-release
        };
    }
    // (maj, min, patch) < (0, 65, 0) — definitely too old
    false
}

/// Parse "0.65.0-rc2" into (0u32, 65u32, 0u32, Some("rc2")).
/// Returns (0, 0, 0, None) for any unparseable input.
fn parse_semver(s: &str) -> (u32, u32, u32, Option<String>) {
    let (numeric, pre) = match s.find('-') {
        Some(i) => (&s[..i], Some(s[i + 1..].to_string())),
        None => (s, None),
    };
    let parts: Vec<u32> = numeric
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    let maj = parts.first().copied().unwrap_or(0);
    let min = parts.get(1).copied().unwrap_or(0);
    let patch = parts.get(2).copied().unwrap_or(0);
    (maj, min, patch, pre)
}

/// First-launch installer for the `closedmesh` CLI runtime.
///
/// The .app is a thin shell — it talks to a separate runtime binary that
/// does the real work (joining the mesh, hosting llama.cpp, exposing the
/// admin/OpenAI APIs). For the longest time the runtime had to be installed
/// separately via `curl … | sh`, which means a "download the .app and chat"
/// pitch to non-technical users hit a wall the moment they opened the app.
///
/// This function closes that gap: if `locate_binary` came up empty, we
/// fetch the platform-appropriate tarball from the latest closedmesh-llm
/// GitHub release, extract it into `~/.local/bin/closedmesh`, and return
/// the resolved path. The caller (`start_service_if_installed`) then runs
/// the normal launchd self-heal + service start on it.
///
/// Failure modes (all return `None`):
///   - Unsupported platform (no published asset for our OS/arch).
///   - Network / GitHub failure (offline, rate limit).
///   - Tarball extraction failure (corrupt download, missing `tar`).
///
/// In all of those cases we land in the same "service not running"
/// branch we'd have hit without the auto-installer — strictly an
/// improvement over the previous behavior.
fn ensure_runtime_installed() -> Option<PathBuf> {
    let asset = runtime_asset_name()?;
    let dest = runtime_install_path()?;

    if dest.is_file() {
        // Race: someone (e.g. a parallel `install.sh` run) put the binary
        // in place while we were probing. Use it.
        return Some(dest);
    }

    eprintln!("[closedmesh] runtime not found; fetching {asset} from GitHub releases");

    let url = format!("{RUNTIME_RELEASE_BASE}/{asset}");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(120))
        .redirects(8)
        .build();

    let resp = match agent.get(&url).call() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[closedmesh] runtime download failed: GET {url}: {e}");
            return None;
        }
    };

    // Stream the tarball into a temp file in the same dir we'll extract
    // to, so the rename/move at the end is on the same filesystem.
    let parent = dest.parent()?;
    let _ = std::fs::create_dir_all(parent);
    let tmp_archive = parent.join(format!(".closedmesh.{asset}.partial"));

    let mut reader = resp.into_reader();
    let mut tmp_file = match std::fs::File::create(&tmp_archive) {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "[closedmesh] runtime install: create {} failed: {e}",
                tmp_archive.display()
            );
            return None;
        }
    };
    if let Err(e) = std::io::copy(&mut reader, &mut tmp_file) {
        eprintln!("[closedmesh] runtime download: stream failed: {e}");
        let _ = std::fs::remove_file(&tmp_archive);
        return None;
    }
    drop(tmp_file);

    let extracted_ok = if asset.ends_with(".tar.gz") {
        extract_tar_gz(&tmp_archive, parent)
    } else if asset.ends_with(".zip") {
        extract_zip(&tmp_archive, parent)
    } else {
        eprintln!("[closedmesh] runtime install: unknown archive type for {asset}");
        false
    };

    let _ = std::fs::remove_file(&tmp_archive);

    if !extracted_ok {
        return None;
    }

    if !dest.is_file() {
        eprintln!(
            "[closedmesh] runtime install: extraction succeeded but {} is missing",
            dest.display()
        );
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&dest) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&dest, perm);
        }
    }

    // macOS Gatekeeper quarantines binaries downloaded by a quarantined
    // .app. The runtime would refuse to launch with "killed: 9" on first
    // try and only work after the user did the System Settings -> Open
    // Anyway dance. Strip the attribute if it's there — best-effort,
    // non-fatal.
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&dest)
            .output();
    }

    eprintln!("[closedmesh] runtime installed at {}", dest.display());
    Some(dest)
}

/// GitHub release asset name for our build target. `None` means we don't
/// publish a runtime for this platform yet — the caller should leave the
/// binary uninstalled and the user falls through to the chat-from-website
/// experience instead of running a node locally.
fn runtime_asset_name() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("closedmesh-darwin-aarch64.tar.gz")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("closedmesh-darwin-x86_64.tar.gz")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("closedmesh-linux-x86_64.tar.gz")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("closedmesh-linux-aarch64.tar.gz")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("closedmesh-windows-x86_64.zip")
    } else {
        None
    }
}

/// Where the auto-installer puts the binary. Matches the locations
/// `locate_binary` already searches, so a successful install is
/// transparent to the rest of the codebase.
fn runtime_install_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".local").join("bin");
    let name = if cfg!(windows) {
        "closedmesh.exe"
    } else {
        "closedmesh"
    };
    Some(dir.join(name))
}

/// Extracts a `.tar.gz` archive into `dest_dir`, expecting the bundled
/// `closedmesh` binary at the archive root. We shell out to `tar`
/// because every platform we target ships it (macOS, Linux, and
/// Windows 10 1803+), and pulling in `flate2` + `tar` crates would
/// double the desktop binary size for one-shot first-launch use.
fn extract_tar_gz(archive: &std::path::Path, dest_dir: &std::path::Path) -> bool {
    let output = match Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(dest_dir)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[closedmesh] runtime install: spawn `tar` failed: {e}");
            return false;
        }
    };
    if !output.status.success() {
        eprintln!(
            "[closedmesh] runtime install: tar -xzf failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return false;
    }
    true
}

/// Same as `extract_tar_gz` but for `.zip` (Windows runtime artifacts).
/// Windows 10 1803+ ships a `tar` that handles `.zip`, so we use the
/// same tool everywhere instead of plumbing a separate code path.
fn extract_zip(archive: &std::path::Path, dest_dir: &std::path::Path) -> bool {
    let output = match Command::new("tar")
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(dest_dir)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[closedmesh] runtime install: spawn `tar` failed (zip): {e}");
            return false;
        }
    };
    if !output.status.success() {
        eprintln!(
            "[closedmesh] runtime install: tar -xf (zip) failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return false;
    }
    true
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
