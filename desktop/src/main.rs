// On Windows, prevent a console window from popping up alongside the GUI.
// (No effect on macOS / Linux.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mesh;
mod sidecar;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use crate::mesh::MeshStatus;
use crate::sidecar::Sidecar;

/// IDs for the dynamic menu items we have to rebuild every poll cycle
/// (because the Start/Stop label flips with online state).
const MENU_OPEN: &str = "open_app";
const MENU_OPEN_CHAT: &str = "open_chat";
const MENU_RELOAD: &str = "reload";
const MENU_ADMIN: &str = "open_admin";
const MENU_START: &str = "start_service";
const MENU_STOP: &str = "stop_service";
const MENU_INVITE: &str = "copy_invite";
const MENU_LOGS: &str = "show_logs";
const MENU_QUIT: &str = "quit";

const MAIN_WINDOW: &str = "main";

/// Shared state held by the tray builder and the polling task. We keep the
/// last status under a `Mutex` so the menu rebuild on each poll can read
/// "are we online?" without re-fetching.
struct AppState {
    last_status: Mutex<MeshStatus>,
    /// The bundled Next.js controller sidecar (None during dev runs that
    /// pass `CLOSEDMESH_APP_URL` to bypass it, or if the sidecar failed
    /// to spawn — we degrade to the fallback URL chain in that case).
    sidecar: Mutex<Option<Arc<Sidecar>>>,
}

