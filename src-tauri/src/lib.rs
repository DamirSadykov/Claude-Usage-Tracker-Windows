pub mod alerts;
pub mod cc;
pub mod domain;
pub mod stats;
pub mod status;
pub mod usage;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::Timelike;
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::Notify;

use alerts::{tier_level, AlertEngine, AppConfig};
use domain::{compute_levels, is_muted, today_spent_for, UsageLevels};
use stats::StatsDb;
use usage::UsageData;

static TRAY_OK: &[u8] = include_bytes!("../icons/tray-ok.png");
static TRAY_WARN: &[u8] = include_bytes!("../icons/tray-warn.png");
static TRAY_HIGH: &[u8] = include_bytes!("../icons/tray-high.png");
static TRAY_CRIT: &[u8] = include_bytes!("../icons/tray-crit.png");

fn tray_icon_for(percent: f64, thresholds: &[f64]) -> Vec<u8> {
    let png = match tier_level(percent, thresholds) {
        0 => TRAY_OK,
        1 => TRAY_WARN,
        2 => TRAY_HIGH,
        _ => TRAY_CRIT,
    };
    image::load_from_memory(png).unwrap().to_rgba8().into_raw()
}

// --- Popup flyout positioning & toggle ---

// A tray click while the flyout is open first blurs the window (auto-hide
// fires), so the click's Up event then sees it hidden and would re-show it.
// We record the auto-hide time and ignore re-opens within this window.
const REOPEN_DEBOUNCE_MS: u64 = 350;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Fixed gap between the flyout and the taskbar / screen edges, in logical px.
const FLYOUT_MARGIN: f64 = 8.0;

// Which screen edge the taskbar occupies.
#[derive(Clone, Copy)]
enum TaskbarEdge {
    Bottom,
    Top,
    Left,
    Right,
}

// Pin the flyout to the taskbar edge near the tray icon, using the monitor
// work area so it never overlaps the taskbar. The exact click point inside the
// tray icon does not affect the result — only which monitor and which side of
// the screen the icon is on. `anchor` is the tray click position (physical); it
// only selects the corner/side. When absent (opened from the menu) we default
// to the conventional bottom-right placement.
fn position_flyout(window: &WebviewWindow, anchor: Option<PhysicalPosition<f64>>) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };

    // Margin in logical px → physical, so spacing stays constant across DPI.
    let margin = (FLYOUT_MARGIN * monitor.scale_factor()).round() as i32;
    let win_w = size.width as i32;
    let win_h = size.height as i32;

    // Full monitor bounds (physical).
    let mp = monitor.position();
    let ms = monitor.size();
    let mon_top = mp.y;
    let mon_bottom = mp.y + ms.height as i32;
    let mon_left = mp.x;
    let mon_right = mp.x + ms.width as i32;

    // Work area = monitor minus the taskbar (physical).
    let wa = monitor.work_area();
    let wa_top = wa.position.y;
    let wa_bottom = wa.position.y + wa.size.height as i32;
    let wa_left = wa.position.x;
    let wa_right = wa.position.x + wa.size.width as i32;

    // The taskbar lives on the edge with the largest strip reclaimed from the
    // work area. Default to Bottom when nothing is reclaimed (e.g. auto-hide).
    let gap_top = wa_top - mon_top;
    let gap_bottom = mon_bottom - wa_bottom;
    let gap_left = wa_left - mon_left;
    let gap_right = mon_right - wa_right;
    let edge = if gap_left > gap_right && gap_left > gap_top && gap_left > gap_bottom {
        TaskbarEdge::Left
    } else if gap_right > gap_top && gap_right > gap_bottom {
        TaskbarEdge::Right
    } else if gap_top > gap_bottom {
        TaskbarEdge::Top
    } else {
        TaskbarEdge::Bottom
    };

    let (x, y) = match edge {
        TaskbarEdge::Bottom | TaskbarEdge::Top => {
            let y = match edge {
                TaskbarEdge::Top => wa_top + margin,
                _ => wa_bottom - win_h - margin,
            };
            // Align to the side of the tray icon; default to the right corner.
            let x = match anchor {
                Some(a) if (a.x as i32) < (wa_left + wa_right) / 2 => wa_left + margin,
                _ => wa_right - win_w - margin,
            };
            (x, y)
        }
        TaskbarEdge::Left | TaskbarEdge::Right => {
            let x = match edge {
                TaskbarEdge::Left => wa_left + margin,
                _ => wa_right - win_w - margin,
            };
            let y = match anchor {
                Some(a) if (a.y as i32) < (wa_top + wa_bottom) / 2 => wa_top + margin,
                _ => wa_bottom - win_h - margin,
            };
            (x, y)
        }
    };

    // Clamp inside the work area in case the window is larger than expected.
    let x = x.clamp(wa_left, (wa_right - win_w).max(wa_left));
    let y = y.clamp(wa_top, (wa_bottom - win_h).max(wa_top));

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_flyout(window: &WebviewWindow, anchor: Option<PhysicalPosition<f64>>) {
    position_flyout(window, anchor);
    let _ = window.show();
    let _ = window.set_focus();
}

