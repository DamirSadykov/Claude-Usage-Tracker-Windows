mod usage;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use usage::{ProjectInfo, SessionStartResult, UsageData};

static BASE_ICON: &[u8] = include_bytes!("../icons/32x32.png");

fn make_tray_icon(dot_rgb: [u8; 3]) -> Vec<u8> {
    let img = image::load_from_memory(BASE_ICON).unwrap().to_rgba8();
    let (w, h) = img.dimensions();
    let mut rgba = img.into_raw();

    let cx = w as f32 - 7.0;
    let cy = 7.0_f32;
    let r = 6.0_f32;

    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= r + 0.5 {
                let alpha = (r + 0.5 - dist).clamp(0.0, 1.0);
                let idx = ((y * w + x) * 4) as usize;
                let a = (alpha * 255.0) as u8;
                if a > rgba[idx + 3] || dist <= r {
                    rgba[idx] = dot_rgb[0];
                    rgba[idx + 1] = dot_rgb[1];
                    rgba[idx + 2] = dot_rgb[2];
                    rgba[idx + 3] = 255;
                }
            }
        }
    }
    rgba
}

#[tauri::command]
async fn fetch_usage(session_key: String, org_id: String) -> Result<UsageData, String> {
    usage::fetch_usage(&session_key, &org_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_tray(app: tauri::AppHandle, percent: f64) -> Result<(), String> {
    let color = if percent < 25.0 {
        [108, 203, 95]  // green
    } else if percent < 50.0 {
        [255, 193, 7]   // yellow
    } else if percent < 75.0 {
        [217, 119, 87]  // orange
    } else {
        [248, 113, 113] // red
    };

    let rgba = make_tray_icon(color);
    let icon = tauri::image::Image::new_owned(rgba, 32, 32);

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_claude() -> Result<(), String> {
    open::that("https://claude.ai/new").map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_project(session_key: String, org_id: String) -> Result<ProjectInfo, String> {
    usage::ensure_project(&session_key, &org_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_session(
    session_key: String,
    org_id: String,
    project_id: String,
) -> Result<SessionStartResult, String> {
    usage::start_session(&session_key, &org_id, &project_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostarted"]),
        ))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let mini = MenuItem::with_id(app, "mini", "Mini widget", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &mini, &quit])?;

            if let Some(tray) = app.tray_by_id("main-tray") {
                tray.set_menu(Some(menu))?;
                tray.on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("open-settings", ());
                        }
                    }
                    "mini" => {
                        if let Some(window) = app.get_webview_window("mini") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                });
                tray.on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                });
            }

            // Hide window on close instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_usage,
            update_tray,
            open_claude,
            ensure_project,
            start_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
