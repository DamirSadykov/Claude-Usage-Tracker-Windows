//! Alert engine + threshold bucketing — the business logic that used to live in
//! the frontend (`src/alerts.ts` + `src/thresholds.ts`). Kept pure: `evaluate`
//! takes the current local minute-of-day and an optional usage delta injected by
//! the caller, so it is fully deterministic under `cargo test`. The engine only
//! decides *what* to notify; localization and the actual OS toast stay in the UI.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::stats::UsageDelta;
use crate::usage::{UsageData, UsageTier};

// --- Tuning constants (mirror the former alerts.ts) ---
const MIN_SPAN_MIN: f64 = 10.0; // need at least this much history to forecast
const MIN_RATE: f64 = 0.05; // %/min — below this is noise/flat
const MAX_PENDING: usize = 10;
const RESET_EPSILON: f64 = 1.0; // percent_used <= this counts as "reset"

const DEFAULT_THRESHOLDS: [f64; 3] = [25.0, 50.0, 75.0];

// --- Config mirrored from the settings store, pushed via `configure` ---

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

// --- Bucketing (single source of truth; the tray + UI levels use this) ---

/// Three thresholds, ascending. Falls back to defaults if fewer than three.
pub fn normalize(th: &[f64]) -> [f64; 3] {
    if th.len() < 3 {
        return DEFAULT_THRESHOLDS;
    }
    let mut s = [th[0], th[1], th[2]];
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    s
}

/// 0..3 — the number of thresholds the value has reached (green/yellow/orange/red).
pub fn tier_level(pct: f64, th: &[f64]) -> u8 {
    let [a, b, c] = normalize(th);
    if pct < a {
        0
    } else if pct < b {
        1
    } else if pct < c {
        2
    } else {
        3
    }
}

/// The 5-hour session has its own thresholds; every other tier shares the weekly set.
fn thresholds_for_tier<'a>(key: &str, cfg: &'a AppConfig) -> &'a [f64] {
    if key == "five_hour" {
        &cfg.session_thresholds
    } else {
        &cfg.weekly_thresholds
    }
}

fn parse_hm(s: &str) -> u32 {
    let mut it = s.split(':');
    let h: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let m: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    h * 60 + m
}

/// `now_min` is minutes since local midnight. Midnight-crossing windows supported.
pub fn in_quiet_hours(start: &str, end: &str, now_min: u32) -> bool {
    let s = parse_hm(start);
    let e = parse_hm(end);
    if s == e {
        return false;
    }
    if s < e {
        now_min >= s && now_min < e
    } else {
        now_min >= s || now_min < e
    }
}

// --- Alert events (typed; the UI localizes & toasts them) ---

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AlertEvent {
    /// Crossed up into a higher colour bucket. `pct` is the threshold reached.
    Threshold { tier: String, pct: f64 },
    /// Hit 100% / is_limited.
    Limit { tier: String },
    /// A previously-used tier reset back to fresh.
    Reset { tier: String },
    /// Session is forecast to end within the configured window. `eta_minutes` raw.
    Forecast { eta_minutes: f64 },
    /// Today's consumption reached the self-set daily budget. `unit` = "usd"|"pct".
    Budget { spent: f64, budget: f64, unit: String },
    /// Aggregated alerts that were suppressed during quiet hours.
    CatchUp { count: usize, items: Vec<AlertEvent> },
}

#[derive(Clone, Default)]
struct TierState {
    fired_level: i8, // highest colour level already notified (0..3), -1 = none
    fired_limit: bool,
    prev_percent: Option<f64>,
}

#[derive(Default)]
pub struct AlertEngine {
    tiers: HashMap<String, TierState>,
    fired_forecast: bool,
    fired_budget: bool,
    primed: bool,
    pending: Vec<AlertEvent>,
}