// --- Event payloads pushed to the frontend ---

#[derive(Serialize, Clone)]
struct UsageUpdate {
    usage: UsageData,
    levels: UsageLevels,
}

// --- Background polling loop: the single owner of business logic ---

async fn run_cycle(app: &AppHandle, cfg: &AppConfig, auto_started: &mut bool) {
    let usage = match usage::fetch_usage(&cfg.session_key, &cfg.org_id).await {
        Ok(u) => u,
        Err(e) => {
            let _ = app.emit("usage-error", e.to_string());
            return;
        }
    };

    if let Some(stats) = app.try_state::<Arc<StatsDb>>() {
        if let Err(e) = stats.record_snapshot(&usage) {
            eprintln!("Failed to record snapshot: {}", e);
        }
    }

    let rgba = tray_icon_for(usage.five_hour.percent_used, &cfg.session_thresholds);
    if let Some(tray) = app.tray_by_id("main-tray") {
        let icon = tauri::image::Image::new_owned(rgba, 32, 32);
        let _ = tray.set_icon(Some(icon));
    }

    let levels = compute_levels(&usage, cfg);
    let _ = app.emit(
        "usage-updated",
        UsageUpdate {
            usage: usage.clone(),
            levels,
        },
    );

    if cfg.notifications_enabled {
        let now = chrono::Utc::now();
        let stats = app.try_state::<Arc<StatsDb>>();
        let delta = stats.as_ref().and_then(|s| {
            let from =
                (now - chrono::Duration::minutes(cfg.forecast_window_min as i64)).to_rfc3339();
            let to = now.to_rfc3339();
            s.compute_delta(&from, &to).ok().flatten()
        });
        let today_spent = stats
            .as_ref()
            .and_then(|s| today_spent_for(s, cfg, &usage, &now.to_rfc3339()));
        let muted = is_muted(cfg.notifications_muted_until.as_deref(), now);
        let now_min = {
            let n = chrono::Local::now();
            n.hour() * 60 + n.minute()
        };
        let events = {
            let eng = app.state::<Mutex<AlertEngine>>();
            let mut e = eng.lock().unwrap();
            e.evaluate(&usage, cfg, now_min, delta.as_ref(), today_spent, muted)
        };
        for ev in events {
            let _ = app.emit("alert", ev);
        }
    }

    if cfg.auto_start_session {
        let active = usage.five_hour.percent_used > 0.0 || usage.five_hour.reset_at.is_some();
        if active {
            *auto_started = false;
        } else if !*auto_started {
            *auto_started = true;
            auto_start(app, cfg).await;
        }
    }
}

async fn auto_start(app: &AppHandle, cfg: &AppConfig) {
    let mut project_id = cfg.project_id.clone();
    if project_id.is_empty() {
        match usage::ensure_project(&cfg.session_key, &cfg.org_id).await {
            Ok(p) => {
                project_id = p.uuid.clone();
                if let Some(c) = app.try_state::<Mutex<AppConfig>>() {
                    c.lock().unwrap().project_id = project_id.clone();
                }
                // Let the frontend persist the resolved id back to the store.
                let _ = app.emit("project-resolved", project_id.clone());
            }
            Err(e) => {
                let _ = app.emit("auto-start-error", e.to_string());
                return;
            }
        }
    }
    match usage::start_session(&cfg.session_key, &cfg.org_id, &project_id).await {
        Ok(r) => {
            let _ = app.emit("auto-start-result", r.skipped);
        }
        Err(e) => {
            let _ = app.emit("auto-start-error", e.to_string());
        }
    }
}

fn spawn_poll_loop(app: AppHandle, notify: Arc<Notify>) {
    tauri::async_runtime::spawn(async move {
        let mut auto_started = false;
        loop {
            let cfg = { app.state::<Mutex<AppConfig>>().lock().unwrap().clone() };
            let interval = cfg.refresh_interval.max(10);
            if !cfg.session_key.is_empty() && !cfg.org_id.is_empty() {
                run_cycle(&app, &cfg, &mut auto_started).await;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                _ = notify.notified() => {}
            }
        }
    });
}

