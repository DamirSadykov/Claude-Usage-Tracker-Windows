pub mod alerts;
pub mod cc;
pub mod corrections;
pub mod domain;
pub mod enroll;
pub mod external;
pub mod identity;
pub mod memory;
pub mod phases;
pub mod project_groups;
pub mod report;
pub mod stats;
pub mod status;
pub mod sysmon;
pub mod todos;
pub mod triage;
pub mod triage_schedule;
pub mod usage;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
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

/// Non-production profile label ("Dev" / "Preview"), or None for prod. Storage
/// dirs, the single-instance mutex and the window/tray labels all key off the
/// identifier; this maps it to a short badge shared by setup() and the frontend.
fn env_label(identifier: &str) -> Option<&'static str> {
    match identifier {
        "com.claude-usage-tracker.dev" => Some("Dev"),
        "com.claude-usage-tracker.preview" => Some("Preview"),
        _ => None,
    }
}

/// Exposes the environment label to the frontend. The flyout and mini windows
/// are frameless (no native titlebar), so they render this as a header badge;
/// the framed windows already get the suffix via `set_title` in setup().
#[tauri::command]
fn app_env_label(app: AppHandle) -> Option<String> {
    env_label(&app.config().identifier).map(str::to_string)
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
/// `session_expired` flags the specific "cookie rejected" case so the UI can
/// point the user at the session key instead of the generic error/report path.
#[derive(Serialize, Clone)]
struct UsageError {
    message: String,
    reportable: bool,
    session_expired: bool,
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
            let session_expired = e.session_expired;
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
                    // An expired cookie isn't an app bug — don't invite a report,
                    // send the user to the session key instead.
                    reportable: !session_expired,
                    session_expired,
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

// --- Memory-bloat watch (#33): notify on sudden growth or a bloated index ---

/// Emitted when the active project's Claude memory grows suddenly (a pasted
/// log/blob), so the frontend can raise a desktop notification. Mirrors the
/// `service-alert` flow.
#[derive(Serialize, Clone)]
struct MemoryAlert {
    /// Human-friendly project label.
    project: String,
    /// Localizable detail, e.g. "+7 KB".
    detail: String,
}

/// Memory changes rarely and the scan only stats files, so a relaxed cadence
/// keeps this from ever being a load on disk.
const MEMORY_CHECK_INTERVAL: Duration = Duration::from_secs(120);

/// Round bytes to the nearest KB for display.
fn kb(bytes: u64) -> u64 {
    (bytes + 512) / 1024
}

fn spawn_memory_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Per-project debounced watcher, keyed by project so switching projects
        // resumes each one's baseline. Each only alerts once its total has
        // settled, so reorganizing memory (moving bytes between files without
        // changing the total) is silent — fixing the alert flood when a bloated
        // MEMORY.md is split into thematic files. See memory::Watch (#48). We only
        // scan the ACTIVE project, so an alert is about what you're working on now.
        let mut watches: HashMap<String, memory::Watch> = HashMap::new();

        loop {
            let enabled =
                { app.state::<Mutex<AppConfig>>().lock().unwrap().memory_bloat_enabled };
            if enabled {
                if let Some(s) = memory::scan() {
                    if let Some(delta) =
                        watches.entry(s.project.clone()).or_default().observe(&s)
                    {
                        let _ = app.emit(
                            "memory-alert",
                            MemoryAlert {
                                project: memory::label(&s.project),
                                detail: format!("+{} KB", kb(delta)),
                            },
                        );
                    }
                }
            }
            tokio::time::sleep(MEMORY_CHECK_INTERVAL).await;
        }
    });
}

// --- Nightly-triage watch (#35): notify when a fresh digest lands ---

/// Emitted when a fresh nightly-triage digest is written, so the frontend can
/// raise a desktop notification. Mirrors the `memory-alert` / `service-alert`
/// flow. The body is the digest's own `headline`; `project` is the board it
/// covered (may be empty for a board-wide note).
#[derive(Serialize, Clone)]
struct TriageAlert {
    headline: String,
    project: String,
}

/// The digest is rewritten at most once a night, so a relaxed cadence is plenty —
/// like the memory watch, this only reads one small file per tick.
const TRIAGE_CHECK_INTERVAL: Duration = Duration::from_secs(120);

fn spawn_triage_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let path = match triage_digest_path(&app) {
            Ok(p) => p,
            Err(_) => return,
        };
        // The `generated_at` of the digest we last saw. A fresh run carries a new
        // timestamp, so the same digest never fires twice. `None` = nothing seen
        // yet.
        let mut last_seen: Option<String> = None;
        // The first pass only records a baseline. A digest already on disk at
        // startup is shown by the in-app card (Phase 3); firing a desktop
        // notification on every app launch for an already-written digest would be
        // noise. The notification's value is "a fresh triage landed while you were
        // working".
        let mut first = true;

        loop {
            if let Some(d) = triage::load(&path) {
                if !d.generated_at.is_empty() && last_seen.as_deref() != Some(d.generated_at.as_str())
                {
                    // Gate the toast, but advance `last_seen` regardless — so
                    // toggling notifications off then on never replays a stale
                    // digest (unlike the memory loop, which skips its baseline
                    // update while disabled). Reuses the task-board toggle: a
                    // triage digest is the same family as a todo status change.
                    let enabled = app
                        .state::<Mutex<AppConfig>>()
                        .lock()
                        .unwrap()
                        .todo_notifications_enabled;
                    if !first && enabled {
                        let _ = app.emit(
                            "triage-alert",
                            TriageAlert {
                                headline: d.headline.clone(),
                                project: d.project.clone().unwrap_or_default(),
                            },
                        );
                    }
                    last_seen = Some(d.generated_at);
                }
            }
            first = false;
            tokio::time::sleep(TRIAGE_CHECK_INTERVAL).await;
        }
    });
}

