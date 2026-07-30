// On Windows, prevent a console window from popping up alongside the GUI.
// (No effect on macOS / Linux.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mesh;
mod sidecar;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use crate::mesh::MeshStatus;
use crate::sidecar::Sidecar;

const MENU_OPEN: &str = "open_app";
const MENU_OPEN_CHAT: &str = "open_chat";
const MENU_START: &str = "start_service";
const MENU_STOP: &str = "stop_service";
const MENU_QUIT: &str = "quit";

const MAIN_WINDOW: &str = "main";

/// Bring the control window forward — used by tray "Open", single-instance
/// second launches, and `senda://` deep links from the browser after bind.
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Shared state held by the tray builder and the polling task. We keep the
/// last status under a `Mutex` so the menu rebuild on each poll can read
/// "are we online?" without re-fetching.
struct AppState {
    last_status: Mutex<MeshStatus>,
    /// The bundled Next.js controller sidecar (None during dev runs that
    /// pass `SENDA_APP_URL` to bypass it, or if the sidecar failed
    /// to spawn — we degrade to the fallback URL chain in that case).
    sidecar: Mutex<Option<Arc<Sidecar>>>,
}

fn main() {
    // Capture every `eprintln!` from the desktop process — including the
    // runtime auto-upgrade thread — into a real log file. A Tauri .app
    // launched from Finder hands stdout/stderr to `/dev/null`, so before
    // 0.1.41 every upgrade attempt that failed left zero forensic trace
    // (we knew the runtime was stuck on an old version but couldn't see
    // *why* the loop hadn't fixed it). Doing this first thing in `main`
    // means every subsequent line lands in the file regardless of which
    // thread emits it.
    redirect_stderr_to_desktop_log();

    // Pin the HuggingFace Hub cache directory before anything else
    // spawns a runtime child. The runtime CLI's `huggingface_hub_cache`
    // resolves the cache from a chain of env vars (HF_HUB_CACHE,
    // HF_HOME, XDG_CACHE_HOME, finally $HOME/.cache/huggingface/hub).
    // On Windows `$HOME` is not normally set — Windows uses
    // %USERPROFILE% — so when none of the higher-priority vars are set,
    // the runtime falls back to `PathBuf::from(".")` and the cache lands
    // at *whatever the runtime's current working directory happens to
    // be*. Two spawn paths produce two different working dirs:
    //
    //   * Scheduled Task launcher (wscript.exe): WorkingDirectory =
    //     %USERPROFILE% → cache at C:\Users\<u>\.cache\huggingface\hub
    //   * `senda models download` invoked from the bundled Node
    //     controller (sidecar): inherits the desktop app's CWD,
    //     %LOCALAPPDATA%\Senda → cache at
    //     C:\Users\<u>\AppData\Local\Senda\.cache\huggingface\hub
    //
    // The user downloads a model via the dashboard (path #2), then sets
    // it as the startup model — which restarts the runtime via the
    // Scheduled Task (path #1). The startup-loading runtime looks in a
    // different cache, can't find the model, and silently restarts a
    // 33 GB download. Diagnosing this required reading the runtime
    // source; from a user perspective it just looked like "I downloaded
    // the model, set it as startup, and then it got stuck on loading."
    //
    // Setting HF_HUB_CACHE explicitly here pins the location across
    // every codepath (this process, the Node sidecar, every senda
    // child the sidecar spawns, the Scheduled Task — see also the
    // mirror set in mesh.rs::REGISTER_TASK_PS and install.ps1).
    pin_huggingface_cache_dir();

    let state = Arc::new(AppState {
        last_status: Mutex::new(MeshStatus::default()),
        sidecar: Mutex::new(None),
    });

    let setup_state = state.clone();
    let exit_state = state.clone();

    tauri::Builder::default()
        // Single-instance guard. If a second `Senda.exe` is launched
        // (WiX installer's "Launch on completion" tick, Start Menu shortcut,
        // double-click on the desktop icon, file-association open, …), the
        // plugin contacts the running instance, runs this callback in *that*
        // process to focus the existing window, and exits the new process
        // immediately. Without this, every invocation spawned its own
        // webview, Node sidecar, tray icon, and runtime-upgrade loop — on
        // Windows users hit a state where the app kept opening more windows
        // until the OOM killer took the box down.
        //
        // Registered before `setup`/window-builder so the callback can
        // resolve the main window through `app.get_webview_window`.
        // Deep-link feature: Windows/Linux `senda://…` opens arrive here as
        // argv on a second process; plugin forwards into the live instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .setup(move |app| {
            // Custom scheme `senda://` (see tauri.conf.json plugins.deep-link).
            // macOS registers at bundle time via Info.plist; Windows/Linux
            // also need a runtime register so the installed binary owns the
            // handler after first launch.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("[senda] deep-link register_all failed: {e}");
                }
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                let _ = app.deep_link().on_open_url(move |_event| {
                    focus_main_window(&handle);
                });
            }
            // Wipe the WKWebView cache on first launch of a new version.
            // Each release rebuilds the Next.js controller and produces
            // new chunk hashes; cached HTML from the previous version
            // points at chunk URLs that no longer exist on disk, leaving
            // the user staring at an unstyled page until they manually
            // delete ~/Library/Caches/network.senda.shell. We track the
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
                        "[senda] controller sidecar spawned on http://127.0.0.1:{}",
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
                            "[senda] controller sidecar didn't become ready in time: {e}"
                        );
                    }
                    if let Ok(mut guard) = setup_state.sidecar.lock() {
                        *guard = Some(Arc::new(sc));
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[senda] could not spawn controller sidecar: {e}. Falling back \
                         to senda.network (no local mesh control until installed)."
                    );
                }
            }

            // The .app should land on the mesh control dashboard, not on
            // the public marketing homepage. `mesh::preferred_url()`
            // returns just the base; we append `/dashboard` (the control
            // group's entry point) here. If the bundled controller failed
            // to start and we fell back to senda.network, /dashboard is
            // 404'd by middleware on the public site — that path renders
            // a styled "not found" with a link to /, which is the
            // graceful fallback we want anyway.
            let base = mesh::preferred_url();
            let url = control_entry_url(&base);
            let parsed: tauri::Url = url
                .parse()
                .map_err(|e| format!("invalid chat URL `{url}`: {e}"))?;

            // Origin the control UI is served from — the local sidecar in
            // the normal case, senda.network in the sidecar-failed fallback.
            // Navigations to this origin stay in the webview; everything
            // else is an external link that belongs in the user's browser.
            let internal_origin = parsed.origin();

            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(parsed))
                .title("Senda")
                .inner_size(1100.0, 760.0)
                .min_inner_size(720.0, 520.0)
                .center()
                .visible(true)
                // wry doesn't hand `target="_blank"` links to the OS browser
                // on its own, so external links (senda.network/status, GitHub
                // release pages, …) silently did nothing when clicked. This
                // script rewrites external-origin link clicks into a
                // top-level navigation, which `on_navigation` below cancels
                // and opens in the system browser instead.
                .initialization_script(EXTERNAL_LINK_SCRIPT)
                .on_navigation(move |url| {
                    if url.scheme() != "http" && url.scheme() != "https" {
                        return true;
                    }
                    if url.origin() == internal_origin {
                        return true;
                    }
                    open_external_url(url.as_str());
                    false
                })
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
        .expect("failed to build Senda desktop")
        .run(move |_app, event| {
            match event {
                // We honor every ExitRequested now — Cmd+Q on macOS, the
                // tray's "Quit Senda" item, and `app.exit(0)` all
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
                // senda.network would still report the node online
                // serving inference long after the user thought they'd
                // left the mesh. This block is the load-bearing fix.
                RunEvent::Exit => {
                    // Default: stop the runtime and remove the login
                    // autostart unit — nothing should stay loaded when
                    // Senda isn't open. Opt-in "Keep running after I
                    // quit" leaves the headless daemon + login unit up.
                    if mesh::keep_running_after_quit() {
                        mesh::ensure_login_autostart();
                    } else {
                        mesh::stop_service();
                        mesh::uninstall_login_unit();
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
    // Senda" as the first menu item with a global Cmd+O shortcut
    // so the click-to-open habit still works in two clicks.
    let tray = TrayIconBuilder::with_id("senda-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default tray icon".into()))?,
        )
        .icon_as_template(true)
        .tooltip("Senda — offline")
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
            "Senda · {} node{} online",
            status.node_count,
            if status.node_count == 1 { "" } else { "s" }
        )
    } else {
        "Senda · offline".to_string()
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
        let model_item = MenuItemBuilder::with_id("model", line)
            .enabled(false)
            .build(app)?;
        builder = builder.item(&model_item);
    }

    builder = builder
        .separator()
        .item(&MenuItem::with_id(
            app,
            MENU_OPEN,
            "Open Senda",
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
        .separator();

    if status.online {
        builder = builder.item(&MenuItem::with_id(
            app,
            MENU_STOP,
            "Stop sharing",
            true,
            None::<&str>,
        )?);
    } else {
        builder = builder.item(&MenuItem::with_id(
            app,
            MENU_START,
            "Start sharing",
            true,
            None::<&str>,
        )?);
    }

    builder
        .separator()
        .item(&MenuItem::with_id(
            app,
            MENU_QUIT,
            "Quit Senda",
            true,
            Some("CmdOrCtrl+Q"),
        )?)
        .build()
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
        MENU_START => {
            std::thread::spawn(|| mesh::start_service());
        }
        MENU_STOP => {
            std::thread::spawn(|| mesh::stop_service());
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
    if let Some(tray) = app.tray_by_id("senda-tray") {
        let _ = tray.set_tooltip(Some(&tooltip));

        if let Ok(menu) = build_tray_menu_for_handle(app, status) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn render_tooltip(status: &MeshStatus) -> String {
    if !status.online {
        return "Senda — offline".to_string();
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
    format!("Senda — {}", parts.join(" · "))
}

// ---------- Misc helpers ------------------------------------------------

/// Pick a stable HuggingFace Hub cache directory and export it via
/// `HF_HUB_CACHE` so every runtime child the desktop app spawns —
/// directly or indirectly — agrees on where models live. See the
/// callsite in `main` for the failure mode this prevents.
///
/// We layer the choice the same way the runtime does, but resolved at
/// the desktop process: respect any pre-existing `HF_HUB_CACHE` /
/// `HF_HOME` / `XDG_CACHE_HOME` (so power users with custom HF setups
/// keep working), otherwise pick the canonical user-cache location for
/// the host OS via the `dirs` crate. The path returned by
/// `dirs::cache_dir()` is stable across launch contexts on every
/// platform we ship — that's the whole point of making this the
/// authoritative answer instead of letting the runtime guess from CWD.
fn pin_huggingface_cache_dir() {
    fn nonempty(v: std::ffi::OsString) -> Option<std::ffi::OsString> {
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    }

    if std::env::var_os("HF_HUB_CACHE")
        .and_then(nonempty)
        .is_some()
    {
        return;
    }
    if let Some(hf_home) = std::env::var_os("HF_HOME").and_then(nonempty) {
        let cache = std::path::PathBuf::from(hf_home).join("hub");
        eprintln!(
            "[senda] pinning HF_HUB_CACHE={} (derived from HF_HOME)",
            cache.display()
        );
        std::env::set_var("HF_HUB_CACHE", cache);
        return;
    }
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME").and_then(nonempty) {
        let cache = std::path::PathBuf::from(xdg)
            .join("huggingface")
            .join("hub");
        eprintln!(
            "[senda] pinning HF_HUB_CACHE={} (derived from XDG_CACHE_HOME)",
            cache.display()
        );
        std::env::set_var("HF_HUB_CACHE", cache);
        return;
    }
    // Final fallback: the canonical user-cache dir for this OS. Same
    // result `dirs::cache_dir()` uses, hardened against the
    // Windows-no-HOME edge case that broke the runtime's own resolver.
    if let Some(cache_root) = dirs::cache_dir() {
        let cache = cache_root.join("huggingface").join("hub");
        eprintln!(
            "[senda] pinning HF_HUB_CACHE={} (platform user cache dir)",
            cache.display()
        );
        let _ = std::fs::create_dir_all(&cache);
        std::env::set_var("HF_HUB_CACHE", cache);
        return;
    }
    eprintln!(
        "[senda] could not resolve a user cache dir; HF_HUB_CACHE left unset \
         (runtime will fall back to its built-in default)"
    );
}

/// Append the control-group entry path (`/chat`, the chat-first home) to the
/// controller's base URL. Handles both `http://127.0.0.1:42141` and
/// `http://127.0.0.1:42141/` inputs without producing a double slash. When the
/// fallback URL is the public site (https://senda.network), this still produces
/// a valid URL — middleware on the public site renders a 404 with a link back
/// to /, which is acceptable degradation when there's no local controller.
fn control_entry_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    format!("{trimmed}/chat")
}

/// Injected into the control webview. wry does not open `target="_blank"`
/// links in the system browser (and this single-window app has nowhere to
/// put a "new tab"), so external-origin link clicks are rewritten into a
/// top-level navigation that `on_navigation` intercepts and hands to the
/// OS browser. Same-origin links are left untouched so in-app routing and
/// same-origin navigations behave normally.
const EXTERNAL_LINK_SCRIPT: &str = r#"
(function () {
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = e.target;
    var a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) return;
    var href = a.href;
    if (!/^https?:\/\//i.test(href)) return;
    try { if (new URL(href).origin === window.location.origin) return; } catch (err) { return; }
    e.preventDefault();
    window.location.href = href;
  }, true);
})();
"#;

/// Open an external URL in the user's default browser. Only http(s) is
/// accepted — the navigation interceptor forwards untrusted page URLs here,
/// so we refuse anything that could hand a custom scheme to `open`/`start`.
fn open_external_url(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: don't flash a console window (the app is a GUI
        // subsystem process; see the "opening terminals like crazy" fix).
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
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
        "[senda] version changed ({} -> {}); wiping webview cache",
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
    let bundle_id = "network.senda.shell";
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
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".cache"))
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

/// Open `~/Library/Logs/senda/desktop.log` (or the platform
/// equivalent) and `dup2` it over file descriptor 2. After this call,
/// every `eprintln!` and every `tracing::error` written to stderr lands
/// in that file regardless of which thread emits it. We deliberately
/// `mem::forget` the [`File`] handle so dropping it doesn't close the
/// fd we just installed.
///
/// All errors are swallowed: if we can't open the log file the only
/// regression is that we keep the previous `eprintln!`-into-`/dev/null`
/// behavior, which is no worse than every release before 0.1.41.
///
/// Why not redirect stdout too? Tauri's webview spams stdout with WKWebView
/// internals on macOS and we don't want to balloon the log file with that
/// noise. The runtime-upgrade and self-heal codepaths only use stderr.
#[cfg(unix)]
fn redirect_stderr_to_desktop_log() {
    use std::io::Write;
    use std::os::unix::io::AsRawFd;

    let Some(dir) = mesh::default_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("desktop.log");
    // Trim before (re)opening append-only — this is the only moment no fd holds it.
    cap_desktop_log(&path);
    let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };

    // Print a session-start banner *before* dup2 so users browsing the
    // file see a clean separator between launches; without this every
    // eprintln from the previous run smushes into the next.
    let mut writer = &f;
    let _ = writeln!(
        writer,
        "\n=== Senda desktop {} starting at {} (pid {}) ===",
        env!("CARGO_PKG_VERSION"),
        chrono_like_now(),
        std::process::id(),
    );
    let _ = writer.flush();

    unsafe {
        // STDERR_FILENO == 2. Returns -1 on failure; we ignore that — the
        // worst case is keeping the existing /dev/null fd, which is what
        // we'd have without this call anyway.
        libc::dup2(f.as_raw_fd(), libc::STDERR_FILENO);
    }
    // Keep the underlying file alive past the dup2: if we let `f` Drop
    // here, the kernel would close the original fd, but the duplicate at
    // fd 2 stays valid (dup2 is "make fd 2 refer to the same file as
    // fd N", not "share ownership"). The forget is belt-and-braces — it
    // costs us one File worth of memory until process exit and avoids
    // any future refactor accidentally relying on the descriptor count.
    std::mem::forget(f);
}

