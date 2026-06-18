pub mod alerts;
pub mod cc;
pub mod domain;
pub mod report;
pub mod stats;
pub mod status;
pub mod sysmon;
pub mod todos;
pub mod usage;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::Timelike;
use log::{error, info, warn};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tokio::sync::Notify;

use alerts::{tier_level, ActiveSession, AlertEngine, AppConfig};
use domain::{compute_levels, is_muted, today_spent_for, UsageLevels};
use report::{DiagReport, DiagStore};
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

// When pinned, the popup ignores focus-out and stays open until the user
// dismisses it (tray click or unpin). Shared between the focus-out handler and
// the `set_pin` command.
static PINNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Pin/unpin the popup. While pinned it won't auto-hide on focus loss (a click
/// outside the window), so the user can work in other windows with it open.
#[tauri::command]
fn set_pin(pinned: bool) {
    PINNED.store(pinned, std::sync::atomic::Ordering::Relaxed);
}

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

/// An error surfaced to the frontend. `reportable` tells the UI it can offer the
/// "Report a problem" button (a diagnostic report is waiting in `DiagStore`).
#[derive(Serialize, Clone)]
struct UsageError {
    message: String,
    reportable: bool,
}

// --- Diagnostics helpers ---

fn log_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|d| d.join(report::LOG_FILE_NAME))
}

/// Log the failure, build a diagnostic report (with the current log tail) and
/// stash it so the frontend can turn it into a pre-filled GitHub issue.
fn record_diag(app: &AppHandle, kind: &str, summary: &str, detail: String) {
    error!(target: "diag", "[{}] {}", kind, detail);
    let version = app.package_info().version.to_string();
    let log_file = log_file_path(app);
    let report = report::capture(kind, summary, detail, &version, log_file.as_deref());
    if let Some(store) = app.try_state::<Arc<DiagStore>>() {
        store.set(report);
    }
}

// --- Background polling loop: the single owner of business logic ---

const AUTO_START_COUNTDOWN_SECS: u64 = 10;
// 5 минут между попытками — короче ловит CF burst-limit и снова получает
// 429 на ровном месте (Mac-версия по той же причине использует 5-минутный
// цикл проверок).
const AUTO_START_RETRY_SECS: u64 = 300;
const AUTO_START_MAX_ATTEMPTS: u32 = 3;

#[derive(Default)]
enum AutoStartPhase {
    #[default]
    Idle,
    Pending { fires_at: Instant, attempt: u32 },
}

#[derive(Default)]
struct AutoStartCtx {
    done_this_window: bool,
    phase: AutoStartPhase,
}

#[derive(Serialize, Clone)]
struct AutoStartPendingEvent {
    fires_at_ms: i64,
    attempt: u32,
    countdown_secs: u64,
}

#[derive(Serialize, Clone)]
struct AutoStartCancelledEvent {
    reason: &'static str,
}