// --- Nightly-triage SCHEDULER (#35): run the read-only triage once a day ---

/// How often the scheduler checks whether today's run is due. A minute is plenty —
/// this is a once-a-day, date-gated job, not a precise alarm.
const TRIAGE_SCHED_INTERVAL: Duration = Duration::from_secs(60);

/// Once-a-day loop: when enabled and the local clock has passed the configured
/// time and we haven't run today, spawn a headless `claude -p` triage. Gating on
/// "last completed run date != today" gives free catch-up — a slot missed while
/// the app was closed fires the moment the app is next open past the time. The run
/// blocks, so it goes on a worker thread.
fn spawn_triage_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TRIAGE_SCHED_INTERVAL).await;

            let dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(_) => continue,
            };
            let mut cfg = triage_schedule::load(&dir);
            if !cfg.enabled {
                continue;
            }
            let now = chrono::Local::now();
            let today = now.format("%Y-%m-%d").to_string();
            if cfg.last_run.as_deref() == Some(today.as_str()) {
                continue; // already ran today
            }
            if !triage_schedule::is_due(&now, &cfg.time) {
                continue; // not time yet
            }

            let cli = match cc_hook_script_path(&app) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let home = match app.path().home_dir() {
                Ok(h) => h,
                Err(_) => continue,
            };
            let model = cfg.model.clone();
            let (rdir, rhome) = (dir.clone(), home);
            let res = tokio::task::spawn_blocking(move || {
                triage_schedule::run_triage(&rhome, &rdir, &cli, &model)
            })
            .await;

            // Mark today done regardless of outcome (no retry storm); surface any
            // error to the UI via last_error.
            cfg.last_run = Some(today);
            cfg.last_error = match res {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(e) => Some(e.to_string()),
            };
            let _ = triage_schedule::save(&dir, &cfg);
        }
    });
}

// --- Corrections-outcome metric publisher (t#101) ---

// How often the loop wakes to check the toggle. Short so flipping the setting on
// takes effect within a tick, not a full publish interval.
const CORRECTIONS_CHECK_INTERVAL: Duration = Duration::from_secs(60);
// Minimum spacing between actual publishes. `corrections publish` reads every
// transcript, so it's paced — not run every check tick.
const CORRECTIONS_PUBLISH_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Independent, LLM-free publisher for the corrections-outcome metric. Unlike the
/// nightly triage (which drives an `claude -p` pass), `corrections publish` is a
/// deterministic transcript scan, so it runs on its own light timer regardless of
/// whether triage is enabled. Gated by `corrections_enabled`: publishes once soon
/// after the toggle goes on (and at startup if already on), then every
/// `CORRECTIONS_PUBLISH_INTERVAL`. Emits `corrections-updated` so an open analytics
/// window re-reads the file.
fn spawn_corrections_publisher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_publish: Option<Instant> = None;
        loop {
            let enabled = {
                app.state::<Mutex<AppConfig>>()
                    .lock()
                    .unwrap()
                    .corrections_enabled
            };
            let due = enabled
                && last_publish.map_or(true, |t| t.elapsed() >= CORRECTIONS_PUBLISH_INTERVAL);
            if due {
                if let Ok(cli) = cc_hook_script_path(&app) {
                    let res = tokio::task::spawn_blocking(move || {
                        triage_schedule::run_corrections_publish(&cli)
                    })
                    .await;
                    // Best-effort: a scan failure just means the card keeps its last
                    // data; log nothing louder than the existing diagnostics.
                    last_publish = Some(Instant::now());
                    if matches!(res, Ok(Ok(()))) {
                        let _ = app.emit("corrections-updated", ());
                    }
                }
            }
            tokio::time::sleep(CORRECTIONS_CHECK_INTERVAL).await;
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

// --- External-integration enrollment (plan External-integration-public-side, phase 4.2) ---

/// Sealed device-key file, a sibling of todos.json (identity.rs owns the format).
fn device_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("device_key.bin"))
}

/// Persisted binding (account this device bound to). Sibling of todos.json.
fn enrollment_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("enrollment.json"))
}

/// Dev-only at-rest store for non-Windows builds: the key blob is written as-is.
/// The shipping target is Windows, where the private key is DPAPI-sealed; this
/// exists only so the crate builds/tests on a dev mac/linux.
#[cfg(not(windows))]
struct PlainStore;
#[cfg(not(windows))]
impl identity::SecretStore for PlainStore {
    fn seal(&self, p: &[u8]) -> Result<Vec<u8>, String> {
        Ok(p.to_vec())
    }
    fn unseal(&self, c: &[u8]) -> Result<Vec<u8>, String> {
        Ok(c.to_vec())
    }
}

/// Load (or first-run generate) this device's Ed25519 identity. The private key
/// is DPAPI-sealed on Windows; a plaintext dev fallback is used off-Windows.
fn load_identity(app: &AppHandle) -> Result<identity::DeviceIdentity, String> {
    let path = device_key_path(app)?;
    #[cfg(windows)]
    {
        identity::load_or_create(&path, &identity::DpapiStore)
    }
    #[cfg(not(windows))]
    {
        identity::load_or_create(&path, &PlainStore)
    }
}

/// Public identity + current binding, for the enrollment UI.
#[derive(Serialize)]
struct EnrollmentStatus {
    device_id: String,
    public_key: String,
    account: Option<String>,
    enrolled_at: Option<String>,
}