// --- Service status (status.claude.com) ---

/// Last fetched service status, shared so a late-mounting frontend can pull the
/// current value via `get_service_status` instead of waiting for the next emit.
#[derive(Default)]
struct StatusState {
    last: Option<status::ServiceStatus>,
    reachable: bool,
}

#[derive(Serialize, Clone)]
struct StatusSnapshot {
    status: Option<status::ServiceStatus>,
    reachable: bool,
}

/// Pushed to the frontend when the overall status changes or an incident
/// appears, so it can raise an OS notification (mirrors the `alert` flow).
#[derive(Serialize, Clone)]
struct ServiceAlert {
    /// `degraded` | `resolved` | `incident`.
    kind: String,
    indicator: String,
    text: String,
}

fn spawn_status_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut etag: Option<String> = None;
        let mut last_indicator: Option<String> = None;
        let mut known_incidents: HashSet<String> = HashSet::new();
        let mut first = true;
        let mut fail: u32 = 0;

        loop {
            let cfg = { app.state::<Mutex<AppConfig>>().lock().unwrap().clone() };
            let base = cfg.service_status_interval.clamp(30, 600);
            let mut sleep = base;

            if cfg.service_status_enabled {
                match status::fetch_status(etag.as_deref()).await {
                    Ok(status::StatusFetch::Modified { status: s, etag: new_etag }) => {
                        fail = 0;
                        if let Some(tag) = new_etag {
                            etag = Some(tag);
                        }

                        if let Some(st) = app.try_state::<Arc<Mutex<StatusState>>>() {
                            let mut g = st.lock().unwrap();
                            g.last = Some(s.clone());
                            g.reachable = true;
                        }

                        // Notify on a real change only — never on the first fetch.
                        if cfg.service_status_notify && !first {
                            if last_indicator.as_deref() != Some(s.indicator.as_str()) {
                                let kind = if s.indicator == "none" { "resolved" } else { "degraded" };
                                let _ = app.emit(
                                    "service-alert",
                                    ServiceAlert {
                                        kind: kind.to_string(),
                                        indicator: s.indicator.clone(),
                                        text: s.description.clone(),
                                    },
                                );
                            }
                            for inc in &s.incidents {
                                if !known_incidents.contains(&inc.id) {
                                    let _ = app.emit(
                                        "service-alert",
                                        ServiceAlert {
                                            kind: "incident".to_string(),
                                            indicator: inc.impact.clone(),
                                            text: inc.name.clone(),
                                        },
                                    );
                                }
                            }
                        }

                        last_indicator = Some(s.indicator.clone());
                        known_incidents = s.incidents.iter().map(|i| i.id.clone()).collect();
                        first = false;
                        let _ = app.emit("service-status", s);
                    }
                    Ok(status::StatusFetch::NotModified) => {
                        fail = 0;
                    }
                    Err(e) => {
                        fail = fail.saturating_add(1);
                        if let Some(st) = app.try_state::<Arc<Mutex<StatusState>>>() {
                            st.lock().unwrap().reachable = false;
                        }
                        let _ = app.emit("service-status-error", e.to_string());
                        // Exponential backoff, capped, so a sustained outage of
                        // the status page itself doesn't hammer it.
                        let shift = fail.min(4);
                        sleep = base.saturating_mul(1u64 << shift).min(600);
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(sleep)).await;
        }
    });
}

// --- Commands ---

#[tauri::command]
fn get_service_status(state: tauri::State<'_, Arc<Mutex<StatusState>>>) -> StatusSnapshot {
    let g = state.lock().unwrap();
    StatusSnapshot {
        status: g.last.clone(),
        reachable: g.reachable,
    }
}

#[tauri::command]
fn configure(
    config: AppConfig,
    state: tauri::State<'_, Mutex<AppConfig>>,
    engine: tauri::State<'_, Mutex<AlertEngine>>,
    notify: tauri::State<'_, Arc<Notify>>,
) -> Result<(), String> {
    let disable = !config.notifications_enabled;
    *state.lock().unwrap() = config;
    if disable {
        // Turning notifications off re-arms the engine for a clean next enable.
        engine.lock().unwrap().reset();
    }
    notify.notify_one(); // apply immediately, don't wait out the interval
    Ok(())
}

