// On Windows, prevent a console window from popping up alongside the GUI.
// (No effect on macOS / Linux.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mesh;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use crate::mesh::MeshStatus;

/// IDs for the dynamic menu items we have to rebuild every poll cycle
/// (because the Start/Stop label flips with online state).
const MENU_OPEN: &str = "open_chat";
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
}

fn main() {
    let state = Arc::new(AppState {
        last_status: Mutex::new(MeshStatus::default()),
    });

    let setup_state = state.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let url = mesh::preferred_url();
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
        .run(|_app, event| {
            // Keep the process alive even when no windows are visible —
            // again, the tray is the primary affordance.
            if let RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

// ---------- Tray --------------------------------------------------------

fn build_tray(app: &tauri::App, state: Arc<AppState>) -> tauri::Result<()> {
    let menu = build_tray_menu(app, &state.last_status.lock().unwrap())?;

    let tray = TrayIconBuilder::with_id("closedmesh-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default tray icon".into()))?,
        )
        .icon_as_template(true)
        .tooltip("ClosedMesh — offline")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|_tray, event| {
            // Click-to-toggle the chat window. macOS behaviour matches the
            // Swift app; on Windows / Linux it's a familiar pattern from
            // Slack / Discord-style tray apps.
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(app) = _tray.app_handle().get_webview_window(MAIN_WINDOW) {
                    let _ = app.show();
                    let _ = app.set_focus();
                }
            }
        })
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
        .item(&MenuItem::with_id(app, MENU_OPEN, "Open Chat", true, Some("CmdOrCtrl+O"))?)
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
        MENU_RELOAD => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                // Re-resolve the URL so flipping `npm run dev` on/off is
                // picked up without restarting the .app. We navigate via
                // `window.location.replace` (rather than Tauri's
                // `webview.navigate`) because it works the same way across
                // every backing webview engine and doesn't require a
                // mutable handle.
                let url = mesh::preferred_url();
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
    {
        let mut guard = state.last_status.lock().unwrap();
        *guard = status.clone();
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