/// A successful binding, returned to the enrollment UI.
#[derive(Serialize)]
struct BoundAccount {
    account: String,
    enrolled_at: String,
}

/// Device identity + whether this install is already bound to an account.
#[tauri::command]
fn enrollment_status(app: AppHandle) -> Result<EnrollmentStatus, String> {
    let identity = load_identity(&app)?;
    let state = enroll::EnrollmentState::load(&enrollment_path(&app)?)?;
    Ok(EnrollmentStatus {
        device_id: identity.device_id().to_string(),
        public_key: identity.public_key_b64(),
        account: state.account,
        enrolled_at: state.enrolled_at,
    })
}

/// Flow B: redeem the corp-issued pairing code the user typed in, binding this
/// device's public key to its account at the resolver's `/enroll/bind`. `Ok` on
/// success (binding persisted); `Err` on a bad/expired code (401), a missing
/// resolver URL, a network failure, or an unexpected status. The device does NOT
/// generate the code — the corp service does (see `enroll.rs`).
#[tauri::command]
async fn enroll_bind(app: AppHandle, code: String, url: String) -> Result<BoundAccount, String> {
    // Single-word arg names (`code`, `url`) so the JS↔Rust key mapping is identity
    // — no reliance on Tauri's camelCase→snake_case conversion. The resolver URL is
    // passed straight from the Integrations tab, so binding works with the value
    // the user just typed — no dependency on `configure` pushing it first.
    let resolver_url = url.trim().trim_end_matches('/').to_string();
    if resolver_url.is_empty() {
        return Err("Не задан URL resolver'а — укажите его в настройках".into());
    }
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("Введите код привязки".into());
    }

    let identity = load_identity(&app)?;
    let public_key = identity.public_key_b64();
    let device_id = identity.device_id().to_string();
    let body = enroll::BindRequest {
        proof: &code,
        public_key: &public_key,
        device_id: &device_id,
    };

    let resp = reqwest::Client::new()
        .post(format!("{resolver_url}/enroll/bind"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Не удалось связаться с resolver: {e}"))?;

    match resp.status() {
        reqwest::StatusCode::OK => {
            let parsed: enroll::BindResponse = resp.json().await.map_err(|e| e.to_string())?;
            let state = enroll::EnrollmentState {
                account: Some(parsed.account.clone()),
                enrolled_at: Some(parsed.enrolled_at.clone()),
                resolver_url: Some(resolver_url),
            };
            state.save(&enrollment_path(&app)?)?;
            Ok(BoundAccount {
                account: parsed.account,
                enrolled_at: parsed.enrolled_at,
            })
        }
        reqwest::StatusCode::UNAUTHORIZED => {
            Err("Код неверный или истёк — запросите новый код в корп-сервисе".into())
        }
        s => Err(format!("Resolver вернул неожиданный статус {s}")),
    }
}

/// Forget the local binding (does NOT unbind on the resolver — that is a later
/// concern). Lets the user re-run enrollment, e.g. after switching accounts.
#[tauri::command]
fn enroll_reset(app: AppHandle) -> Result<(), String> {
    let path = enrollment_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- External-integration poll client (plan External-integration-public-side, phase 5) ---

/// Readonly mirror of external tasks, a sibling of todos.json (external.rs owns the
/// format). The resolver-facing poll folds into this file; the UI reads it.
fn external_tasks_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("external_tasks.json"))
}

/// Emitted after a poll that produced status changes, so the frontend can raise a
/// desktop notification. Mirrors the `service-alert` / `memory-alert` flow; the
/// user designs the concrete UX on top of this on real data (phase 5 handoff).
#[derive(Serialize, Clone)]
struct ExternalTasksUpdate {
    /// The full mirror after this poll (freshest task first).
    tasks: Vec<external::ExternalTask>,
    /// Net status changes this poll surfaced (empty is never emitted).
    changes: Vec<external::StatusChange>,
}