impl AlertEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clears all state — call when notifications get turned off so the next
    /// enable starts fresh (re-primes instead of replaying old thresholds).
    pub fn reset(&mut self) {
        self.tiers.clear();
        self.fired_forecast = false;
        self.fired_budget = false;
        self.primed = false;
        self.pending.clear();
    }

    /// Returns the events that should be toasted *now* (already past quiet-hours
    /// gating). `now_min` = local minutes-of-day; `delta` = recent usage delta
    /// for the forecast (None disables forecasting this cycle).
    pub fn evaluate(
        &mut self,
        usage: &UsageData,
        cfg: &AppConfig,
        now_min: u32,
        delta: Option<&UsageDelta>,
        today_spent: Option<f64>,
        muted: bool,
    ) -> Vec<AlertEvent> {
        let mut out = Vec::new();
        if !cfg.notifications_enabled {
            return out;
        }

        // Single suppression gate: quiet hours OR an active snooze. Anything
        // dispatched while suppressed is queued and flushed (as catch-up) once
        // both windows are clear.
        let suppressed = (cfg.quiet_hours_enabled
            && in_quiet_hours(&cfg.quiet_hours_start, &cfg.quiet_hours_end, now_min))
            || muted;

        self.flush_pending(suppressed, &mut out);

        if cfg.alert_tiers.five_hour {
            self.eval_tier("five_hour", Some(&usage.five_hour), cfg, suppressed, &mut out);
        }
        if cfg.alert_tiers.seven_day {
            self.eval_tier("seven_day", Some(&usage.seven_day), cfg, suppressed, &mut out);
        }
        if cfg.alert_tiers.seven_day_opus {
            self.eval_tier(
                "seven_day_opus",
                usage.seven_day_opus.as_ref(),
                cfg,
                suppressed,
                &mut out,
            );
        }
        if cfg.alert_tiers.seven_day_sonnet {
            self.eval_tier(
                "seven_day_sonnet",
                usage.seven_day_sonnet.as_ref(),
                cfg,
                suppressed,
                &mut out,
            );
        }
        if cfg.alert_tiers.extra_usage {
            if let Some(eu) = &usage.extra_usage {
                let synth = UsageTier {
                    percent_used: eu.utilization,
                    reset_at: None,
                    is_limited: eu.utilization >= 100.0,
                };
                self.eval_tier("extra_usage", Some(&synth), cfg, suppressed, &mut out);
            }
        }

        // First pass only primes state (per-tier priming happens in eval_tier).
        if !self.primed {
            self.primed = true;
            return out;
        }

        if cfg.alert_tiers.five_hour && cfg.alert_types.forecast {
            self.eval_forecast(usage, cfg, suppressed, delta, &mut out);
        }

        self.eval_budget(cfg, today_spent, suppressed, &mut out);

        out
    }

    /// Fires once when today's consumption crosses the daily budget; re-arms
    /// when the spend drops back below it (i.e. the day rolls over).
    fn eval_budget(
        &mut self,
        cfg: &AppConfig,
        today_spent: Option<f64>,
        suppressed: bool,
        out: &mut Vec<AlertEvent>,
    ) {
        if !cfg.daily_budget_enabled || cfg.daily_budget <= 0.0 {
            return;
        }
        let spent = match today_spent {
            Some(s) => s,
            None => return,
        };
        if spent < cfg.daily_budget {
            self.fired_budget = false;
            return;
        }
        if self.fired_budget {
            return;
        }
        self.fired_budget = true;
        let unit = if cfg.cc_analytics_enabled { "usd" } else { "pct" };
        self.dispatch(
            AlertEvent::Budget {
                spent,
                budget: cfg.daily_budget,
                unit: unit.to_string(),
            },
            suppressed,
            out,
        );
    }

    fn eval_tier(
        &mut self,
        key: &str,
        cur: Option<&UsageTier>,
        cfg: &AppConfig,
        suppressed: bool,
        out: &mut Vec<AlertEvent>,
    ) {
        let cur = match cur {
            Some(c) => c,
            None => return,
        };
        let th = thresholds_for_tier(key, cfg);
        let level = tier_level(cur.percent_used, th);

        // Work on a copy to avoid holding a mutable borrow of `self.tiers` while
        // we later call `self.dispatch`.
        let mut st = self.tiers.get(key).cloned().unwrap_or_default();

        // First sighting (startup, or tier appeared) → prime, don't fire.
        if st.prev_percent.is_none() {
            st.prev_percent = Some(cur.percent_used);
            st.fired_level = level as i8;
            if cur.is_limited || cur.percent_used >= 100.0 {
                st.fired_limit = true;
            }
            self.tiers.insert(key.to_string(), st);
            return;
        }

        let prev = st.prev_percent.unwrap();
        // A reset = a tier we'd seen consumed (prev above the floor) is now fresh.
        // We deliberately do NOT treat a change of `reset_at` alone as a reset:
        // the reported window can drift between polls while the tier sits near 0%
        // (right after a reset, before any usage), which fired duplicate
        // "you can work again" alerts.
        let did_reset = prev > RESET_EPSILON && cur.percent_used <= RESET_EPSILON;

        let mut event: Option<AlertEvent> = None;
        let mut clear_forecast = false;

        if did_reset {
            st.fired_level = level as i8;
            st.fired_limit = false;
            if key == "five_hour" {
                clear_forecast = true;
            }
            // Extra usage resets monthly — re-arm silently, no "you can work again".
            if key != "extra_usage" && cfg.alert_types.reset {
                event = Some(AlertEvent::Reset {
                    tier: key.to_string(),
                });
            }
        } else if (cur.is_limited || cur.percent_used >= 100.0) && !st.fired_limit {
            // Limit takes precedence (counts as a threshold-type alert).
            st.fired_limit = true;
            st.fired_level = 3;
            if cfg.alert_types.threshold {
                event = Some(AlertEvent::Limit {
                    tier: key.to_string(),
                });
            }
        } else if (level as i8) > st.fired_level {
            // Crossed up into a higher colour bucket — notify once per bucket.
            st.fired_level = level as i8;
            if cfg.alert_types.threshold && level >= 1 {
                let norm = normalize(th);
                let reached = norm[(level - 1) as usize];
                event = Some(AlertEvent::Threshold {
                    tier: key.to_string(),
                    pct: reached,
                });
            }
        }

        st.prev_percent = Some(cur.percent_used);
        self.tiers.insert(key.to_string(), st);

        if clear_forecast {
            self.fired_forecast = false;
        }
        if let Some(ev) = event {
            self.dispatch(ev, suppressed, out);
        }
    }

    fn eval_forecast(
        &mut self,
        usage: &UsageData,
        cfg: &AppConfig,
        suppressed: bool,
        delta: Option<&UsageDelta>,
        out: &mut Vec<AlertEvent>,
    ) {
        let fh = &usage.five_hour;
        if self.fired_forecast || fh.is_limited || fh.percent_used >= 100.0 {
            return;
        }
        let delta = match delta {
            Some(d) => d,
            None => return,
        };

        let from = match chrono::DateTime::parse_from_rfc3339(&delta.from_timestamp) {
            Ok(d) => d,
            Err(_) => return,
        };
        let to = match chrono::DateTime::parse_from_rfc3339(&delta.to_timestamp) {
            Ok(d) => d,
            Err(_) => return,
        };
        let span_min = (to - from).num_milliseconds() as f64 / 60000.0;
        if span_min < MIN_SPAN_MIN {
            return;
        }
        let rate = delta.five_hour_delta / span_min; // %/min
        if rate < MIN_RATE {
            return;
        }
        let eta = (100.0 - fh.percent_used) / rate;
        if eta <= cfg.forecast_minutes {
            self.fired_forecast = true;
            self.dispatch(AlertEvent::Forecast { eta_minutes: eta }, suppressed, out);
        }
    }

    fn dispatch(&mut self, ev: AlertEvent, suppressed: bool, out: &mut Vec<AlertEvent>) {
        if suppressed {
            self.pending.push(ev);
            if self.pending.len() > MAX_PENDING {
                self.pending.remove(0);
            }
            return;
        }
        out.push(ev);
    }

    fn flush_pending(&mut self, suppressed: bool, out: &mut Vec<AlertEvent>) {
        if self.pending.is_empty() {
            return;
        }
        if suppressed {
            return;
        }
        if self.pending.len() == 1 {
            out.push(self.pending.remove(0));
        } else {
            let items = std::mem::take(&mut self.pending);
            out.push(AlertEvent::CatchUp {
                count: items.len(),
                items,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::ExtraUsage;

    fn tier(pct: f64, reset: Option<&str>, limited: bool) -> UsageTier {
        UsageTier {
            percent_used: pct,
            reset_at: reset.map(|s| s.to_string()),
            is_limited: limited,
        }
    }

    fn usage(five: UsageTier, seven: UsageTier) -> UsageData {
        UsageData {
            five_hour: five,
            seven_day: seven,
            seven_day_opus: None,
            seven_day_sonnet: None,
            extra_usage: None,
            prepaid_balance: None,
            prepaid_currency: None,
        }
    }

    fn cfg() -> AppConfig {
        AppConfig {
            session_key: "k".into(),
            org_id: "o".into(),
            notifications_enabled: true,
            ..Default::default()
        }
    }

    /// Prime then run one more cycle — the priming pass swallows the first state.
    fn prime(eng: &mut AlertEngine, u: &UsageData, c: &AppConfig) {
        let _ = eng.evaluate(u, c, 0, None, None, false);
    }

    // --- bucketing ---

    #[test]
    fn normalize_sorts_and_defaults() {
        assert_eq!(normalize(&[75.0, 25.0, 50.0]), [25.0, 50.0, 75.0]);
        assert_eq!(normalize(&[10.0]), DEFAULT_THRESHOLDS);
        assert_eq!(normalize(&[]), DEFAULT_THRESHOLDS);
    }

    #[test]
    fn tier_level_boundaries() {
        let th = [25.0, 50.0, 75.0];
        assert_eq!(tier_level(0.0, &th), 0);
        assert_eq!(tier_level(24.9, &th), 0);
        assert_eq!(tier_level(25.0, &th), 1); // boundary is inclusive at the top
        assert_eq!(tier_level(49.9, &th), 1);
        assert_eq!(tier_level(50.0, &th), 2);
        assert_eq!(tier_level(74.9, &th), 2);
        assert_eq!(tier_level(75.0, &th), 3);
        assert_eq!(tier_level(100.0, &th), 3);
    }

    #[test]
    fn quiet_hours_same_day_and_midnight() {
        assert!(in_quiet_hours("09:00", "17:00", 10 * 60));
        assert!(!in_quiet_hours("09:00", "17:00", 8 * 60));
        // crosses midnight 23:00 → 08:00
        assert!(in_quiet_hours("23:00", "08:00", 23 * 60 + 30));
        assert!(in_quiet_hours("23:00", "08:00", 2 * 60));
        assert!(!in_quiet_hours("23:00", "08:00", 12 * 60));
        // degenerate equal window = always off
        assert!(!in_quiet_hours("10:00", "10:00", 10 * 60));
    }

    // --- priming ---

    #[test]
    fn first_pass_primes_and_is_silent() {
        let mut eng = AlertEngine::new();
        let c = cfg();
        let u = usage(tier(80.0, Some("r"), false), tier(0.0, None, false));
        let out = eng.evaluate(&u, &c, 0, None, None, false);
        assert!(out.is_empty(), "priming pass must emit nothing");
    }

    // --- threshold ---

    #[test]
    fn threshold_fires_once_per_bucket() {
        let mut eng = AlertEngine::new();
        let c = cfg();
        let u0 = usage(tier(10.0, Some("r"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);

        // cross into orange (>=50)
        let u1 = usage(tier(55.0, Some("r"), false), tier(0.0, None, false));
        let out = eng.evaluate(&u1, &c, 0, None, None, false);
        assert_eq!(
            out,
            vec![AlertEvent::Threshold {
                tier: "five_hour".into(),
                pct: 50.0
            }]
        );

        // same bucket again → silent
        let u2 = usage(tier(60.0, Some("r"), false), tier(0.0, None, false));
        assert!(eng.evaluate(&u2, &c, 0, None, None, false).is_empty());
    }

    #[test]
    fn limit_takes_precedence_over_threshold() {
        let mut eng = AlertEngine::new();
        let c = cfg();
        let u0 = usage(tier(10.0, Some("r"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);

        let u1 = usage(tier(100.0, Some("r"), true), tier(0.0, None, false));
        let out = eng.evaluate(&u1, &c, 0, None, None, false);
        assert_eq!(
            out,
            vec![AlertEvent::Limit {
                tier: "five_hour".into()
            }]
        );
        // doesn't re-fire
        assert!(eng.evaluate(&u1, &c, 0, None, None, false).is_empty());
    }

    // --- reset ---

    #[test]
    fn reset_detected_and_rearms() {
        let mut eng = AlertEngine::new();
        let c = cfg();
        let u0 = usage(tier(80.0, Some("r1"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);

        let u1 = usage(tier(0.0, None, false), tier(0.0, None, false));
        let out = eng.evaluate(&u1, &c, 0, None, None, false);
        assert_eq!(
            out,
            vec![AlertEvent::Reset {
                tier: "five_hour".into()
            }]
        );

        // after reset, climbing again fires threshold (re-armed)
        let u2 = usage(tier(30.0, Some("r2"), false), tier(0.0, None, false));
        let out2 = eng.evaluate(&u2, &c, 0, None, None, false);
        assert_eq!(
            out2,
            vec![AlertEvent::Threshold {
                tier: "five_hour".into(),
                pct: 25.0
            }]
        );
    }

    #[test]
    fn reset_fires_once_even_if_reset_at_drifts() {
        // After a reset the tier sits near 0% while the API may report a new
        // `reset_at` each poll. That drift must NOT re-fire the reset alert.
        let mut eng = AlertEngine::new();
        let c = cfg();
        let u0 = usage(tier(18.0, Some("r1"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);

        // window expires → fresh session, new reset_at → single reset
        let u1 = usage(tier(0.0, Some("r2"), false), tier(0.0, None, false));
        let out = eng.evaluate(&u1, &c, 0, None, None, false);
        assert_eq!(
            out,
            vec![AlertEvent::Reset {
                tier: "five_hour".into()
            }]
        );

        // still fresh (0%) but reset_at drifted again → must stay silent
        let u2 = usage(tier(0.0, Some("r3"), false), tier(0.0, None, false));
        assert!(
            eng.evaluate(&u2, &c, 0, None, None, false).is_empty(),
            "reset_at drift at ~0% must not re-fire the reset alert"
        );
    }

    #[test]
    fn extra_usage_reset_is_silent() {
        let mut eng = AlertEngine::new();
        let c = cfg();
        let mk = |util: f64| UsageData {
            extra_usage: Some(ExtraUsage {
                used_credits: 0.0,
                monthly_limit: 30.0,
                utilization: util,
                currency: "USD".into(),
            }),
            ..usage(tier(0.0, None, false), tier(0.0, None, false))
        };
        prime(&mut eng, &mk(80.0), &c);
        let out = eng.evaluate(&mk(0.0), &c, 0, None, None, false);
        assert!(out.is_empty(), "extra_usage reset must be silent");
    }

    // --- gating ---

    #[test]
    fn per_type_threshold_gate_silences() {
        let mut eng = AlertEngine::new();
        let mut c = cfg();
        c.alert_types.threshold = false;
        let u0 = usage(tier(10.0, Some("r"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);
        let u1 = usage(tier(80.0, Some("r"), false), tier(0.0, None, false));
        assert!(eng.evaluate(&u1, &c, 0, None, None, false).is_empty());
    }

    #[test]
    fn per_tier_gate_skips_seven_day() {
        let mut eng = AlertEngine::new();
        let mut c = cfg();
        c.alert_tiers.seven_day = false;
        let u0 = usage(tier(0.0, None, false), tier(10.0, Some("r"), false));
        prime(&mut eng, &u0, &c);
        let u1 = usage(tier(0.0, None, false), tier(80.0, Some("r"), false));
        assert!(eng.evaluate(&u1, &c, 0, None, None, false).is_empty());
    }

    #[test]
    fn session_and_weekly_use_their_own_thresholds() {
        let mut eng = AlertEngine::new();
        let mut c = cfg();
        c.session_thresholds = vec![80.0, 90.0, 95.0];
        c.weekly_thresholds = vec![25.0, 50.0, 75.0];
        let u0 = usage(tier(10.0, Some("r"), false), tier(10.0, Some("r"), false));
        prime(&mut eng, &u0, &c);

        // 60% — below session(80) so no 5h alert, but above weekly orange(50)
        let u1 = usage(tier(60.0, Some("r"), false), tier(60.0, Some("r"), false));
        let out = eng.evaluate(&u1, &c, 0, None, None, false);
        assert_eq!(
            out,
            vec![AlertEvent::Threshold {
                tier: "seven_day".into(),
                pct: 50.0
            }]
        );
    }

    // --- forecast ---

    fn delta(from: &str, to: &str, fh: f64) -> UsageDelta {
        UsageDelta {
            from_timestamp: from.into(),
            to_timestamp: to.into(),
            five_hour_delta: fh,
            seven_day_delta: 0.0,
            opus_delta: None,
            sonnet_delta: None,
        }
    }

    /// Config with only the forecast alert type enabled, so threshold crossings
    /// on the 5h tier don't add noise to the assertions.
    fn forecast_cfg() -> AppConfig {
        let mut c = cfg();
        c.alert_types.threshold = false;
        c.alert_types.reset = false;
        c
    }

    #[test]
    fn forecast_fires_within_window() {
        let mut eng = AlertEngine::new();
        let c = forecast_cfg(); // forecast_minutes = 30
        let u0 = usage(tier(40.0, Some("r"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);

        // 50%/60min = 0.833 %/min; remaining 50% → eta ~60min. Too far.
        let far = delta("2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", 50.0);
        let u1 = usage(tier(50.0, Some("r"), false), tier(0.0, None, false));
        assert!(eng.evaluate(&u1, &c, 0, Some(&far), None, false).is_empty());

        // steep: 80% over 60min → 1.333 %/min; remaining 40% → eta 30min ≤ 30.
        let mut eng2 = AlertEngine::new();
        prime(&mut eng2, &u0, &c);
        let steep = delta("2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", 80.0);
        let u2 = usage(tier(60.0, Some("r"), false), tier(0.0, None, false));
        let out = eng2.evaluate(&u2, &c, 0, Some(&steep), None, false);
        assert!(matches!(out.as_slice(), [AlertEvent::Forecast { .. }]));
        // fires only once
        assert!(eng2.evaluate(&u2, &c, 0, Some(&steep), None, false).is_empty());
    }

    #[test]
    fn forecast_guards() {
        let mut eng = AlertEngine::new();
        let c = forecast_cfg();
        let u0 = usage(tier(40.0, Some("r"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);
        let u1 = usage(tier(60.0, Some("r"), false), tier(0.0, None, false));

        // no delta
        assert!(eng.evaluate(&u1, &c, 0, None, None, false).is_empty());
        // span too short (5min)
        let short = delta("2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", 50.0);
        assert!(eng.evaluate(&u1, &c, 0, Some(&short), None, false).is_empty());
        // rate too low (1% over 60min)
        let flat = delta("2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", 1.0);
        assert!(eng.evaluate(&u1, &c, 0, Some(&flat), None, false).is_empty());
    }

    // --- quiet hours / catch-up ---

    #[test]
    fn quiet_hours_queue_then_single_flush() {
        let mut eng = AlertEngine::new();
        let mut c = cfg();
        c.quiet_hours_enabled = true;
        c.quiet_hours_start = "00:00".into();
        c.quiet_hours_end = "08:00".into();
        let u0 = usage(tier(10.0, Some("r"), false), tier(0.0, None, false));
        prime(&mut eng, &u0, &c);

        // during quiet hours (02:00) — one threshold gets queued, not emitted
        let u1 = usage(tier(80.0, Some("r"), false), tier(0.0, None, false));
        let out = eng.evaluate(&u1, &c, 2 * 60, None, None, false);
        assert!(out.is_empty());

        // later, outside quiet hours (10:00) — single pending flushes directly
        let out2 = eng.evaluate(&u1, &c, 10 * 60, None, None, false);
        assert_eq!(
            out2,
            vec![AlertEvent::Threshold {
                tier: "five_hour".into(),
                pct: 75.0
            }]
        );
    }

    #[test]
    fn quiet_hours_multiple_become_catchup() {
        let mut eng = AlertEngine::new();
        let mut c = cfg();
        c.quiet_hours_enabled = true;
        c.quiet_hours_start = "00:00".into();
        c.quiet_hours_end = "08:00".into();
        let u0 = usage(tier(10.0, Some("r"), false), tier(10.0, Some("r"), false));
        prime(&mut eng, &u0, &c);

        // two tiers cross during quiet hours
        let u1 = usage(tier(80.0, Some("r"), false), tier(80.0, Some("r"), false));
        assert!(eng.evaluate(&u1, &c, 2 * 60, None, None, false).is_empty());

        let out = eng.evaluate(&u1, &c, 10 * 60, None, None, false);
        match out.as_slice() {
            [AlertEvent::CatchUp { count, items }] => {
                assert_eq!(*count, 2);
                assert_eq!(items.len(), 2);
            }
            other => panic!("expected catch-up, got {:?}", other),
        }
    }

    // --- daily budget ---

    fn budget_cfg(enabled: bool, budget: f64, cc: bool) -> AppConfig {
        let mut c = cfg();
        c.daily_budget_enabled = enabled;
        c.daily_budget = budget;
        c.cc_analytics_enabled = cc;
        c
    }

    #[test]
    fn budget_fires_once_and_rearms() {
        let mut eng = AlertEngine::new();
        let c = budget_cfg(true, 10.0, true);
        let u = usage(tier(0.0, None, false), tier(0.0, None, false));
        prime(&mut eng, &u, &c);

        // below budget → silent
        assert!(eng.evaluate(&u, &c, 0, None, Some(5.0), false).is_empty());

        // crosses budget → one Budget event in dollars
        let out = eng.evaluate(&u, &c, 0, None, Some(12.0), false);
        assert_eq!(
            out,
            vec![AlertEvent::Budget {
                spent: 12.0,
                budget: 10.0,
                unit: "usd".into()
            }]
        );

        // still over → no repeat
        assert!(eng.evaluate(&u, &c, 0, None, Some(15.0), false).is_empty());

        // day rolls over (spend resets below budget) → re-arm, then fire again
        assert!(eng.evaluate(&u, &c, 0, None, Some(1.0), false).is_empty());
        let out2 = eng.evaluate(&u, &c, 0, None, Some(11.0), false);
        assert!(matches!(out2.as_slice(), [AlertEvent::Budget { .. }]));
    }

    #[test]
    fn budget_unit_is_pct_without_cc() {
        let mut eng = AlertEngine::new();
        let c = budget_cfg(true, 15.0, false);
        let u = usage(tier(0.0, None, false), tier(0.0, None, false));
        prime(&mut eng, &u, &c);
        let out = eng.evaluate(&u, &c, 0, None, Some(20.0), false);
        assert_eq!(
            out,
            vec![AlertEvent::Budget {
                spent: 20.0,
                budget: 15.0,
                unit: "pct".into()
            }]
        );
    }

    #[test]
    fn budget_disabled_is_silent() {
        let mut eng = AlertEngine::new();
        let c = budget_cfg(false, 10.0, true);
        let u = usage(tier(0.0, None, false), tier(0.0, None, false));
        prime(&mut eng, &u, &c);
        assert!(eng.evaluate(&u, &c, 0, None, Some(99.0), false).is_empty());
    }

    #[test]
    fn budget_muted_then_catches_up() {
        let mut eng = AlertEngine::new();
        let c = budget_cfg(true, 10.0, true);
        let u = usage(tier(0.0, None, false), tier(0.0, None, false));
        prime(&mut eng, &u, &c);

        // muted → queued, nothing emitted now
        assert!(eng.evaluate(&u, &c, 0, None, Some(12.0), true).is_empty());

        // unmuted → single pending flushes directly
        let out = eng.evaluate(&u, &c, 0, None, Some(12.0), false);
        assert_eq!(
            out,
            vec![AlertEvent::Budget {
                spent: 12.0,
                budget: 10.0,
                unit: "usd".into()
            }]
        );
    }
}
