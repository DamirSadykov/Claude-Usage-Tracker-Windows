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
    // Claude service-status indicator (status.claude.com). Independent of the
    // usage poll loop and of `notifications_enabled`.
    #[serde(default = "default_true")]
    pub service_status_enabled: bool,
    #[serde(default = "default_status_interval")]
    pub service_status_interval: u64,
    #[serde(default = "default_true")]
    pub service_status_notify: bool,
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
            service_status_enabled: true,
            service_status_interval: 90,
            service_status_notify: true,
        }
    }
}