/// Cadence of the background poll. External tasks change on human timescales, so a
/// relaxed minute keeps this off the network hot path; a manual `poll_external`
/// command lets the user refresh on demand between ticks.
const EXTERNAL_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Poll the resolver once, fold the delivered events into `external_tasks.json`,
/// and return the mirror + detected changes. `Ok(None)` when this device isn't
/// enrolled yet (no binding / no resolver URL) — a benign no-op, not an error, so
/// the background loop can call it every tick without spamming failures. On a
/// successful poll it also emits `external-tasks-updated` iff something changed.
async fn poll_external_once(app: &AppHandle) -> Result<Option<ExternalTasksUpdate>, String> {
    let state = enroll::EnrollmentState::load(&enrollment_path(app)?)?;
    let (Some(resolver_url), true) = (state.resolver_url.clone(), state.is_bound()) else {
        return Ok(None);
    };
    let resolver_url = resolver_url.trim_end_matches('/').to_string();

    let identity = load_identity(app)?;
    let device_id = identity.device_id().to_string();
    // RFC3339 with the resolver's expected precision; signed verbatim so no
    // reformatting can desync our signature from the resolver's challenge.
    let ts = chrono::Utc::now().to_rfc3339();
    let signature = identity.sign_b64(external::poll_challenge(&device_id, &ts).as_bytes());

    let body = external::PollRequest {
        device_id,
        ts: ts.clone(),
        signature,
    };

    let resp = reqwest::Client::new()
        .post(format!("{resolver_url}/poll"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Не удалось связаться с resolver: {e}"))?;

    let messages: Vec<external::MessageIn> = match resp.status() {
        reqwest::StatusCode::OK => resp.json().await.map_err(|e| e.to_string())?,
        reqwest::StatusCode::UNAUTHORIZED => {
            // The device's binding is gone/invalid (e.g. resolver store reset). Not
            // fatal to the app; the user can re-enroll from the Integrations tab.
            return Err("Устройство не авторизовано resolver'ом — привяжитесь заново".into());
        }
        s => return Err(format!("Resolver вернул неожиданный статус {s}")),
    };

    let path = external_tasks_path(app)?;
    let mut cache = external::ExternalTasksCache::load(&path)?;
    let changes = cache.apply(messages);
    cache.last_poll_at = Some(ts);
    cache.save(&path)?;

    let update = ExternalTasksUpdate {
        tasks: cache.tasks,
        changes,
    };
    if !update.changes.is_empty() {
        let _ = app.emit("external-tasks-updated", update.clone());
    }
    Ok(Some(update))
}

/// Manual refresh from the Integrations tab. `Ok(None)` = not enrolled (the UI
/// shows the enrollment prompt instead of a task list).
#[tauri::command]
async fn poll_external(app: AppHandle) -> Result<Option<ExternalTasksUpdate>, String> {
    poll_external_once(&app).await
}

/// The current mirror for the UI, without polling (fast, offline-friendly read).
#[tauri::command]
fn get_external_tasks(app: AppHandle) -> Result<external::ExternalTasksCache, String> {
    external::ExternalTasksCache::load(&external_tasks_path(&app)?)
}

/// Background poll loop: mirror external tasks while the device is enrolled. Skips
/// silently when unenrolled (returns `Ok(None)`), backs off on transient failures
/// so a resolver outage doesn't hammer the network.
fn spawn_external_poll_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fail: u32 = 0;
        loop {
            let mut sleep = EXTERNAL_POLL_INTERVAL;
            match poll_external_once(&app).await {
                Ok(_) => fail = 0,
                Err(e) => {
                    fail = fail.saturating_add(1);
                    warn!("External poll failed (attempt {}): {}", fail, e);
                    // Exponential backoff capped at ~16x, so a down resolver or a
                    // dropped binding doesn't retry every 60s in a tight loop.
                    let shift = fail.min(4);
                    sleep = EXTERNAL_POLL_INTERVAL.saturating_mul(1u32 << shift);
                }
            }
            tokio::time::sleep(sleep).await;
        }
    });
}

/// Path to the nightly-triage digest, a sibling of todos.json in the app data
/// dir (see triage.rs / the cc-triage CLI). Read-only from the tracker's side.
fn triage_digest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("triage-digest.json"))
}

/// The latest nightly-triage digest, or None if no run has produced one yet (or
/// the file is unreadable). The triage agent writes it via the cc-triage CLI;
/// the tracker only reads it.
#[tauri::command]
fn get_triage_digest(app: AppHandle) -> Result<Option<triage::TriageDigest>, String> {
    Ok(triage::load(&triage_digest_path(&app)?))
}

/// Path to the corrections-metrics file, a sibling of todos.json in the app data
/// dir (see corrections.rs / `cli.mjs corrections publish`). Read-only here.
fn corrections_metrics_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("corrections-metrics.json"))
}

/// The latest user-corrections metric (task t#101), or None if no `publish` has
/// produced one yet (or the file is unreadable). The CLI writes it; the tracker
/// only reads it to show the outcome card.
#[tauri::command]
fn get_corrections_metrics(
    app: AppHandle,
) -> Result<Option<corrections::CorrectionsMetrics>, String> {
    Ok(corrections::load(&corrections_metrics_path(&app)?))
}

/// Recompute the corrections metric now (runs `corrections publish --all` via
/// node) so the card can be refreshed on demand. Blocking work runs off the
/// async runtime; the frontend re-reads the freshened file when this resolves.
#[tauri::command]
async fn refresh_corrections_metrics(app: AppHandle) -> Result<(), String> {
    let cli = cc_hook_script_path(&app)?;
    tokio::task::spawn_blocking(move || triage_schedule::run_corrections_publish(&cli))
        .await
        .map_err(|e| e.to_string())?
}

/// Current nightly-triage schedule config (enabled / time / model + last-run
/// bookkeeping) for the in-app controls. Forgiving: defaults if never set.
#[tauri::command]
fn get_triage_schedule(app: AppHandle) -> Result<triage_schedule::ScheduleConfig, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(triage_schedule::load(&dir))
}

/// Persist the schedule from the UI toggle/time/model. Validates the time and
/// snaps the model; the scheduler loop picks up the change on its next tick.
#[tauri::command]
fn set_triage_schedule(
    app: AppHandle,
    enabled: bool,
    time: String,
    model: String,
) -> Result<triage_schedule::ScheduleConfig, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    let mut cfg = triage_schedule::load(&dir);
    cfg.enabled = enabled;
    cfg.time = triage_schedule::normalize_time(&time).ok_or("invalid time (use HH:MM)")?;
    cfg.model = triage_schedule::normalize_model(&model);
    triage_schedule::save(&dir, &cfg)?;
    Ok(cfg)
}

/// Run the triage once, right now (the "Run now" button). Blocks until `claude`
/// finishes so the UI can show the outcome; the digest lands via the watcher.
#[tauri::command]
async fn run_triage_now(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let cli = cc_hook_script_path(&app)?;
    let model = triage_schedule::load(&dir).model;
    tokio::task::spawn_blocking(move || triage_schedule::run_triage(&home, &dir, &cli, &model))
        .await
        .map_err(|e| e.to_string())?
}

