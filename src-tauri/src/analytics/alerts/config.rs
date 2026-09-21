//! Config mirrored from the settings store, pushed via the `configure` command.

use serde::Deserialize;
use serde_json::Value;

use super::DEFAULT_THRESHOLDS;

#[derive(Clone, Debug, Deserialize)]
pub struct AlertTiers {
    pub five_hour: bool,
    pub seven_day: bool,
    pub seven_day_opus: bool,
    pub seven_day_sonnet: bool,
    pub extra_usage: bool,
}

impl Default for AlertTiers {
    fn default() -> Self {
        Self {
            five_hour: true,
            seven_day: true,
            seven_day_opus: true,
            seven_day_sonnet: true,
            extra_usage: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct AlertTypes {
    pub threshold: bool,
    pub reset: bool,
    pub forecast: bool,
}

impl Default for AlertTypes {
    fn default() -> Self {
        Self {
            threshold: true,
            reset: true,
            forecast: true,
        }
    }
}

fn default_forecast_window() -> u64 {
    60
}

/// Runtime-insight kinds enabled by default once the master toggle is on. Only
/// the two runtime-capable kinds exist in v1 — keep in sync with the engine's
/// `enabled(...)` checks and `runtimeCapable` in `insightKinds.ts`.
fn default_runtime_insight_kinds() -> Vec<String> {
    vec!["long_session".to_string(), "cold_rewrites".to_string()]
}

/// Normalizes persisted runtime kinds, migrating the pre-release name
/// `idle_cache_gap` → `cold_rewrites` so a settings.json written before the
/// rename keeps its runtime toggle. Only relevant while #46 is unreleased; can
/// be dropped once no old settings remain in the wild.

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub session_key: String,
    pub org_id: String,
    pub refresh_interval: u64,
    pub auto_start_session: bool,
    pub project_id: String,
    pub session_thresholds: Vec<f64>,
    pub weekly_thresholds: Vec<f64>,
    pub notifications_enabled: bool,
    pub forecast_minutes: f64,
    // Sliding window (minutes) for the burn-rate average behind the exhaustion
    // forecast (issue #7) and the forecast alert's delta.
    pub forecast_window_min: u64,
    pub quiet_hours_enabled: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
    pub alert_tiers: AlertTiers,
    pub alert_types: AlertTypes,
    // Opt-in: read local Claude Code transcripts for token/cost analytics. Off
    // by default — reads ~/.claude and must be explicitly enabled by the user.
    pub cc_analytics_enabled: bool,
    // Self-set daily budget. Unit is implied by `cc_analytics_enabled`:
    // dollars (CC cost) when on, percent of the weekly limit when off.
    pub daily_budget_enabled: bool,
    pub daily_budget: f64,
    // Snooze: while `now < muted_until`, alerts are queued like quiet hours.
    pub notifications_muted_until: Option<String>,
    // Todo status notifications: toast when a todo moves into review/done by an
    // EXTERNAL writer (the cc-todos CLI / a Claude session). Independent of
    // `notifications_enabled` (which gates usage alerts) so a task-manager-only
    // user gets these without turning on usage notifications. On by default.
    pub todo_notifications_enabled: bool,
    // Claude service-status indicator (status.claude.com). Independent of the
    // usage poll loop and of `notifications_enabled`.
    pub service_status_enabled: bool,
    pub service_status_interval: u64,
    pub service_status_notify: bool,
    // Memory-bloat watch (#33): notify when the active project's Claude memory
    // grows suddenly (a pasted log/blob). Independent of `notifications_enabled`.
    // On by default.
    pub memory_bloat_enabled: bool,
    // Runtime optimization tips (issue #46). Master opt-in, off by default — when
    // on, the engine evaluates the active Claude Code session each poll and toasts
    // the per-kind tips selected in `runtime_insight_kinds`.
    pub runtime_insights_enabled: bool,
    pub runtime_insight_kinds: Vec<String>,
    // Mini panel: show whole-machine CPU + RAM (the compact 2×2 layout). Off
    // reverts the mini to the original two-row 5h/7d bars. Gates the sysmon loop.
    pub system_info_enabled: bool,
    // Optional efficiency goals (issue: trend/goals). Pure thresholds — the
    // backend only stores them; the dashboard compares the live metric from
    // `get_analytics_ext` against the goal and colours the result. None = no goal
    // set. Distinct from `daily_budget` (a spend cap with its own alerting).
    //
    // Max $ per active hour the user wants to stay under (Productivity
    // `cost_per_active_hour`, same USD/hour unit).
    pub goal_cost_per_hour_max: Option<f64>,
    // Max acceptable tool error-rate, as a FRACTION 0..1 (e.g. 0.10 = 10%). The
    // frontend compares against `ToolErrorStats.error_rate`, which is a percent
    // (0..100), so it scales one side before the check.
    pub goal_error_rate_max: Option<f64>,
    // Outcome metric — user corrections mined from transcripts (t#101). Opt-in,
    // off by default: `corrections publish` is deterministic and LLM-free but reads
    // EVERY transcript, so it runs only when the user turns it on. Gates the
    // background publisher loop and the analytics Outcome card.
    pub corrections_enabled: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            session_key: String::new(),
            org_id: String::new(),
            refresh_interval: 60,
            auto_start_session: false,
            project_id: String::new(),
            session_thresholds: DEFAULT_THRESHOLDS.to_vec(),
            weekly_thresholds: DEFAULT_THRESHOLDS.to_vec(),
            notifications_enabled: false,
            forecast_minutes: 30.0,
            forecast_window_min: default_forecast_window(),
            quiet_hours_enabled: false,
            quiet_hours_start: "23:00".to_string(),
            quiet_hours_end: "08:00".to_string(),
            alert_tiers: AlertTiers::default(),
            alert_types: AlertTypes::default(),
            cc_analytics_enabled: false,
            daily_budget_enabled: false,
            daily_budget: 0.0,
            notifications_muted_until: None,
            todo_notifications_enabled: true,
            service_status_enabled: true,
            service_status_interval: 90,
            service_status_notify: true,
            memory_bloat_enabled: true,
            runtime_insights_enabled: false,
            runtime_insight_kinds: default_runtime_insight_kinds(),
            system_info_enabled: true,
            goal_cost_per_hour_max: None,
            goal_error_rate_max: None,
            corrections_enabled: false,
        }
    }
}