#[tauri::command]
fn refresh_now(notify: tauri::State<'_, Arc<Notify>>) -> Result<(), String> {
    notify.notify_one();
    Ok(())
}

#[tauri::command]
async fn open_claude() -> Result<(), String> {
    open::that("https://claude.ai/new").map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_status_page() -> Result<(), String> {
    open::that(status::STATUS_PAGE_URL).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_project(
    session_key: String,
    org_id: String,
) -> Result<usage::ProjectInfo, String> {
    usage::ensure_project(&session_key, &org_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_session(
    session_key: String,
    org_id: String,
    project_id: String,
) -> Result<usage::SessionStartResult, String> {
    usage::start_session(&session_key, &org_id, &project_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_usage_delta(
    from: String,
    to: String,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<Option<stats::UsageDelta>, String> {
    stats.compute_delta(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_usage_snapshots(
    from: String,
    to: String,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<Vec<stats::UsageSnapshot>, String> {
    stats.query_range(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_latest_snapshots(
    count: u32,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<Vec<stats::UsageSnapshot>, String> {
    stats.latest(count).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ingest_cc_usage(
    stats: tauri::State<'_, Arc<StatsDb>>,
    config: tauri::State<'_, Mutex<AppConfig>>,
) -> Result<usize, String> {
    // Privacy gate: never touch ~/.claude unless the user opted in.
    if !config.lock().unwrap().cc_analytics_enabled {
        return Ok(0);
    }
    let base = cc::claude_dir().ok_or("Cannot resolve Claude config directory")?;
    let db = stats.inner().clone();
    // Disk-heavy walk/parse — keep it off the async runtime threads.
    tauri::async_runtime::spawn_blocking(move || cc::ingest(&base, &db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_forecast(
    window_min: u64,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<stats::ForecastData, String> {
    stats
        .forecast(window_min as i64, chrono::Utc::now())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_analytics(
    from: String,
    to: String,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<stats::Analytics, String> {
    stats.analytics(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_analytics_compare(
    cur_from: String,
    cur_to: String,
    prev_from: String,
    prev_to: String,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<stats::PeriodCompare, String> {
    stats
        .analytics_compare(&cur_from, &cur_to, &prev_from, &prev_to)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Stats database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("usage_stats.db");
            let stats_db = Arc::new(StatsDb::open(&db_path).expect("Failed to open stats DB"));

            let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
            stats_db.cleanup_before(&cutoff.to_rfc3339()).ok();
            app.manage(stats_db);

            // Business-logic state, owned by the backend loop.
            app.manage(Mutex::new(AppConfig::default()));
            app.manage(Mutex::new(AlertEngine::new()));
            app.manage(Arc::new(Mutex::new(StatusState::default())));
            let notify = Arc::new(Notify::new());
            app.manage(notify.clone());

            // Shared time of the last auto-hide, used to debounce tray re-opens.
            let last_hide = Arc::new(AtomicU64::new(0));

            // Tray menu
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
                            show_flyout(&window, None);
                        }
                    }
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_flyout(&window, None);
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
                let tray_last_hide = last_hide.clone();
                tray.on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                // Skip the re-open if the window was just auto-hidden
                                // by this same click stealing focus.
                                let since = now_ms()
                                    .saturating_sub(tray_last_hide.load(Ordering::Relaxed));
                                if since > REOPEN_DEBOUNCE_MS {
                                    show_flyout(&window, Some(position));
                                }
                            }
                        }
                    }
                });
            }

            // Flyout behaviour: hide on close request, and auto-hide when the
            // window loses focus (a click anywhere outside it).
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                let win_last_hide = last_hide.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                    WindowEvent::Focused(false) => {
                        win_last_hide.store(now_ms(), Ordering::Relaxed);
                        let _ = w.hide();
                    }
                    _ => {}
                });
            }

            // The main window is `visible: true`, so a normal launch shows it
            // unchanged. When the OS starts us at login (autostart passes
            // --autostarted) hide it so we come up silently in the tray.
            let autostarted = std::env::args().any(|a| a == "--autostarted");
            if autostarted {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            spawn_poll_loop(app.handle().clone(), notify);
            spawn_status_loop(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            configure,
            refresh_now,
            open_claude,
            ensure_project,
            start_session,
            get_usage_delta,
            get_usage_snapshots,
            get_latest_snapshots,
            ingest_cc_usage,
            get_forecast,
            get_analytics,
            get_analytics_compare,
            get_service_status,
            open_status_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