/// The audit prompt for the settings editor: the effective text (custom override
/// or baked default) plus whether it's a user override.
#[tauri::command]
fn get_triage_prompt(app: AppHandle) -> Result<triage_schedule::PromptInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (text, is_custom) = triage_schedule::load_prompt(&dir);
    Ok(triage_schedule::PromptInfo { text, is_custom })
}

/// Save a custom audit prompt from the settings editor. An empty/whitespace value
/// resets to the baked default rather than persisting a prompt that can't run.
#[tauri::command]
fn set_triage_prompt(app: AppHandle, text: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    if text.trim().is_empty() {
        return triage_schedule::reset_prompt(&dir);
    }
    triage_schedule::save_prompt(&dir, &text)
}

/// Drop the custom audit prompt, reverting to the baked default; returns the
/// (now default) prompt so the editor can refresh in place.
#[tauri::command]
fn reset_triage_prompt(app: AppHandle) -> Result<triage_schedule::PromptInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    triage_schedule::reset_prompt(&dir)?;
    let (text, is_custom) = triage_schedule::load_prompt(&dir);
    Ok(triage_schedule::PromptInfo { text, is_custom })
}

/// Distinct project names the tracker has seen (from cc_usage), for the
/// task-manager's project picker. Empty if analytics has never ingested.
#[tauri::command]
fn get_cc_projects(stats: tauri::State<'_, Arc<StatsDb>>) -> Result<Vec<String>, String> {
    stats.cc_projects().map_err(|e| e.to_string())
}

/// RAW (un-merged) project names from cc_usage — the originals, for the "Projects"
/// management tab where the user decides what to merge into what.
#[tauri::command]
fn get_raw_projects(stats: tauri::State<'_, Arc<StatsDb>>) -> Result<Vec<String>, String> {
    stats.cc_raw_projects().map_err(|e| e.to_string())
}

/// All project merge links (alias→canonical, issue #13) for the management tab.
#[tauri::command]
fn get_project_links(stats: tauri::State<'_, Arc<StatsDb>>) -> Result<Vec<stats::ProjectLink>, String> {
    stats.project_links_all().map_err(|e| e.to_string())
}

/// Merge `alias` into `canonical`. The store normalizes to stay single-level and
/// returns a human-readable error (self-link, empty name, cycle) on rejection.
/// On success, broadcasts `project-links-changed` so every window re-reads — a
/// merge changes how usage aggregates everywhere, not just where it was triggered.
#[tauri::command]
fn set_project_link(
    alias: String,
    canonical: String,
    app: tauri::AppHandle,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<(), String> {
    stats.set_project_link(&alias, &canonical)?;
    let _ = app.emit("project-links-changed", ());
    Ok(())
}

/// Drop the merge for `alias`, restoring its own per-project line. Broadcasts
/// `project-links-changed` so all windows re-read (see `set_project_link`).
#[tauri::command]
fn remove_project_link(
    alias: String,
    app: tauri::AppHandle,
    stats: tauri::State<'_, Arc<StatsDb>>,
) -> Result<(), String> {
    stats.remove_project_link(&alias).map_err(|e| e.to_string())?;
    let _ = app.emit("project-links-changed", ());
    Ok(())
}

// --- Project association groups (issue #13, "who works with whom") ---
//
// Stored in `project-groups.json` next to `todos.json` so the cc-todos CLI (plain
// Node) can read it too — see project_groups.rs.

/// Path to the association-groups store, creating the app data dir if needed.
fn project_groups_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("project-groups.json"))
}

/// All association groups (peer "works-with" sets — not a stat merge).
#[tauri::command]
fn get_project_groups(app: AppHandle) -> Result<Vec<project_groups::ProjectGroup>, String> {
    Ok(project_groups::load(&project_groups_path(&app)?).groups)
}

/// Replace the whole set of association groups (the UI sends the full list).
/// Normalized + persisted atomically; broadcasts `project-groups-changed` so every
/// window re-reads.
#[tauri::command]
fn save_project_groups(
    groups: Vec<project_groups::ProjectGroup>,
    app: AppHandle,
) -> Result<(), String> {
    let file = project_groups::ProjectGroupsFile { version: 1, groups };
    project_groups::save(&project_groups_path(&app)?, &file)?;
    let _ = app.emit("project-groups-changed", ());
    Ok(())
}

// --- CLI + SessionStart hook installer ---
//
// The unified `cli.mjs` (todos / phases / hook areas) ships as bundled Node
// scripts (resources). "Install" = wire the hook into the user's
// ~/.claude/settings.json so Claude Code runs `cli.mjs hook` on every session
// start. The CLI areas need no separate wiring — the hook hands Claude the
// cli.mjs path and Claude calls `cli.mjs todos …` itself.