/// Windows equivalent: redirect stderr to %LOCALAPPDATA%\senda\logs\
/// desktop.log so the runtime auto-upgrade / repair_missing_helpers /
/// ggml-org fallback paths leave forensic traces. A Tauri windowed app
/// on Windows is started under the "windows" subsystem with no console
/// allocated, which means GetStdHandle(STD_ERROR_HANDLE) returns
/// INVALID_HANDLE_VALUE and every `eprintln!` silently fails. Pre-0.1.73
/// we had no idea why a user's machine still had no rpc-server.exe
/// after first launch — repair_missing_helpers might have run cleanly
/// and reported success, or might have failed at the HTTPS download,
/// and we couldn't tell. Now both go on disk and are inspectable at
/// %LOCALAPPDATA%\senda\logs\desktop.log.
#[cfg(windows)]
fn redirect_stderr_to_desktop_log() {
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;

    let Some(dir) = mesh::default_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("desktop.log");
    // Trim before (re)opening append-only — this is the only moment no fd holds it.
    cap_desktop_log(&path);
    let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };

    let mut writer = &f;
    let _ = writeln!(
        writer,
        "\n=== Senda desktop {} starting at {} (pid {}) ===",
        env!("CARGO_PKG_VERSION"),
        chrono_like_now(),
        std::process::id(),
    );
    let _ = writer.flush();

    // STD_ERROR_HANDLE = (DWORD)-12. SetStdHandle is in kernel32.
    // Direct FFI keeps this self-contained without pulling in a
    // 6 MiB windows-sys / windows crate just for two symbols.
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // (DWORD)-12
    extern "system" {
        fn SetStdHandle(nStdHandle: u32, hHandle: *mut core::ffi::c_void) -> i32;
    }
    unsafe {
        SetStdHandle(STD_ERROR_HANDLE, f.as_raw_handle() as *mut _);
    }
    // Same belt-and-braces as the Unix branch: leak the File so the
    // HANDLE we just installed stays valid for the process lifetime.
    // Memory cost is one File worth; the alternative (closing on drop)
    // would leave SetStdHandle pointing at an invalid handle on the
    // very next eprintln.
    std::mem::forget(f);
}