fn main() {
    let state = Arc::new(AppState {
        last_status: Mutex::new(MeshStatus::default()),
        sidecar: Mutex::new(None),
    });

    let setup_state = state.clone();
    let exit_state = state.clone();

    tauri::Builder::default()
        .setup(move |app| {
            // Wipe the WKWebView cache on first launch of a new version.
            // Each release rebuilds the Next.js controller and produces
            // new chunk hashes; cached HTML from the previous version
            // points at chunk URLs that no longer exist on disk, leaving
            // the user staring at an unstyled page until they manually
            // delete ~/Library/Caches/dev.closedmesh.shell. We track the
            // last-seen version in a tiny stamp file and nuke the cache
            // dirs whenever it changes.
            wipe_webview_cache_on_version_change(app);

            // Spawn the bundled controller as the very first thing — the
            // webview URL we hand to `WebviewWindowBuilder` below depends
            // on whether it came up. We don't fatal-fail on sidecar
            // errors; `mesh::preferred_url` falls back to the public site
            // so the user at least sees the install / marketing page.
            let log_dir = mesh::default_log_dir();

            match Sidecar::spawn(log_dir.as_deref()) {
                Ok(sc) => {
                    eprintln!(
                        "[closedmesh] controller sidecar spawned on http://127.0.0.1:{}",
                        sc.port()
                    );
                    sidecar::record_port(sc.port());
                    // Wait up to 12s for the controller to answer. Cold
                    // start on a slow disk + first-run dependency
                    // resolution can blow past 5s; 12s is the upper bound
                    // we'd accept before the user notices the delay and
                    // we should surface a "loading" state instead.
                    if let Err(e) = sc.wait_until_ready(Duration::from_secs(12)) {
                        eprintln!(
                            "[closedmesh] controller sidecar didn't become ready in time: {e}"
                        );
                    }
                    if let Ok(mut guard) = setup_state.sidecar.lock() {
                        *guard = Some(Arc::new(sc));
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[closedmesh] could not spawn controller sidecar: {e}. Falling back \
                         to closedmesh.com (no local mesh control until installed)."
                    );
                }
            }

            // The .app should land on the mesh control dashboard, not on
            // the public marketing homepage. `mesh::preferred_url()`
            // returns just the base; we append `/dashboard` (the control
            // group's entry point) here. If the bundled controller failed
            // to start and we fell back to closedmesh.com, /dashboard is
            // 404'd by middleware on the public site — that path renders
            // a styled "not found" with a link to /, which is the
            // graceful fallback we want anyway.
            let base = mesh::preferred_url();
            let url = control_entry_url(&base);
            let parsed = url
                .parse()
                .map_err(|e| format!("invalid chat URL `{url}`: {e}"))?;

            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(parsed))
                .title("ClosedMesh")
                .inner_size(1100.0, 760.0)
                .min_inner_size(720.0, 520.0)
                .center()
                .visible(true)
                .build()?;

            build_tray(app, setup_state.clone())?;

            // Best-effort: nudge the runtime into starting if it's installed
            // but stopped. Mirrors the deprecated Swift app's launch flow —
            // double-clicking the icon should "just work" when possible.
            std::thread::spawn(|| mesh::start_service_if_installed());

            // Background poller. We use a dedicated OS thread (rather than
            // tauri::async_runtime::spawn) because `ureq` is blocking and
            // we'd rather not pull in tokio just for this one timer.
            let poll_handle = app.handle().clone();
            let poll_state = setup_state.clone();
            std::thread::spawn(move || status_poll_loop(poll_handle, poll_state));

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the chat window doesn't quit the app — the tray
            // stays alive (this is the standard "lives in the menu bar"
            // pattern). Re-opening is one click on the tray icon.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build ClosedMesh desktop")
        .run(move |_app, event| {
            match event {
                // We honor every ExitRequested now — Cmd+Q on macOS, the
                // tray's "Quit ClosedMesh" item, and `app.exit(0)` all
                // route here, and they all mean the user is done. The
                // tray-only "click X to hide" pattern is enforced by the
                // window-level CloseRequested handler above (which calls
                // `prevent_close()`), so getting here genuinely means
                // exit, not "user closed the window".
                //
                // Older builds called `prevent_exit()` unconditionally,
                // which made Cmd+Q a silent no-op *and* meant the tray's
                // own Quit item didn't really quit either — the GUI
                // disappeared but launchd kept the runtime alive, so
                // closedmesh.com would still report the node online
                // serving inference long after the user thought they'd
                // left the mesh. This block is the load-bearing fix.
                RunEvent::Exit => {
                    // Stop the runtime first. If the user opted into
                    // "Stay in mesh after I quit" on the Settings page,
                    // skip this and the launchd-supervised daemon keeps
                    // serving — that's the explicit "headless always-on
                    // node" mode for users who want it.
                    if !mesh::keep_running_after_quit() {
                        mesh::stop_service();
                    }

                    // Then tear down the bundled controller. macOS will
                    // reap orphans for us, but explicit teardown means
                    // the controller's port is released before relaunch
                    // and we don't accumulate zombie processes during
                    // dev.
                    if let Ok(mut guard) = exit_state.sidecar.lock() {
                        if let Some(sc) = guard.take() {
                            sc.kill();
                        }
                    }
                }
                _ => {}
            }
        });
}

// ---------- Tray --------------------------------------------------------

fn build_tray(app: &tauri::App, state: Arc<AppState>) -> tauri::Result<()> {
    let menu = build_tray_menu(app, &state.last_status.lock().unwrap())?;

    // macOS NSStatusItem-style menu: left-click *and* right-click both
    // open the menu, and the menu's mouse tracker handles hover.
    //
    // The previous build used `show_menu_on_left_click(false)` plus a
    // manual `on_tray_icon_event` handler that called `window.show()`
    // on left-click — Slack-style. That works on Linux/Windows but
    // fights AppKit on macOS: the manual click swallows the event the
    // menu tracker needs to keep itself open while the user moves the
    // cursor onto an item, so the menu closes on hover. We let the
    // standard tracker drive on every platform now, and put "Show
    // ClosedMesh" as the first menu item with a global Cmd+O shortcut
    // so the click-to-open habit still works in two clicks.
    let tray = TrayIconBuilder::with_id("closedmesh-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default tray icon".into()))?,
        )
        .icon_as_template(true)
        .tooltip("ClosedMesh — offline")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event)
        .build(app)?;

    // Stash the tray on app state so the poller can update its menu/tooltip
    // later. Tauri's tray icon is reachable via app_handle.tray_by_id() so
    // we don't need to hold the value here, but we do need to keep the
    // builder result alive past `setup` — Tauri does that internally.
    let _ = tray;
    Ok(())
}