impl<'de> Deserialize<'de> for AppConfig {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v = Value::deserialize(d)?;
        Ok(AppConfig::from_value_lenient(&v))
    }
}

fn lenient_string(v: Option<&Value>, default: String) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => default,
    }
}

fn lenient_f64(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn lenient_u64(v: Option<&Value>, default: u64) -> u64 {
    lenient_f64(v)
        .filter(|f| *f >= 0.0)
        .map(|f| f.round() as u64)
        .unwrap_or(default)
}

fn lenient_bool(v: Option<&Value>, default: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" | "" => false,
            _ => default,
        },
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(default),
        _ => default,
    }
}

fn lenient_thresholds(v: Option<&Value>) -> Vec<f64> {
    let parsed: Vec<f64> = match v {
        Some(Value::Array(items)) => items.iter().filter_map(|x| lenient_f64(Some(x))).collect(),
        _ => Vec::new(),
    };
    if parsed.len() < 3 {
        return DEFAULT_THRESHOLDS.to_vec();
    }
    let mut three = vec![parsed[0], parsed[1], parsed[2]];
    three.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    three
}

fn lenient_opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn lenient_string_list(v: Option<&Value>, default: Vec<String>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|x| match x {
                Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .map(|k| {
                if k == "idle_cache_gap" {
                    "cold_rewrites".to_string()
                } else {
                    k
                }
            })
            .collect(),
        _ => default,
    }
}

fn lenient_tiers(v: Option<&Value>) -> AlertTiers {
    let mut t = AlertTiers::default();
    if let Some(Value::Object(m)) = v {
        t.five_hour = lenient_bool(m.get("five_hour"), t.five_hour);
        t.seven_day = lenient_bool(m.get("seven_day"), t.seven_day);
        t.seven_day_opus = lenient_bool(m.get("seven_day_opus"), t.seven_day_opus);
        t.seven_day_sonnet = lenient_bool(m.get("seven_day_sonnet"), t.seven_day_sonnet);
        t.extra_usage = lenient_bool(m.get("extra_usage"), t.extra_usage);
    }
    t
}