/// Absolute path to the unified `cli.mjs`, forward-slashed for a clean
/// settings.json command on Windows. In a packaged build it's the bundled
/// resource; in `tauri dev` it's the repo's `scripts/` (preferred there, since
/// the resource copy under target/ is wiped on rebuild).
fn cc_hook_script_path(app: &AppHandle) -> Result<String, String> {
    let resource = app
        .path()
        .resolve("scripts/cli.mjs", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    let dev = {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("cli.mjs");
        std::fs::canonicalize(&d).ok().filter(|p| p.exists())
    };
    let chosen = if cfg!(debug_assertions) {
        dev.or(resource)
    } else {
        resource.or(dev)
    };
    let p = chosen.ok_or_else(|| "cli.mjs not found (resource or dev path)".to_string())?;
    // Drop the Windows \\?\ prefix canonicalize adds, use forward slashes.
    let s = p.to_string_lossy().replace('\\', "/");
    Ok(s.strip_prefix("//?/").map(str::to_string).unwrap_or(s))
}

/// A SessionStart hook command that belongs to the tracker — either the unified
/// `cli.mjs … hook` or a legacy standalone `cc-todos-hook.mjs` from before the
/// CLI was unified. Used to detect our entry and re-wire it idempotently.
fn is_our_hook_command(cmd: &str) -> bool {
    cmd.contains("cli.mjs") || cmd.contains("cc-todos-hook.mjs")
}

/// The directory of the script in a `node "<path>"` hook command (the path is
/// the first double-quoted span). Used to locate, and then delete, the now-orphan
/// legacy `cc-*.mjs` scripts when migrating a pre-unification install to cli.mjs.
fn hook_command_script_dir(command: &str) -> Option<PathBuf> {
    let start = command.find('"')?;
    let rest = &command[start + 1..];
    let end = rest.find('"')?;
    PathBuf::from(&rest[..end]).parent().map(Path::to_path_buf)
}

/// Best-effort removal of the legacy standalone scripts left next to an old
/// `cc-todos-hook.mjs` after switching to the unified `cli.mjs`. Only ever
/// touches files with these exact names, and ignores every error (a missing
/// file, a read-only resource dir the updater already cleaned, etc.) — cleanup
/// must never make a re-install fail.
fn remove_legacy_scripts(dir: &Path) {
    for name in ["cc-todos-hook.mjs", "cc-todos.mjs", "cc-phases.mjs"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// `~/.claude/settings.json` — the global Claude Code config we wire the hook into.
fn claude_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".claude").join("settings.json"))
}

/// True if any SessionStart hook command references cc-todos-hook.mjs.
fn settings_has_cc_hook(v: &serde_json::Value) -> bool {
    v.get("hooks")
        .and_then(|h| h.get("SessionStart"))
        .and_then(|s| s.as_array())
        .is_some_and(|groups| {
            groups.iter().any(|g| {
                g.get("hooks").and_then(|h| h.as_array()).is_some_and(|hs| {
                    hs.iter().any(|hook| {
                        hook.get("command")
                            .and_then(|c| c.as_str())
                            .is_some_and(is_our_hook_command)
                    })
                })
            })
        })
}

#[derive(Serialize)]
struct CcHookStatus {
    installed: bool,
    script_path: String,
    settings_path: String,
}

/// Whether the SessionStart hook is already wired, plus the paths involved.
#[tauri::command]
fn cc_hook_status(app: AppHandle) -> Result<CcHookStatus, String> {
    let settings = claude_settings_path(&app)?;
    let installed = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| settings_has_cc_hook(&v))
        .unwrap_or(false);
    Ok(CcHookStatus {
        installed,
        script_path: cc_hook_script_path(&app).unwrap_or_default(),
        settings_path: settings.to_string_lossy().replace('\\', "/"),
    })
}

/// Wire the SessionStart hook into ~/.claude/settings.json. Idempotent: updates an
/// existing cc-todos entry's path in place, or appends a new group; preserves all
/// other hooks and keys. Atomic write (temp → rename). Returns the wired path.
#[tauri::command]
fn install_cc_hook(app: AppHandle) -> Result<String, String> {
    let script = cc_hook_script_path(&app)?;
    let command = format!("node \"{script}\" hook");
    let settings_path = claude_settings_path(&app)?;

    let mut root: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }

    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let ss = hooks
        .as_object_mut()
        .unwrap()
        .entry("SessionStart")
        .or_insert_with(|| serde_json::json!([]));
    if !ss.is_array() {
        *ss = serde_json::json!([]);
    }
    let groups = ss.as_array_mut().unwrap();

    // Update our command in place if already present (re-install / moved path).
    // While doing so, note the dir of any LEGACY (cc-todos-hook.mjs) entry so its
    // now-orphan cc-*.mjs scripts can be deleted after the write — migrating to
    // cli.mjs shouldn't leave the old standalone scripts piling up on disk.
    let mut updated = false;
    let mut legacy_dirs: Vec<PathBuf> = Vec::new();
    for g in groups.iter_mut() {
        if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            for hook in hs.iter_mut() {
                let old = hook
                    .get("command")
                    .and_then(|c| c.as_str())
                    .map(str::to_string);
                if old.as_deref().is_some_and(is_our_hook_command) {
                    if let Some(old_cmd) = &old {
                        if old_cmd.contains("cc-todos-hook.mjs") {
                            if let Some(dir) = hook_command_script_dir(old_cmd) {
                                legacy_dirs.push(dir);
                            }
                        }
                    }
                    hook["command"] = serde_json::Value::String(command.clone());
                    updated = true;
                }
            }
        }
    }
    if !updated {
        groups.push(serde_json::json!({
            "hooks": [ { "type": "command", "command": command } ]
        }));
    }

    if let Some(dir) = settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let tmp = settings_path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &settings_path).map_err(|e| e.to_string())?;

    // Settings now point at cli.mjs — clean up the orphaned legacy scripts next
    // to any old cc-todos-hook.mjs entry we just rewired (best-effort, never fatal).
    for dir in legacy_dirs {
        remove_legacy_scripts(&dir);
    }
    Ok(script)
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
    if !todos::is_valid_priority(&todo.priority) {
        return Err(format!("invalid priority: {}", todo.priority));
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

/// Add a dependency edge for the task graph (#88): `from_id` depends on `on_id`.
/// Validation (self/missing/cross-board/cycle) lives in [`todos::add_dep`]; a
/// rejection surfaces its message to the UI and the file is left untouched.
#[tauri::command]
fn add_todo_dep(
    app: AppHandle,
    from_id: String,
    on_id: String,
) -> Result<Vec<todos::Todo>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    // Capture the validation result out of the mutate closure so a rejected edge
    // fails the command (write_todos_locked still persists the untouched file,
    // which is a harmless no-op — nothing changed).
    let mut outcome = Ok(());
    let todos = write_todos_locked(&app, |file| {
        outcome = todos::add_dep(file, &from_id, &on_id, &now);
    })?;
    outcome.map(|()| todos)
}

