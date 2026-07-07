//! Config mirrored from the settings store, pushed via the `configure` command.

use serde::Deserialize;

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
fn de_runtime_insight_kinds<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<String>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .map(|k| {
            if k == "idle_cache_gap" {
                "cold_rewrites".to_string()
            } else {
                k
            }
        })
        .collect())
}

#[derive(Clone, Debug, Deserialize)]
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
    #[serde(default = "default_forecast_window")]
    pub forecast_window_min: u64,
    pub quiet_hours_enabled: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
    pub alert_tiers: AlertTiers,
    pub alert_types: AlertTypes,
    // Opt-in: read local Claude Code transcripts for token/cost analytics. Off
    // by default — reads ~/.claude and must be explicitly enabled by the user.
    #[serde(default)]
    pub cc_analytics_enabled: bool,
    // Self-set daily budget. Unit is implied by `cc_analytics_enabled`:
    // dollars (CC cost) when on, percent of the weekly limit when off.
    #[serde(default)]
    pub daily_budget_enabled: bool,
    #[serde(default)]
    pub daily_budget: f64,
    // Snooze: while `now < muted_until`, alerts are queued like quiet hours.
    #[serde(default)]
    pub notifications_muted_until: Option<String>,
    // Todo status notifications: toast when a todo moves into review/done by an
    // EXTERNAL writer (the cc-todos CLI / a Claude session). Independent of
    // `notifications_enabled` (which gates usage alerts) so a task-manager-only
    // user gets these without turning on usage notifications. On by default.
    #[serde(default = "default_true")]
    pub todo_notifications_enabled: bool,
    // Claude service-status indicator (status.claude.com). Independent of the
    // usage poll loop and of `notifications_enabled`.
    #[serde(default = "default_true")]
    pub service_status_enabled: bool,
    #[serde(default = "default_status_interval")]
    pub service_status_interval: u64,
    #[serde(default = "default_true")]
    pub service_status_notify: bool,
    // Memory-bloat watch (#33): notify when the active project's Claude memory
    // grows suddenly (a pasted log/blob). Independent of `notifications_enabled`.
    // On by default.
    #[serde(default = "default_true")]
    pub memory_bloat_enabled: bool,
    // Runtime optimization tips (issue #46). Master opt-in, off by default — when
    // on, the engine evaluates the active Claude Code session each poll and toasts
    // the per-kind tips selected in `runtime_insight_kinds`.
    #[serde(default)]
    pub runtime_insights_enabled: bool,
    #[serde(
        default = "default_runtime_insight_kinds",
        deserialize_with = "de_runtime_insight_kinds"
    )]
    pub runtime_insight_kinds: Vec<String>,
    // Mini panel: show whole-machine CPU + RAM (the compact 2×2 layout). Off
    // reverts the mini to the original two-row 5h/7d bars. Gates the sysmon loop.
    #[serde(default = "default_true")]
    pub system_info_enabled: bool,
    // Optional efficiency goals (issue: trend/goals). Pure thresholds — the
    // backend only stores them; the dashboard compares the live metric from
    // `get_analytics_ext` against the goal and colours the result. None = no goal
    // set. Distinct from `daily_budget` (a spend cap with its own alerting).
    //
    // Max $ per active hour the user wants to stay under (Productivity
    // `cost_per_active_hour`, same USD/hour unit).
    #[serde(default)]
    pub goal_cost_per_hour_max: Option<f64>,
    // Max acceptable tool error-rate, as a FRACTION 0..1 (e.g. 0.10 = 10%). The
    // frontend compares against `ToolErrorStats.error_rate`, which is a percent
    // (0..100), so it scales one side before the check.
    #[serde(default)]
    pub goal_error_rate_max: Option<f64>,
    // Outcome metric — user corrections mined from transcripts (t#101). Opt-in,
    // off by default: `corrections publish` is deterministic and LLM-free but reads
    // EVERY transcript, so it runs only when the user turns it on. Gates the
    // background publisher loop and the analytics Outcome card.
    #[serde(default)]
    pub corrections_enabled: bool,
}

fn default_true() -> bool {
    true
}

fn default_status_interval() -> u64 {
    90
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
        let cfg: AppConfig = serde_json::from_str(&with_null).expect("config with null goals parses");
        assert_eq!(cfg.goal_cost_per_hour_max, None);
        assert_eq!(cfg.goal_error_rate_max, None);
    }
}