fn build_tray_menu(app: &tauri::App, status: &MeshStatus) -> tauri::Result<Menu<tauri::Wry>> {
    build_tray_menu_for_handle(app.app_handle(), status)
}

fn build_tray_menu_for_handle(
    app: &AppHandle,
    status: &MeshStatus,
) -> tauri::Result<Menu<tauri::Wry>> {
    let header = if status.online {
        format!(
            "ClosedMesh · {} node{} online",
            status.node_count,
            if status.node_count == 1 { "" } else { "s" }
        )
    } else {
        "ClosedMesh · offline".to_string()
    };
    let header_item = MenuItemBuilder::with_id("header", header)
        .enabled(false)
        .build(app)?;

    let mut builder = MenuBuilder::new(app).item(&header_item);

    if let Some(model) = status.model.as_ref() {
        let line = match status.backend.as_ref() {
            Some(b) => format!("Model: {model} · {b}"),
            None => format!("Model: {model}"),
        };
        let model_item = MenuItemBuilder::with_id("model", line).enabled(false).build(app)?;
        builder = builder.item(&model_item);
    }

    builder = builder.separator();
    builder = builder
        .item(&MenuItem::with_id(
            app,
            MENU_OPEN,
            "Show ClosedMesh",
            true,
            Some("CmdOrCtrl+O"),
        )?)
        .item(&MenuItem::with_id(
            app,
            MENU_OPEN_CHAT,
            "Open Chat",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(app, MENU_RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?)
        .item(&MenuItem::with_id(app, MENU_ADMIN, "Open Admin Console", true, None::<&str>)?);

    builder = builder.separator();
    if status.online {
        builder = builder.item(&MenuItem::with_id(
            app,
            MENU_STOP,
            "Stop ClosedMesh Service",
            true,
            None::<&str>,
        )?);
    } else {
        builder = builder.item(&MenuItem::with_id(
            app,
            MENU_START,
            "Start ClosedMesh Service",
            true,
            None::<&str>,
        )?);
    }
    builder = builder
        .item(&MenuItem::with_id(app, MENU_INVITE, "Copy Invite Token", true, None::<&str>)?)
        .item(&MenuItem::with_id(
            app,
            MENU_LOGS,
            "Show Logs in File Manager",
            true,
            None::<&str>,
        )?);

    builder = builder.separator();
    builder = builder.item(&PredefinedMenuItem::about(
        app,
        Some("About ClosedMesh"),
        Some(tauri::menu::AboutMetadata {
            name: Some("ClosedMesh".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            short_version: Some(env!("CARGO_PKG_VERSION").into()),
            authors: None,
            comments: Some(
                "Private LLM mesh on the compute you already own.".into(),
            ),
            copyright: Some("Apache-2.0 / MIT".into()),
            license: Some("Apache-2.0 / MIT".into()),
            website: Some("https://closedmesh.com".into()),
            website_label: Some("closedmesh.com".into()),
            credits: None,
            icon: None,
        }),
    )?);
    builder = builder.item(&MenuItem::with_id(app, MENU_QUIT, "Quit ClosedMesh", true, Some("CmdOrCtrl+Q"))?);

    builder.build()
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        MENU_OPEN_CHAT => {
            // Navigate the main window to /chat and reveal it. The window's
            // base URL is the dashboard; /chat is one of the sidebar
            // sections of the same Next.js app.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
                let base = mesh::preferred_url();
                let target = if base.ends_with('/') {
                    format!("{base}chat")
                } else {
                    format!("{base}/chat")
                };
                let escaped = target.replace('\\', "\\\\").replace('\'', "\\'");
                let _ = window.eval(&format!("window.location.replace('{}')", escaped));
            }
        }
        MENU_RELOAD => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                // Re-resolve the URL so flipping `npm run dev` on/off is
                // picked up without restarting the .app. We navigate via
                // `window.location.replace` (rather than Tauri's
                // `webview.navigate`) because it works the same way across
                // every backing webview engine and doesn't require a
                // mutable handle.
                let url = control_entry_url(&mesh::preferred_url());
                let escaped = url.replace('\\', "\\\\").replace('\'', "\\'");
                let _ = window.eval(&format!("window.location.replace('{}')", escaped));
            }
        }
        MENU_ADMIN => {
            // Admin console always lives at :3131 — the runtime's own
            // topology / request inspector page.
            open_url(app, "http://127.0.0.1:3131");
        }
        MENU_START => {
            std::thread::spawn(|| mesh::start_service());
        }
        MENU_STOP => {
            std::thread::spawn(|| mesh::stop_service());
        }
        MENU_INVITE => {
            let app2 = app.clone();
            std::thread::spawn(move || match mesh::create_invite() {
                Some(token) => {
                    if let Ok(mut clip) = arboard::Clipboard::new() {
                        let _ = clip.set_text(token.clone());
                    }
                    show_toast(
                        &app2,
                        "Invite token copied",
                        &format!(
                            "Share this with a teammate; they run\nclosedmesh serve --join {}",
                            token
                        ),
                    );
                }
                None => show_toast(
                    &app2,
                    "Couldn't create invite",
                    "Is the closedmesh CLI installed and on PATH?",
                ),
            });
        }
        MENU_LOGS => {
            if let Some(path) = mesh::log_dir() {
                let _ = open_path(&path);
            } else {
                open_url(app, "http://127.0.0.1:3131");
            }
        }
        MENU_QUIT => {
            app.exit(0);
        }
        _ => {}
    }
}