/// Remove a dependency edge (`from_id` no longer depends on `on_id`). A no-op if
/// the edge was absent.
#[tauri::command]
fn remove_todo_dep(
    app: AppHandle,
    from_id: String,
    on_id: String,
) -> Result<Vec<todos::Todo>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    write_todos_locked(&app, move |file| {
        todos::remove_dep(file, &from_id, &on_id, &now);
    })
}

/// Result of a task-ref migration for the settings UI: how much was rewritten and
/// the backup taken first (empty `backup` when nothing changed → no backup made).
#[derive(Serialize, Clone)]
struct MigrationReport {
    refs: usize,
    tasks: usize,
    backup: String,
}

/// Migrate stored `#N` task references to the explicit `t#N` form (#63). Backs up
/// `todos.json` to a timestamped file BEFORE writing, so a wrong guess is one
/// "Откатить" click away. A dry pass first counts the work: if nothing would
/// change, it skips the backup and the write entirely.
#[tauri::command]
fn migrate_todo_refs(app: AppHandle) -> Result<MigrationReport, String> {
    let path = todos_path(&app)?;
    // Dry pass on a clone so we don't back up (or churn the file) for a no-op.
    let mut probe = todos::load(&path);
    let dry = todos::migrate_refs(&mut probe);
    if dry.refs == 0 {
        return Ok(MigrationReport { refs: 0, tasks: 0, backup: String::new() });
    }
    let backup = todos::backup(&path)?;
    // Re-run under the write lock so the snapshot stays in lockstep and the count
    // reflects exactly what was persisted.
    let mut stats = todos::MigrationStats::default();
    write_todos_locked(&app, |file| {
        stats = todos::migrate_refs(file);
    })?;
    Ok(MigrationReport { refs: stats.refs, tasks: stats.tasks, backup })
}

/// The most recent `todos.json` backup, or None if none exist — drives whether the
/// "Откатить" button is enabled and what timestamp it shows.
#[tauri::command]
fn latest_todo_backup(app: AppHandle) -> Result<Option<todos::BackupInfo>, String> {
    Ok(todos::latest_backup(&todos_path(&app)?))
}

/// Restore `todos.json` from a backup (the most recent when `name` is omitted),
/// undoing a migration or any bulk edit. The restored file is validated and
/// installed under the write lock; the file watcher then pushes the reload to the
/// todo window. Returns the restored list.
#[tauri::command]
fn restore_todo_backup(
    app: AppHandle,
    name: Option<String>,
) -> Result<Vec<todos::Todo>, String> {
    let path = todos_path(&app)?;
    let name = match name {
        Some(n) if !n.trim().is_empty() => n,
        _ => todos::latest_backup(&path).ok_or("Нет доступного бэкапа для отката")?.name,
    };
    let restored = todos::read_backup(&path, &name)?;
    write_todos_locked(&app, move |file| {
        *file = restored;
    })
}

/// Write the whole board to a file the user picked (#181). The frontend only opens
/// the OS save dialog and hands the path down — the file is written here, so the app
/// never needs a broad filesystem capability. Numbers are backfilled first so an
/// exported board always carries stable `#N` references. Returns the task count.
#[tauri::command]
fn export_todos(app: AppHandle, path: String) -> Result<usize, String> {
    let mut file = todos::load(&todos_path(&app)?);
    todos::ensure_numbers(&mut file);
    let count = file.todos.len();
    todos::save(std::path::Path::new(&path), &file)?;
    Ok(count)
}

/// Read an exported board and report what importing it WOULD do — nothing is
/// written. Backs the preview the user confirms before the merge runs.
#[tauri::command]
fn preview_todo_import(app: AppHandle, path: String) -> Result<todos::ImportReport, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let incoming = todos::parse_import(&content)?;
    let mut local = todos::load(&todos_path(&app)?);
    todos::ensure_numbers(&mut local);
    let now = chrono::Utc::now().to_rfc3339();
    let (_, report) = todos::merge_import(&local, &incoming, &now);
    Ok(report)
}

/// Merge an exported board into the local one and persist it (#181). Takes a backup
/// BEFORE writing (the merge only ever adds, but a bad file is one "Откатить" away),
/// then runs the merge under the write lock so the watcher's snapshot stays in
/// lockstep. An empty incoming file is a no-op: no backup, no write.
#[tauri::command]
fn apply_todo_import(app: AppHandle, path: String) -> Result<todos::ImportReport, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let incoming = todos::parse_import(&content)?;
    if incoming.todos.is_empty() {
        return Ok(todos::ImportReport::default());
    }
    let backup = todos::backup(&todos_path(&app)?)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut report = todos::ImportReport::default();
    write_todos_locked(&app, |file| {
        let (merged, r) = todos::merge_import(file, &incoming, &now);
        *file = merged;
        report = r;
    })?;
    report.backup = Some(backup);
    Ok(report)
}