fn lenient_types(v: Option<&Value>) -> AlertTypes {
    let mut t = AlertTypes::default();
    if let Some(Value::Object(m)) = v {
        t.threshold = lenient_bool(m.get("threshold"), t.threshold);
        t.reset = lenient_bool(m.get("reset"), t.reset);
        t.forecast = lenient_bool(m.get("forecast"), t.forecast);
    }
    t
}

impl AppConfig {
    pub fn from_value_lenient(v: &Value) -> Self {
        let d = AppConfig::default();
        let empty = serde_json::Map::new();
        let m = v.as_object().unwrap_or(&empty);
        let g = |k: &str| m.get(k);
        AppConfig {
            session_key: lenient_string(g("session_key"), d.session_key)
                .trim()
                .to_string(),
            org_id: lenient_string(g("org_id"), d.org_id).trim().to_string(),
            refresh_interval: lenient_u64(g("refresh_interval"), d.refresh_interval),
            auto_start_session: lenient_bool(g("auto_start_session"), d.auto_start_session),
            project_id: lenient_string(g("project_id"), d.project_id),
            session_thresholds: lenient_thresholds(g("session_thresholds")),
            weekly_thresholds: lenient_thresholds(g("weekly_thresholds")),
            notifications_enabled: lenient_bool(
                g("notifications_enabled"),
                d.notifications_enabled,
            ),
            forecast_minutes: lenient_f64(g("forecast_minutes")).unwrap_or(d.forecast_minutes),
            forecast_window_min: lenient_u64(g("forecast_window_min"), d.forecast_window_min),
            quiet_hours_enabled: lenient_bool(g("quiet_hours_enabled"), d.quiet_hours_enabled),
            quiet_hours_start: lenient_string(g("quiet_hours_start"), d.quiet_hours_start),
            quiet_hours_end: lenient_string(g("quiet_hours_end"), d.quiet_hours_end),
            alert_tiers: lenient_tiers(g("alert_tiers")),
            alert_types: lenient_types(g("alert_types")),
            cc_analytics_enabled: lenient_bool(g("cc_analytics_enabled"), d.cc_analytics_enabled),
            daily_budget_enabled: lenient_bool(g("daily_budget_enabled"), d.daily_budget_enabled),
            daily_budget: lenient_f64(g("daily_budget")).unwrap_or(d.daily_budget),
            notifications_muted_until: lenient_opt_string(g("notifications_muted_until")),
            todo_notifications_enabled: lenient_bool(
                g("todo_notifications_enabled"),
                d.todo_notifications_enabled,
            ),
            service_status_enabled: lenient_bool(
                g("service_status_enabled"),
                d.service_status_enabled,
            ),
            service_status_interval: lenient_u64(
                g("service_status_interval"),
                d.service_status_interval,
            ),
            service_status_notify: lenient_bool(
                g("service_status_notify"),
                d.service_status_notify,
            ),
            memory_bloat_enabled: lenient_bool(g("memory_bloat_enabled"), d.memory_bloat_enabled),
            runtime_insights_enabled: lenient_bool(
                g("runtime_insights_enabled"),
                d.runtime_insights_enabled,
            ),
            runtime_insight_kinds: lenient_string_list(
                g("runtime_insight_kinds"),
                d.runtime_insight_kinds,
            ),
            system_info_enabled: lenient_bool(g("system_info_enabled"), d.system_info_enabled),
            goal_cost_per_hour_max: lenient_f64(g("goal_cost_per_hour_max")),
            goal_error_rate_max: lenient_f64(g("goal_error_rate_max")),
            corrections_enabled: lenient_bool(g("corrections_enabled"), d.corrections_enabled),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal JSON the frontend store sends — only the always-present fields.
    /// Everything `#[serde(default)]` (including the new goal thresholds) must
    /// fill in, so an old settings.json written before these fields existed still
    /// deserializes cleanly.
    const BASE_JSON: &str = r#"{
        "session_key": "k",
        "org_id": "o",
        "refresh_interval": 60,
        "auto_start_session": false,
        "project_id": "",
        "session_thresholds": [25.0, 50.0, 75.0],
        "weekly_thresholds": [25.0, 50.0, 75.0],
        "notifications_enabled": false,
        "forecast_minutes": 30.0,
        "quiet_hours_enabled": false,
        "quiet_hours_start": "23:00",
        "quiet_hours_end": "08:00",
        "alert_tiers": {
            "five_hour": true, "seven_day": true, "seven_day_opus": true,
            "seven_day_sonnet": true, "extra_usage": true
        },
        "alert_types": { "threshold": true, "reset": true, "forecast": true }
    }"#;

    #[test]
    fn old_config_without_goals_defaults_to_none() {
        // A settings.json predating the goal fields must not fail to parse.
        let cfg: AppConfig = serde_json::from_str(BASE_JSON).expect("base config parses");
        assert_eq!(cfg.goal_cost_per_hour_max, None);
        assert_eq!(cfg.goal_error_rate_max, None);
    }

    #[test]
    fn goals_round_trip_through_json() {
        // With the goals present they carry through verbatim.
        let with_goals = BASE_JSON.replace(
            "\"alert_types\": { \"threshold\": true, \"reset\": true, \"forecast\": true }",
            "\"alert_types\": { \"threshold\": true, \"reset\": true, \"forecast\": true },
             \"goal_cost_per_hour_max\": 12.5,
             \"goal_error_rate_max\": 0.1",
        );
        let cfg: AppConfig = serde_json::from_str(&with_goals).expect("config with goals parses");
        assert_eq!(cfg.goal_cost_per_hour_max, Some(12.5));
        assert_eq!(cfg.goal_error_rate_max, Some(0.1));
    }

    #[test]
    fn explicit_null_goals_deserialize_to_none() {
        // The frontend serialises an unset Option as null; that must be None.
        let with_null = BASE_JSON.replace(
            "\"alert_types\": { \"threshold\": true, \"reset\": true, \"forecast\": true }",
            "\"alert_types\": { \"threshold\": true, \"reset\": true, \"forecast\": true },
             \"goal_cost_per_hour_max\": null,
             \"goal_error_rate_max\": null",
        );
        let cfg: AppConfig =
            serde_json::from_str(&with_null).expect("config with null goals parses");
        assert_eq!(cfg.goal_cost_per_hour_max, None);
        assert_eq!(cfg.goal_error_rate_max, None);
    }

    #[test]
    fn string_numbers_and_null_strings_are_tolerated() {
        let raw = BASE_JSON
            .replace("\"refresh_interval\": 60", "\"refresh_interval\": \"45\"")
            .replace("\"forecast_minutes\": 30.0", "\"forecast_minutes\": \"15\"")
            .replace(
                "\"quiet_hours_start\": \"23:00\"",
                "\"quiet_hours_start\": null",
            )
            .replace(
                "\"auto_start_session\": false",
                "\"auto_start_session\": \"true\"",
            );
        let cfg: AppConfig = serde_json::from_str(&raw).expect("lenient parse");
        assert_eq!(cfg.refresh_interval, 45);
        assert_eq!(cfg.forecast_minutes, 15.0);
        assert_eq!(cfg.quiet_hours_start, "23:00");
        assert!(cfg.auto_start_session);
        assert_eq!(cfg.session_key, "k");
    }

    #[test]
    fn missing_and_garbage_fields_fall_back_to_defaults() {
        let raw = r#"{
            "session_key": "  k  ",
            "org_id": "o",
            "session_thresholds": "oops",
            "weekly_thresholds": [90, "10", 50, 99],
            "alert_tiers": "nope",
            "runtime_insight_kinds": ["idle_cache_gap", 7, "long_session"]
        }"#;
        let cfg: AppConfig = serde_json::from_str(raw).expect("lenient parse");
        let d = AppConfig::default();
        assert_eq!(cfg.session_key, "k");
        assert_eq!(cfg.refresh_interval, d.refresh_interval);
        assert_eq!(cfg.session_thresholds, DEFAULT_THRESHOLDS.to_vec());
        assert_eq!(cfg.weekly_thresholds, vec![10.0, 50.0, 90.0]);
        assert!(cfg.alert_tiers.five_hour);
        assert_eq!(cfg.quiet_hours_end, d.quiet_hours_end);
        assert_eq!(
            cfg.runtime_insight_kinds,
            vec!["cold_rewrites", "long_session"]
        );
        assert!(cfg.service_status_enabled);
    }

    #[test]
    fn non_object_payload_yields_defaults() {
        let cfg: AppConfig = serde_json::from_str("null").expect("null tolerated");
        assert_eq!(cfg.session_key, "");
        assert_eq!(cfg.refresh_interval, AppConfig::default().refresh_interval);
    }
}