// ---------- Polling -----------------------------------------------------

fn status_poll_loop(app: AppHandle, state: Arc<AppState>) {
    // Fast first poll so the tray pill goes green quickly when the runtime
    // is still spinning up after launch.
    let mut interval = Duration::from_millis(1500);
    loop {
        let status = mesh::fetch_status();
        apply_status(&app, &state, &status);
        if status.online && interval < Duration::from_secs(5) {
            interval = Duration::from_secs(5);
        }
        std::thread::sleep(interval);
    }
}

fn apply_status(app: &AppHandle, state: &Arc<AppState>, status: &MeshStatus) {
    // Only push a new menu/tooltip when something visible to the tray
    // actually changed. Replacing `NSStatusItem.menu` while it's being
    // tracked dismisses the open menu on macOS — that's what made the
    // tray appear to close the instant the user hovered over it (the
    // poll fires every ~5s and clobbered the live menu). With no
    // status delta, the previously installed menu keeps tracking
    // cleanly through the user's interaction.
    let changed = {
        let mut guard = state.last_status.lock().unwrap();
        let changed = *guard != *status;
        *guard = status.clone();
        changed
    };
    if !changed {
        return;
    }

    let tooltip = render_tooltip(status);
    if let Some(tray) = app.tray_by_id("closedmesh-tray") {
        let _ = tray.set_tooltip(Some(&tooltip));

        if let Ok(menu) = build_tray_menu_for_handle(app, status) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn render_tooltip(status: &MeshStatus) -> String {
    if !status.online {
        return "ClosedMesh — offline".to_string();
    }
    let mut parts = vec![format!(
        "{} node{} online",
        status.node_count,
        if status.node_count == 1 { "" } else { "s" }
    )];
    if let Some(b) = status.backend.as_ref() {
        parts.push(b.clone());
    }
    if let Some(m) = status.model.as_ref() {
        parts.push(m.clone());
    }
    format!("ClosedMesh — {}", parts.join(" · "))
}

// ---------- Misc helpers ------------------------------------------------

/// Append the control-group entry path (`/dashboard`) to the controller's
/// base URL. Handles both `http://127.0.0.1:3000` and `http://127.0.0.1:3000/`
/// inputs without producing a double slash. When the fallback URL is the
/// public site (https://closedmesh.com), this still produces a valid URL
/// — middleware on the public site renders a 404 with a link back to /,
/// which is acceptable degradation when there's no local controller.
fn control_entry_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    format!("{trimmed}/dashboard")
}

/// Wipe the WKWebView / WebKit2GTK / WebView2 disk cache the first time
/// the user launches a new version of the app.
///
/// Why: the bundled Next.js controller serves HTML referencing chunk
/// URLs like `/_next/static/chunks/<hash>.css`. Those hashes are pinned
/// at build time. WKWebView caches HTML responses aggressively (the
/// prerendered routes used to ship `s-maxage=31536000`), so after an
/// upgrade it'll happily serve the previous version's HTML, which then
/// 404s on every chunk it tries to fetch — the user sees a totally
/// unstyled dashboard with no way to recover short of `rm -rf` in the
/// terminal. Bumping a per-version stamp file forces a clean slate
/// exactly once per version transition.
///
/// We also tightened the controller's `Cache-Control` headers to
/// `no-store` (see `next.config.ts`) so this should be belt-and-braces
/// going forward — but the wipe still rescues users upgrading from
/// older builds that don't have those headers.
fn wipe_webview_cache_on_version_change(app: &tauri::App) {
    let current_version = app.package_info().version.to_string();

    let Some(state_dir) = app
        .path()
        .app_data_dir()
        .ok()
        .or_else(|| app.path().app_config_dir().ok())
    else {
        return;
    };
    if std::fs::create_dir_all(&state_dir).is_err() {
        return;
    }
    let stamp_path = state_dir.join("last-launched-version.txt");

    let previous_version = std::fs::read_to_string(&stamp_path)
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if previous_version == current_version {
        return;
    }

    eprintln!(
        "[closedmesh] version changed ({} -> {}); wiping webview cache",
        if previous_version.is_empty() {
            "<first launch>"
        } else {
            previous_version.as_str()
        },
        current_version
    );

    for cache_dir in webview_cache_dirs() {
        if cache_dir.exists() {
            let _ = std::fs::remove_dir_all(&cache_dir);
        }
    }

    let _ = std::fs::write(&stamp_path, &current_version);
}

/// Best-effort list of disk locations the platform webview engine uses
/// for HTTP cache + service-worker storage. We err on the side of
/// nuking too much rather than too little — these dirs are 100%
/// regeneratable from the .app bundle on next load.
fn webview_cache_dirs() -> Vec<std::path::PathBuf> {
    let bundle_id = "dev.closedmesh.shell";
    let mut out: Vec<std::path::PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = std::path::PathBuf::from(home);
            out.push(home.join("Library/Caches").join(bundle_id));
            out.push(home.join("Library/WebKit").join(bundle_id));
            out.push(
                home.join("Library/Application Support")
                    .join(bundle_id)
                    .join("Cache"),
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(cache) = std::env::var_os("XDG_CACHE_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".cache"))
            })
        {
            out.push(cache.join(bundle_id));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
            let base = std::path::PathBuf::from(local_appdata).join(bundle_id);
            // WebView2's UserData lives under EBWebView; nuke its Cache
            // subtree but keep the rest of the user data dir intact.
            out.push(base.join("EBWebView").join("Default").join("Cache"));
            out.push(base.join("EBWebView").join("Default").join("Code Cache"));
        }
    }

    let _ = bundle_id;
    out
}

fn open_url(_app: &AppHandle, url: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        // `cmd /C start` is the canonical way to open a URL in the default
        // browser without spawning a visible cmd window.
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
}

fn open_path(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map(|_| ())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map(|_| ())
    }
}

/// Tiny modal feedback. Tauri 2's `MessageDialog` would be nicer but
/// requires the `dialog` plugin — not worth the extra dep for two
/// places we surface this. We use `eval` on the main webview to call
/// `alert()` instead. Falls back to no-op if the window is hidden.
fn show_toast(app: &AppHandle, title: &str, body: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        let combined = format!("{title}\n\n{body}");
        let escaped = combined.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n");
        let _ = window.eval(&format!("window.alert('{}')", escaped));
    }
}