async fn run_cycle(
    app: &AppHandle,
    cfg: &AppConfig,
    ctx: &mut AutoStartCtx,
) -> Option<Instant> {
    let usage = match usage::fetch_usage(&cfg.session_key, &cfg.org_id).await {
        Ok(u) => u,
        Err(e) => {
            let msg = e.to_string();
            record_diag(
                app,
                "usage-fetch",
                "Не удалось получить данные об использовании",
                format!("fetch_usage failed: {}", msg),
            );
            let _ = app.emit(
                "usage-error",
                UsageError {
                    message: msg,
                    reportable: true,
                },
            );
            return None;
        }
    };

    if let Some(stats) = app.try_state::<Arc<StatsDb>>() {
        if let Err(e) = stats.record_snapshot(&usage) {
            warn!("Failed to record snapshot: {}", e);
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
        // Active-session snapshot for runtime tips (issue #46). Computed outside
        // the engine lock; idle time and rewrite-cost are derived here so the
        // engine stays time- and pricing-agnostic.
        let active_session = if cfg.runtime_insights_enabled {
            stats
                .as_ref()
                .and_then(|s| s.cc_active_session().ok().flatten())
                .map(|cs| {
                    // Gap between the latest turn and its predecessor — what
                    // labels a detected rewrite as idle vs compaction.
                    let gap_minutes = cs
                        .prev_ts
                        .as_deref()
                        .and_then(|p| {
                            let a = chrono::DateTime::parse_from_rfc3339(p).ok()?;
                            let b = chrono::DateTime::parse_from_rfc3339(&cs.last_ts).ok()?;
                            Some((b - a).num_seconds() as f64 / 60.0)
                        })
                        .unwrap_or(0.0)
                        .max(0.0);
                    // Actual USD the latest turn spent rebuilding the prefix.
                    let rewrite_cost = cc::cost_for(&cs.model, 0, 0, cs.last_cache_create, 0);
                    ActiveSession {
                        session_id: cs.session_id,
                        project: cs.project,
                        messages: cs.messages,
                        last_ts: cs.last_ts,
                        has_prev: cs.prev_ts.is_some(),
                        gap_minutes,
                        last_cache_read: cs.last_cache_read,
                        last_cache_create: cs.last_cache_create,
                        rewrite_cost_usd: rewrite_cost,
                    }
                })
        } else {
            None
        };
        let events = {
            let eng = app.state::<Mutex<AlertEngine>>();
            let mut e = eng.lock().unwrap();
            e.set_active_session(active_session);
            e.evaluate(&usage, cfg, now_min, delta.as_ref(), today_spent, muted)
        };
        for ev in events {
            let _ = app.emit("alert", ev);
        }
    }

    if !cfg.auto_start_session {
        if matches!(ctx.phase, AutoStartPhase::Pending { .. }) {
            ctx.phase = AutoStartPhase::Idle;
            let _ = app.emit(
                "auto-start-cancelled",
                AutoStartCancelledEvent { reason: "disabled" },
            );
        }
        ctx.done_this_window = false;
        return None;
    }

    let active = usage.five_hour.percent_used > 0.0 || usage.five_hour.reset_at.is_some();
    if active {
        ctx.done_this_window = false;
        if matches!(ctx.phase, AutoStartPhase::Pending { .. }) {
            ctx.phase = AutoStartPhase::Idle;
            let _ = app.emit(
                "auto-start-cancelled",
                AutoStartCancelledEvent { reason: "active" },
            );
        }
        return None;
    }

    if ctx.done_this_window {
        return None;
    }

    let now = Instant::now();
    let (fires_at, attempt) = match &ctx.phase {
        AutoStartPhase::Idle => {
            let fires_at = now + Duration::from_secs(AUTO_START_COUNTDOWN_SECS);
            let fires_at_ms = chrono::Utc::now().timestamp_millis()
                + (AUTO_START_COUNTDOWN_SECS as i64) * 1000;
            ctx.phase = AutoStartPhase::Pending {
                fires_at,
                attempt: 1,
            };
            let _ = app.emit(
                "auto-start-pending",
                AutoStartPendingEvent {
                    fires_at_ms,
                    attempt: 1,
                    countdown_secs: AUTO_START_COUNTDOWN_SECS,
                },
            );
            return Some(fires_at);
        }
        AutoStartPhase::Pending { fires_at, attempt } => (*fires_at, *attempt),
    };

    if now < fires_at {
        return Some(fires_at);
    }

    let success = auto_start(app, cfg).await;
    if success {
        ctx.done_this_window = true;
        ctx.phase = AutoStartPhase::Idle;
        return None;
    }

    if attempt >= AUTO_START_MAX_ATTEMPTS {
        ctx.done_this_window = true;
        ctx.phase = AutoStartPhase::Idle;
        let _ = app.emit(
            "auto-start-cancelled",
            AutoStartCancelledEvent {
                reason: "max-attempts",
            },
        );
        return None;
    }

    let next_at = Instant::now() + Duration::from_secs(AUTO_START_RETRY_SECS);
    let next_at_ms =
        chrono::Utc::now().timestamp_millis() + (AUTO_START_RETRY_SECS as i64) * 1000;
    let next_attempt = attempt + 1;
    ctx.phase = AutoStartPhase::Pending {
        fires_at: next_at,
        attempt: next_attempt,
    };
    let _ = app.emit(
        "auto-start-pending",
        AutoStartPendingEvent {
            fires_at_ms: next_at_ms,
            attempt: next_attempt,
            countdown_secs: AUTO_START_RETRY_SECS,
        },
    );
    Some(next_at)
}

async fn auto_start(app: &AppHandle, cfg: &AppConfig) -> bool {
    let mut project_id = cfg.project_id.clone();
    if project_id.is_empty() {
        match resolve_project(app, cfg).await {
            Ok(id) => project_id = id,
            Err(()) => return false,
        }
    }

    let mut tried_reresolve = false;
    loop {
        match usage::start_session_unchecked(&cfg.session_key, &cfg.org_id, &project_id).await {
            Ok(r) => {
                info!("Auto-start session: skipped={}", r.skipped);
                let _ = app.emit("auto-start-result", r.skipped);
                // Refresh UI immediately so the new active session is visible
                // without waiting for the next polling interval.
                if let Ok(usage) = usage::fetch_usage(&cfg.session_key, &cfg.org_id).await {
                    let rgba = tray_icon_for(usage.five_hour.percent_used, &cfg.session_thresholds);
                    if let Some(tray) = app.tray_by_id("main-tray") {
                        let icon = tauri::image::Image::new_owned(rgba, 32, 32);
                        let _ = tray.set_icon(Some(icon));
                    }
                    let levels = compute_levels(&usage, cfg);
                    let _ = app.emit("usage-updated", UsageUpdate { usage, levels });
                }
                return true;
            }
            Err(e) => {
                let msg = e.to_string();
                // Сохранённый project_id протух (проект удалили или сменили
                // org). Перерезолвим один раз и пробуем ещё раз — на следующий
                // tick polling-а не наступим на те же грабли.
                if !tried_reresolve && msg.contains("Create conversation error 404") {
                    tried_reresolve = true;
                    match resolve_project(app, cfg).await {
                        Ok(id) => {
                            project_id = id;
                            continue;
                        }
                        Err(()) => return false,
                    }
                }
                record_diag(
                    app,
                    "auto-start",
                    "Не удалось запустить авто-сессию",
                    format!("start_session failed: {}", msg),
                );
                let _ = app.emit("auto-start-error", msg);
                return false;
            }
        }
    }
}

async fn resolve_project(app: &AppHandle, cfg: &AppConfig) -> Result<String, ()> {
    match usage::ensure_project(&cfg.session_key, &cfg.org_id).await {
        Ok(p) => {
            let project_id = p.uuid;
            if let Some(c) = app.try_state::<Mutex<AppConfig>>() {
                c.lock().unwrap().project_id = project_id.clone();
            }
            // Let the frontend persist the resolved id back to the store.
            let _ = app.emit("project-resolved", project_id.clone());
            Ok(project_id)
        }
        Err(e) => {
            record_diag(
                app,
                "auto-start",
                "Не удалось создать/найти проект для авто-сессии",
                format!("ensure_project failed: {}", e),
            );
            let _ = app.emit("auto-start-error", e.to_string());
            Err(())
        }
    }
}

fn spawn_poll_loop(app: AppHandle, notify: Arc<Notify>) {
    tauri::async_runtime::spawn(async move {
        let mut ctx = AutoStartCtx::default();
        loop {
            let cfg = { app.state::<Mutex<AppConfig>>().lock().unwrap().clone() };
            let interval = cfg.refresh_interval.max(10);
            let next_deadline = if !cfg.session_key.is_empty() && !cfg.org_id.is_empty() {
                run_cycle(&app, &cfg, &mut ctx).await
            } else {
                None
            };
            let max_sleep = Duration::from_secs(interval);
            let sleep_dur = match next_deadline {
                Some(d) => {
                    let now = Instant::now();
                    if d <= now {
                        Duration::from_millis(50)
                    } else {
                        (d - now).min(max_sleep)
                    }
                }
                None => max_sleep,
            };
            tokio::select! {
                _ = tokio::time::sleep(sleep_dur) => {}
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
                        warn!("Service status fetch failed (attempt {}): {}", fail, e);
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

// --- System resource monitor (whole-machine CPU + RAM for the mini panel) ---

// How often the mini panel gets a fresh CPU/RAM reading.
const SYSMON_INTERVAL: Duration = Duration::from_secs(2);

// Mini window size per layout: compact 2×2 (CPU/RAM on) vs the original
// two-row 5h/7d bars (off). Logical px — applied on each `configure`.
const MINI_SIZE_FULL: (f64, f64) = (186.0, 64.0);
const MINI_SIZE_BARS: (f64, f64) = (180.0, 80.0);

/// Resize the mini window and tell it which layout to render. Called from
/// `configure` so a toggle in settings takes effect immediately.
fn apply_mini_layout(app: &AppHandle, system_info: bool) {
    if let Some(mini) = app.get_webview_window("mini") {
        let (w, h) = if system_info {
            MINI_SIZE_FULL
        } else {
            MINI_SIZE_BARS
        };
        let _ = mini.set_size(tauri::LogicalSize::new(w, h));
    }
    let _ = app.emit_to("mini", "system-info-enabled", system_info);
}

fn spawn_sysmon_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut sampler = sysmon::Sampler::new();
        loop {
            let enabled = {
                app.state::<Mutex<AppConfig>>()
                    .lock()
                    .unwrap()
                    .system_info_enabled
            };
            // Only sample while the feature is on AND the mini panel is on
            // screen — otherwise there's no consumer, so skip the work entirely.
            let visible = app
                .get_webview_window("mini")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);

            if enabled && visible {
                // CPU load is a delta between two refreshes: prime, let the
                // kernel counters settle, then read.
                sampler.prime();
                tokio::time::sleep(sysmon::Sampler::cpu_settle()).await;
                let stats = sampler.sample();
                let _ = app.emit_to("mini", "system-stats", stats);
            }

            tokio::time::sleep(SYSMON_INTERVAL).await;
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
    app: AppHandle,
    config: AppConfig,
    state: tauri::State<'_, Mutex<AppConfig>>,
    engine: tauri::State<'_, Mutex<AlertEngine>>,
    notify: tauri::State<'_, Arc<Notify>>,
) -> Result<(), String> {
    let disable = !config.notifications_enabled;
    let system_info = config.system_info_enabled;
    *state.lock().unwrap() = config;
    if disable {
        // Turning notifications off re-arms the engine for a clean next enable.
        engine.lock().unwrap().reset();
    }
    // Resize the mini window and push the layout flag to it.
    apply_mini_layout(&app, system_info);
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

/// Opens an external web URL in the default browser. Used by the About panel
/// (repo link, per-release pages) and by linkified text in tasks/comments.
/// Restricted to http/https so a malicious URL in a comment can't launch
/// `file:`, `javascript:` or a custom-scheme handler; http is allowed too since
/// this is a dev tool where `http://localhost:…` links are common.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Только http/https-ссылки".into());
    }
    open::that(url).map_err(|e| e.to_string())
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

/// Extended analytics for the standalone dashboard. `project` filters by
/// working-directory basename (None = all). `top_n` caps the costly-session
/// lists (per-metric, so cost vs cache_create stay separate).
#[tauri::command]
async fn get_analytics_ext(
    from: String,
    to: String,
    project: Option<String>,
    top_n: Option<usize>,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<stats::AnalyticsExt, String> {
    stats
        .analytics_ext(&from, &to, project.as_deref(), top_n.unwrap_or(10))
        .map_err(|e| e.to_string())
}

/// Dump the same extended bundle as a pretty-printed JSON string. The dashboard
/// surfaces this for the "Process with Claude Code" flow — the user copies it
/// into their CLI to ask for higher-order insights.
#[tauri::command]
async fn export_analytics_json(
    from: String,
    to: String,
    project: Option<String>,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<String, String> {
    let ext = stats
        .analytics_ext(&from, &to, project.as_deref(), 25)
        .map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&ext).map_err(|e| e.to_string())
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

/// Returns the pending diagnostic report, if any, so the frontend can offer to
/// file an issue. Does not clear it — the UI decides via `dismiss_diag`.
#[tauri::command]
fn get_last_diag(store: tauri::State<'_, Arc<DiagStore>>) -> Option<DiagReport> {
    store.get()
}

#[tauri::command]
fn dismiss_diag(store: tauri::State<'_, Arc<DiagStore>>) {
    store.clear();
}

/// Opens a pre-filled GitHub "new issue" page built from the pending report.
#[tauri::command]
fn report_issue(store: tauri::State<'_, Arc<DiagStore>>) -> Result<(), String> {
    let report = store.get().ok_or("Нет диагностического отчёта")?;
    let url = report::build_issue_url(&report);
    info!("Opening issue page for diag kind={}", report.kind);
    open::that(url).map_err(|e| e.to_string())
}

/// Show (and focus) the standalone analytics window. It's declared hidden in
/// tauri.conf and revealed on demand from the popup's "Подробнее" button.
/// The system [X] is intercepted in `setup` to hide rather than destroy the
/// window, so a lookup here is the single source of truth for its lifecycle.
#[tauri::command]
fn open_analytics_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("analytics") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        warn!("analytics window not found");
    }
}

/// Opens the folder containing the log file in the OS file manager.
#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    open::that(dir).map_err(|e| e.to_string())
}

/// Records an unhandled frontend error as a diagnostic report (so a JS crash is
/// reportable too) and logs it.
#[tauri::command]
fn report_frontend_error(app: AppHandle, summary: String, detail: String) {
    record_diag(&app, "frontend", &summary, detail);
}

// --- Todo / task-manager ---
//
// The tracker owns `todos.json` (in the app data dir): the user manages todos in
// the app, and a Claude Code SessionStart hook reads the same file to surface the
// active ones for the current project. See `todos.rs` for the schema/contract.

/// Path to the shared todo store, creating the app data dir if needed.
fn todos_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("todos.json"))
}

#[tauri::command]
fn get_todos(app: AppHandle) -> Result<Vec<todos::Todo>, String> {
    Ok(todos::load(&todos_path(&app)?).todos)
}

/// Distinct project names the tracker has seen (from cc_usage), for the
/// task-manager's project picker. Empty if analytics has never ingested.
#[tauri::command]
fn get_cc_projects(stats: tauri::State<'_, Arc<StatsDb>>) -> Result<Vec<String>, String> {
    stats.cc_projects().map_err(|e| e.to_string())
}

/// Last-seen `id -> status` map, shared between the file watcher and the write
/// commands. The watcher diffs the file against this to fire review/done alerts;
/// the commands refresh it under the same lock right after they write, so the
/// tracker's OWN edits never look like an external change (see `spawn_todos_watch`).
#[derive(Default)]
struct TodoSnapshot(Mutex<HashMap<String, String>>);

/// Pushed to the main window when a todo moves into `review`/`done` by an
/// external writer (the cc-todos CLI, a Claude session, a hand-edit).
#[derive(Serialize, Clone)]
struct TodoStatusAlert {
    subject: String,
    status: String,
    project: Option<String>,
}

fn todo_status_map(file: &todos::TodoFile) -> HashMap<String, String> {
    file.todos
        .iter()
        .map(|t| (t.id.clone(), t.status.clone()))
        .collect()
}

/// Mutate the todo store atomically AND keep [`TodoSnapshot`] in lockstep. The
/// snapshot is updated under the same lock the watcher takes, spanning the file
/// write, so the watcher can never observe the new file with a stale snapshot
/// and mistake the tracker's own write for an external one.
fn write_todos_locked(
    app: &AppHandle,
    mutate: impl FnOnce(&mut todos::TodoFile),
) -> Result<Vec<todos::Todo>, String> {
    let path = todos_path(app)?;
    let snap = app.state::<TodoSnapshot>();
    let mut guard = snap.0.lock().unwrap();
    let mut file = todos::load(&path);
    // Backfill task numbers for any legacy/hand-edited rows before mutating, so
    // every persisted file has stable `#N` references (upsert numbers new tasks).
    todos::ensure_numbers(&mut file);
    mutate(&mut file);
    todos::save(&path, &file)?;
    *guard = todo_status_map(&file);
    Ok(file.todos)
}

#[tauri::command]
fn upsert_todo(app: AppHandle, todo: todos::Todo) -> Result<Vec<todos::Todo>, String> {
    if !todos::is_valid_status(&todo.status) {
        return Err(format!("invalid status: {}", todo.status));
    }
    let now = chrono::Utc::now().to_rfc3339();
    write_todos_locked(&app, move |file| todos::upsert(file, todo, &now))
}

#[tauri::command]
fn delete_todo(app: AppHandle, id: String) -> Result<Vec<todos::Todo>, String> {
    write_todos_locked(&app, move |file| todos::delete(file, &id))
}

#[tauri::command]
fn set_todo_status(
    app: AppHandle,
    id: String,
    status: String,
) -> Result<Vec<todos::Todo>, String> {
    if !todos::is_valid_status(&status) {
        return Err(format!("invalid status: {status}"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    write_todos_locked(&app, move |file| {
        todos::set_status(file, &id, &status, &now);
    })
}

/// Show the standalone Todo window (declared hidden in tauri.conf.json).
#[tauri::command]
fn open_todo_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("todos") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        warn!("todos window not found");
    }
}

/// Background watcher: poll `todos.json`'s mtime and, on change, (1) emit
/// `todos-file-changed` so an open Todo window can live-reload, and (2) diff the
/// file against [`TodoSnapshot`] to fire a `todo-status-alert` when a todo moves
/// into `review`/`done` by an EXTERNAL writer (the cc-todos CLI, a Claude
/// session, a hand-edit). The tracker's own writes refresh the snapshot under
/// the same lock (see `write_todos_locked`), so they never produce an alert.
///
/// Polling (rather than a filesystem-notify crate) is deliberate: writes land
/// via temp-file + rename, which would invalidate a watch on the file path
/// itself, and one mtime stat every ~1.5s is far cheaper than the churn a
/// notifier would add. The live-reload echo from the tracker's own writes is
/// harmless (the frontend reload is silent and idempotent).
fn spawn_todos_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let path = match todos_path(&app) {
            Ok(p) => p,
            Err(_) => return,
        };
        let modified = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        // One-time migration: give every existing task a stable number so inline
        // `#N` references work even before the first edit this session. Done under
        // the snapshot lock so the resulting write isn't seen as an external change.
        {
            let snap = app.state::<TodoSnapshot>();
            let mut guard = snap.0.lock().unwrap();
            let mut file = todos::load(&path);
            if todos::ensure_numbers(&mut file) {
                let _ = todos::save(&path, &file);
            }
            *guard = todo_status_map(&file);
        }
        let mut last: Option<SystemTime> = modified(&path);
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let current = modified(&path);
            if current.is_none() {
                // File briefly absent (mid-rename) or never created — remember
                // so its (re)appearance counts as a change, but don't report it.
                last = None;
                continue;
            }
            if current == last {
                continue;
            }
            last = current;
            let _ = app.emit("todos-file-changed", ());

            // Diff statuses under the snapshot lock, spanning the file read, so a
            // concurrent command's write+snapshot-update is fully serialized
            // against us and can't look external.
            let alerts: Vec<TodoStatusAlert> = {
                let snap = app.state::<TodoSnapshot>();
                let mut guard = snap.0.lock().unwrap();
                let file = todos::load(&path);
                let mut out = Vec::new();
                for t in &file.todos {
                    let into_target = t.status == "review" || t.status == "done";
                    let changed = guard.get(&t.id).map(|s| s != &t.status).unwrap_or(false);
                    if into_target && changed {
                        out.push(TodoStatusAlert {
                            subject: t.subject.clone(),
                            status: t.status.clone(),
                            project: t.project.clone(),
                        });
                    }
                }
                *guard = todo_status_map(&file);
                out
            };
            if alerts.is_empty() {
                continue;
            }
            // Gated by a dedicated toggle, independent of `notifications_enabled`
            // (which gates usage alerts), so a task-manager-only user can get
            // these without turning on usage notifications.
            let enabled = app
                .state::<Mutex<AppConfig>>()
                .lock()
                .unwrap()
                .todo_notifications_enabled;
            if enabled {
                for a in alerts {
                    let _ = app.emit("todo-status-alert", a);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    report::install_panic_hook();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("claude-usage-tracker".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                // Our own modules are chattier on purpose — they hold the
                // diagnostics for "data won't fetch" reports.
                .level_for("claude_usage_tracker_lib", log::LevelFilter::Debug)
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let version = app.package_info().version.to_string();
            info!("Claude Usage Tracker v{} starting", version);

            // Diagnostics: route panics to a marker file in the log dir, and pick
            // up any report left by a crash on the previous run.
            let diag_store = Arc::new(DiagStore::default());
            if let Ok(log_dir) = app.path().app_log_dir() {
                std::fs::create_dir_all(&log_dir).ok();
                report::set_panic_file(&log_dir);
                if let Some(rep) = report::take_panic_report(&log_dir, &version) {
                    warn!("Recovered a crash report from the previous run");
                    diag_store.set(rep);
                }
            }
            app.manage(diag_store);

            // Stats database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("usage_stats.db");
            let stats_db = match StatsDb::open(&db_path) {
                Ok(db) => Arc::new(db),
                Err(e) => {
                    record_diag(
                        app.handle(),
                        "stats-db",
                        "Не удалось открыть базу статистики",
                        format!("StatsDb::open({:?}) failed: {}", db_path, e),
                    );
                    return Err(Box::new(e));
                }
            };

            let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
            stats_db.cleanup_before(&cutoff.to_rfc3339()).ok();
            app.manage(stats_db);

            // Business-logic state, owned by the backend loop.
            app.manage(Mutex::new(AppConfig::default()));
            app.manage(Mutex::new(AlertEngine::new()));
            app.manage(Arc::new(Mutex::new(StatusState::default())));
            app.manage(TodoSnapshot::default());
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
                        if !PINNED.load(Ordering::Relaxed) {
                            win_last_hide.store(now_ms(), Ordering::Relaxed);
                            let _ = w.hide();
                        }
                    }
                    _ => {}
                });
            }

            // Analytics window: hide on [X] instead of destroying. Keeps the
            // webview alive so `open_analytics_window` can simply show+focus it
            // every time — one canonical path, no re-create/white-screen race.
            if let Some(window) = app.get_webview_window("analytics") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // Todos window: same hide-on-[X] as analytics, so `open_todo_window`
            // can always show+focus the live webview instead of finding it gone.
            if let Some(window) = app.get_webview_window("todos") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            spawn_poll_loop(app.handle().clone(), notify);
            spawn_status_loop(app.handle().clone());
            spawn_sysmon_loop(app.handle().clone());
            spawn_todos_watch(app.handle().clone());

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
            open_url,
            get_last_diag,
            dismiss_diag,
            report_issue,
            open_log_dir,
            report_frontend_error,
            set_pin,
            open_analytics_window,
            get_analytics_ext,
            export_analytics_json,
            get_todos,
            get_cc_projects,
            upsert_todo,
            delete_todo,
            set_todo_status,
            open_todo_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