#[cfg(not(any(unix, windows)))]
fn redirect_stderr_to_desktop_log() {}

/// Defensive size cap for the desktop process's own `desktop.log`.
///
/// Unlike the launchd-managed runtime stdout/stderr (capped by
/// `mesh::cap_runtime_logs`), this file is written directly by the desktop
/// process — `redirect_stderr_to_desktop_log` `dup2`s/`SetStdHandle`s it over
/// fd 2 and it's opened append-only — so nothing ever rotates it. Volume is
/// low (event-driven `eprintln!` from the upgrade / self-heal paths), but
/// "low and unbounded" is still unbounded over a multi-year install, so this
/// is the belt-and-braces cap for the same class of bug that produced a
/// 5.6 GB runtime `stdout.log`. Call it at launch *before* the fd is installed
/// — the one window where no writer holds the file — so a plain truncate-to-tail
/// is safe. Keeps the last `KEEP_TAIL` bytes so recent forensics survive.
#[cfg(any(unix, windows))]
fn cap_desktop_log(path: &std::path::Path) {
    use std::io::{Read, Seek, SeekFrom, Write};
    const MAX_BYTES: u64 = 8 * 1024 * 1024; // trim when over 8 MB
    const KEEP_TAIL: u64 = 1024 * 1024; // retain the last 1 MB

    let Ok(meta) = std::fs::metadata(path) else {
        return; // no file yet → nothing to cap
    };
    if meta.len() <= MAX_BYTES {
        return;
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return;
    };
    let start = meta.len().saturating_sub(KEEP_TAIL);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut tail = Vec::new();
    if f.read_to_end(&mut tail).is_err() {
        return;
    }
    drop(f);
    // Drop a leading partial line so the first retained record is whole.
    let body = match tail.iter().position(|&b| b == b'\n') {
        Some(nl) => &tail[nl + 1..],
        None => &tail[..],
    };
    let tmp = path.with_extension("log.tmp");
    let Ok(mut out) = std::fs::File::create(&tmp) else {
        return;
    };
    if out
        .write_all(b"... [senda desktop.log trimmed by size cap \xe2\x80\x94 older lines dropped] ...\n")
        .and_then(|_| out.write_all(body))
        .and_then(|_| out.flush())
        .is_err()
    {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    let _ = std::fs::rename(&tmp, path);
}

/// `time` crate / `chrono` would both be heavier deps than this single
/// timestamp justifies. We just want something human-readable for the
/// session-start banner; ISO-8601 to second precision is enough.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Cheap UTC ISO-8601 without timezone DB. Good enough for a log
    // banner; for sub-second precision we have the kernel-stamped
    // mtime on the log file itself.
    let days = secs / 86_400;
    let secs_in_day = secs % 86_400;
    let hh = secs_in_day / 3600;
    let mm = (secs_in_day % 3600) / 60;
    let ss = secs_in_day % 60;
    let (y, mo, d) = days_to_ymd(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Convert "days since 1970-01-01" to (year, month, day). Tiny civil-from-days
/// implementation, lifted from Howard Hinnant's date algorithms (public
/// domain). Avoids pulling in `chrono` / `time` for one log line.
fn days_to_ymd(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
