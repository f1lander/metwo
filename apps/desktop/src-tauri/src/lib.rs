mod daemon;
mod watch;

use daemon::{Daemon, DaemonStatus};
use std::path::PathBuf;
use std::process::Command;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

const TRAY_ID: &str = "main";

fn project_root() -> PathBuf {
    if let Ok(root) = std::env::var("METWO_ROOT").or_else(|_| std::env::var("TICKETFLOW_ROOT")) {
        return PathBuf::from(root);
    }
    // apps/desktop/src-tauri -> repo root. Right for builds made from this checkout.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
fn daemon_status(daemon: State<'_, Daemon>) -> DaemonStatus {
    daemon.status()
}

#[tauri::command]
async fn daemon_start(daemon: State<'_, Daemon>) -> Result<DaemonStatus, String> {
    let d = daemon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || d.start()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn daemon_stop(daemon: State<'_, Daemon>) -> Result<DaemonStatus, String> {
    let d = daemon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || d.stop()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn daemon_restart(daemon: State<'_, Daemon>) -> Result<DaemonStatus, String> {
    let d = daemon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || d.restart()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn daemon_logs(daemon: State<'_, Daemon>) -> Vec<String> {
    daemon.logs()
}

#[tauri::command]
fn set_tray_title(app: AppHandle, title: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(&title));
        let _ = tray.set_tooltip(Some(&format!("metwo · {title}")));
    }
}

// URLs, folders and the dev server, via the system handler.
#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    let allowed = target.starts_with("http://") || target.starts_with("https://") || target.starts_with('/');
    if !allowed {
        return Err("only urls and absolute paths".into());
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener).arg(&target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn show(app: &AppHandle, hash: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(h) = hash {
            let _ = window.eval(&format!("window.location.hash = '{h}'"));
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn notify_in_window(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
        let _ = window.eval(&format!("console.info('[tray] {escaped}')"));
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open board", true, None::<&str>)?;
    let health = MenuItem::with_id(app, "health", "Health", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart daemon", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop daemon", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start daemon", true, None::<&str>)?;
    let bot = MenuItem::with_id(app, "bot", "Restart Telegram bot", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause lanes", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "Resume lanes", true, None::<&str>)?;
    let poll = MenuItem::with_id(app, "poll", "Poll Linear now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit metwo", true, Some("CmdOrCtrl+Q"))?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &health, &sep()?, &poll, &pause, &resume, &sep()?, &bot, &restart, &stop, &start, &sep()?, &quit])?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .title("")
        .tooltip("metwo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let daemon = app.state::<Daemon>().inner().clone();
            let handle = app.clone();
            match event.id().as_ref() {
                "open" => show(app, Some("#/")),
                "health" => show(app, Some("#/health")),
                "quit" => app.exit(0),
                id => {
                    let id = id.to_string();
                    std::thread::spawn(move || {
                        let result = match id.as_str() {
                            "restart" => daemon.restart().map(|_| ()),
                            "stop" => {
                                daemon.stop();
                                Ok(())
                            }
                            "start" => daemon.start().map(|_| ()),
                            "bot" => daemon::post("/api/control/restart-bot"),
                            "pause" => daemon::post("/api/control/pause"),
                            "resume" => daemon::post("/api/control/resume"),
                            "poll" => daemon::post("/api/control/poll"),
                            _ => Ok(()),
                        };
                        if let Err(e) = result {
                            notify_in_window(&handle, &format!("{id} failed: {e}"));
                        }
                    });
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle(), None);
            }
        });
    // the "m" as a template image: macOS tints it for light and dark menu bars
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
    builder.icon(icon).icon_as_template(true).build(app)?;
    Ok(())
}

pub fn run() {
    let daemon = Daemon::new(project_root());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(daemon.clone())
        .invoke_handler(tauri::generate_handler![daemon_status, daemon_start, daemon_stop, daemon_restart, daemon_logs, set_tray_title, open_external])
        .setup(move |app| {
            // menu bar app: no Dock icon, the tray is the way in
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            build_tray(app)?;
            watch::start(app.handle().clone(), TRAY_ID);
            // The app is the way to run metwo: bring the daemon up unless a terminal already did.
            let d = daemon.clone();
            std::thread::spawn(move || {
                if let Err(e) = d.start() {
                    eprintln!("{e}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps metwo running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building metwo");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            app.state::<Daemon>().stop();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app, None),
        _ => {}
    });
}