/// All phase plans the tracker can find, across every project that has a
/// `.claude/phases/` dir. Read-only: the plans are authored by the `cc-phases`
/// CLI and live in each project. The frontend matches a plan to a task card by
/// (project basename, task_number). The disk walk (resolve project paths, read
/// each plan) runs off the async runtime so it can't stall the UI.
#[tauri::command]
async fn get_phase_plans() -> Result<Vec<phases::Plan>, String> {
    let claude = cc::claude_dir().ok_or("Cannot resolve Claude config directory")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for (base, path) in phases::project_paths(&claude) {
            out.extend(phases::read_plans(&base, &path));
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
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

/// Show the shared Settings window (declared hidden in tauri.conf.json) and tell
/// it which tab to open. Every screen's gear routes here, so settings live in one
/// canonical window instead of inline in each. `tab` falls back to "account".
fn show_settings_window(app: &AppHandle, tab: Option<String>) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        // The window is created hidden at startup, so its `settings-open` listener
        // is already registered by the time any gear is clicked (same pattern as
        // the todos-locale push). Emit after show so it switches tab immediately.
        let _ = win.emit("settings-open", tab.unwrap_or_else(|| "account".into()));
    } else {
        warn!("settings window not found");
    }
}

#[tauri::command]
fn open_settings_window(app: AppHandle, tab: Option<String>) {
    show_settings_window(&app, tab);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let version = app.package_info().version.to_string();
            info!("Claude Usage Tracker v{} starting", version);

            // Environment labelling for non-production profiles. A single
            // per-profile overlay (identifier) already isolates storage dirs and
            // the single-instance mutex; here we mirror it into the UI. Framed
            // windows (analytics/todos/settings) get the suffix on their native
            // title; the frameless flyout/mini render `app_env_label` as a badge.
            // The window array and tray tooltip are NOT duplicated in the JSON
            // overlay (JSON Merge Patch replaces arrays wholesale), and the
            // tooltip base is hardcoded (not productName) so preview never doubles.
            if let Some(label) = env_label(&app.config().identifier) {
                let suffix = format!(" ({label})");
                for (_win_label, window) in app.webview_windows() {
                    // "mini" ships with an empty title on purpose — leave it be.
                    if let Ok(current) = window.title() {
                        if !current.is_empty() {
                            let _ = window.set_title(&format!("{current}{suffix}"));
                        }
                    }
                }
                if let Some(tray) = app.tray_by_id("main-tray") {
                    let _ = tray.set_tooltip(Some(format!("Claude Usage Tracker{suffix}")));
                }
            }

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
                        show_settings_window(app, None);
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

            // Settings window: same hide-on-[X] so `open_settings_window` always
            // re-shows the one live webview (preserves its loaded state + listener).
            if let Some(window) = app.get_webview_window("settings") {
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
            spawn_memory_loop(app.handle().clone());
            spawn_triage_loop(app.handle().clone());
            spawn_triage_scheduler(app.handle().clone());
            spawn_corrections_publisher(app.handle().clone());
            spawn_external_poll_loop(app.handle().clone());

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
            app_env_label,
            open_analytics_window,
            get_analytics_ext,
            export_analytics_json,
            get_todos,
            get_corrections_metrics,
            refresh_corrections_metrics,
            get_triage_digest,
            get_triage_schedule,
            set_triage_schedule,
            run_triage_now,
            get_triage_prompt,
            set_triage_prompt,
            reset_triage_prompt,
            get_cc_projects,
            get_raw_projects,
            get_project_links,
            set_project_link,
            remove_project_link,
            get_project_groups,
            save_project_groups,
            install_cc_hook,
            cc_hook_status,
            upsert_todo,
            delete_todo,
            set_todo_status,
            add_todo_dep,
            remove_todo_dep,
            migrate_todo_refs,
            latest_todo_backup,
            restore_todo_backup,
            export_todos,
            preview_todo_import,
            apply_todo_import,
            get_phase_plans,
            open_todo_window,
            open_settings_window,
            enrollment_status,
            enroll_bind,
            enroll_reset,
            poll_external,
            get_external_tasks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod hook_install_tests {
    use super::*;

    #[test]
    fn recognizes_legacy_and_unified_hook_commands() {
        assert!(is_our_hook_command(r#"node "C:/app/scripts/cc-todos-hook.mjs""#));
        assert!(is_our_hook_command(r#"node "C:/app/scripts/cli.mjs" hook"#));
        assert!(!is_our_hook_command("node some-other-tool.mjs"));
    }

    #[test]
    fn extracts_script_dir_from_quoted_command() {
        let dir = hook_command_script_dir(r#"node "D:/x/scripts/cc-todos-hook.mjs""#);
        assert_eq!(dir, Some(PathBuf::from("D:/x/scripts")));
        // No quoted path → None (nothing to clean up).
        assert_eq!(hook_command_script_dir("node cli.mjs hook"), None);
    }

    #[test]
    fn removes_only_legacy_scripts_best_effort() {
        let dir = std::env::temp_dir().join("cut_hook_cleanup_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["cc-todos-hook.mjs", "cc-todos.mjs", "cc-phases.mjs", "keep.mjs"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        remove_legacy_scripts(&dir);
        assert!(!dir.join("cc-todos-hook.mjs").exists());
        assert!(!dir.join("cc-todos.mjs").exists());
        assert!(!dir.join("cc-phases.mjs").exists());
        assert!(dir.join("keep.mjs").exists()); // untouched
        // A second run over the now-clean dir must not error.
        remove_legacy_scripts(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
