use std::sync::Mutex;

use log::warn;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct WindowOpenState {
    settings_tab: Mutex<String>,
}

impl WindowOpenState {
    pub fn settings_tab(&self) -> String {
        self.settings_tab.lock().unwrap().clone()
    }

    fn set_settings_tab(&self, tab: String) {
        *self.settings_tab.lock().unwrap() = tab;
    }
}

fn show(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn open_analytics(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("analytics") {
        show(&window);
        return;
    }
    if let Err(error) = WebviewWindowBuilder::new(
        app,
        "analytics",
        WebviewUrl::App("index.html#analytics".into()),
    )
    .title("Claude Usage — Analytics")
    .inner_size(960.0, 720.0)
    .min_inner_size(720.0, 520.0)
    .resizable(true)
    .decorations(true)
    .center()
    .build()
    {
        warn!("failed to create analytics window: {error}");
    }
}

pub fn open_todos(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("todos") {
        show(&window);
        return;
    }
    if let Err(error) =
        WebviewWindowBuilder::new(app, "todos", WebviewUrl::App("index.html#todos".into()))
            .title("Claude Usage — Tasks")
            .inner_size(1040.0, 760.0)
            .min_inner_size(640.0, 480.0)
            .resizable(true)
            .decorations(true)
            .center()
            .disable_drag_drop_handler()
            .build()
    {
        warn!("failed to create todos window: {error}");
    }
}

pub fn open_settings(app: &AppHandle, tab: Option<String>) {
    let tab = tab.unwrap_or_else(|| "account".into());
    app.state::<WindowOpenState>().set_settings_tab(tab.clone());
    if let Some(window) = app.get_webview_window("settings") {
        show(&window);
        let _ = window.emit("settings-open", tab);
        return;
    }
    if let Err(error) = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html#settings".into()),
    )
    .title("Claude Usage — Settings")
    .inner_size(680.0, 780.0)
    .min_inner_size(560.0, 540.0)
    .resizable(true)
    .decorations(true)
    .center()
    .build()
    {
        warn!("failed to create settings window: {error}");
    }
}
