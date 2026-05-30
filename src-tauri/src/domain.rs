//! Pure-ish business logic, kept free of Tauri/UI types so it can be unit-tested
//! directly: usage→colour-bucket mapping, the daily-budget "consumed today"
//! computation, and the snooze (mute) check.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::alerts::{tier_level, AppConfig};
use crate::stats::StatsDb;
use crate::usage::UsageData;

/// Per-tier colour buckets (0..3) pushed to the frontend alongside raw usage.
#[derive(Serialize, Clone)]
pub struct UsageLevels {
    pub five_hour: u8,
    pub seven_day: u8,
    pub seven_day_opus: Option<u8>,
    pub seven_day_sonnet: Option<u8>,
    pub extra_usage: Option<u8>,
}

/// Map each usage tier to its colour bucket. The 5-hour session uses its own
/// thresholds; every other tier shares the weekly set.
pub fn compute_levels(u: &UsageData, cfg: &AppConfig) -> UsageLevels {
    let weekly = &cfg.weekly_thresholds;
    UsageLevels {
        five_hour: tier_level(u.five_hour.percent_used, &cfg.session_thresholds),
        seven_day: tier_level(u.seven_day.percent_used, weekly),
        seven_day_opus: u
            .seven_day_opus
            .as_ref()
            .map(|t| tier_level(t.percent_used, weekly)),
        seven_day_sonnet: u
            .seven_day_sonnet
            .as_ref()
            .map(|t| tier_level(t.percent_used, weekly)),
        extra_usage: u
            .extra_usage
            .as_ref()
            .map(|e| tier_level(e.utilization, weekly)),
    }
}

// --- Daily budget & snooze helpers ---

/// Start of the current local day, expressed as a UTC RFC3339 string (matches
/// how snapshots/cc_usage timestamps are stored).
pub fn local_midnight_rfc3339() -> String {
    let today = chrono::Local::now().date_naive();
    let midnight = today.and_hms_opt(0, 0, 0).unwrap();
    midnight
        .and_local_timezone(chrono::Local)
        .single()
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// Consumed-today as percent of the weekly limit: current minus the day's
/// starting baseline, clamped at 0 so a mid-day reset (current < baseline)
/// reads as 0 rather than negative. Missing baseline falls back to `current`.
fn daily_pct_spent(current: f64, baseline: Option<f64>) -> f64 {
    (current - baseline.unwrap_or(current)).max(0.0)
}

/// Consumption since local midnight, in the unit implied by `cc_analytics_enabled`:
/// dollars (CC cost) when on, percent of the weekly limit when off. `None` when
/// the budget is disabled (or when the CC cost query fails).
pub fn today_spent_for(
    stats: &StatsDb,
    cfg: &AppConfig,
    usage: &UsageData,
    now: &str,
) -> Option<f64> {
    if !cfg.daily_budget_enabled {
        return None;
    }
    let from = local_midnight_rfc3339();
    if cfg.cc_analytics_enabled {
        stats.cost_in(&from, now).ok()
    } else {
        let current = usage.seven_day.percent_used;
        let baseline = stats.seven_day_baseline(&from, now).ok().flatten();
        Some(daily_pct_spent(current, baseline))
    }
}

pub fn is_muted(muted_until: Option<&str>, now: DateTime<Utc>) -> bool {
    match muted_until.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(until) => now < until.with_timezone(&Utc),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;
    use crate::stats::CcUsageRow;
    use crate::usage::{ExtraUsage, UsageTier};

    fn tier(pct: f64) -> UsageTier {
        UsageTier {
            percent_used: pct,
            reset_at: None,
            is_limited: false,
        }
    }

    fn at(ts: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(ts).unwrap().with_timezone(&Utc)
    }

    // --- is_muted -----------------------------------------------------------

    #[test]
    fn is_muted_none_is_not_muted() {
        assert!(!is_muted(None, at("2026-05-29T12:00:00Z")));
    }

    #[test]
    fn is_muted_malformed_is_not_muted() {
        assert!(!is_muted(Some("not-a-timestamp"), at("2026-05-29T12:00:00Z")));
    }

    #[test]
    fn is_muted_future_until_is_muted() {
        let now = at("2026-05-29T12:00:00Z");
        assert!(is_muted(Some("2026-05-29T13:00:00Z"), now));
    }

    #[test]
    fn is_muted_past_until_is_not_muted() {
        let now = at("2026-05-29T12:00:00Z");
        assert!(!is_muted(Some("2026-05-29T11:00:00Z"), now));
    }

    #[test]
    fn is_muted_boundary_now_equals_until_is_not_muted() {
        // `now < until` is strict, so the exact deadline is already un-muted.
        let now = at("2026-05-29T12:00:00Z");
        assert!(!is_muted(Some("2026-05-29T12:00:00Z"), now));
    }

    #[test]
    fn is_muted_respects_offset_timezone() {
        // until = 12:00+02:00 == 10:00Z; now = 11:00Z is past it.
        let now = at("2026-05-29T11:00:00Z");
        assert!(!is_muted(Some("2026-05-29T12:00:00+02:00"), now));
    }

    // --- compute_levels -----------------------------------------------------

    fn levels_cfg() -> AppConfig {
        AppConfig {
            session_thresholds: vec![10.0, 20.0, 30.0],
            weekly_thresholds: vec![25.0, 50.0, 75.0],
            ..AppConfig::default()
        }
    }

    #[test]
    fn compute_levels_uses_session_vs_weekly_thresholds() {
        let cfg = levels_cfg();
        let u = UsageData {
            five_hour: tier(15.0),            // session [10,20,30] -> 1
            seven_day: tier(60.0),            // weekly [25,50,75] -> 2
            seven_day_opus: Some(tier(80.0)), // weekly -> 3
            seven_day_sonnet: None,
            extra_usage: Some(ExtraUsage {
                used_credits: 1.0,
                monthly_limit: 100.0,
                utilization: 5.0, // weekly -> 0
                currency: "USD".into(),
            }),
            prepaid_balance: None,
            prepaid_currency: None,
        };
        let l = compute_levels(&u, &cfg);
        assert_eq!(l.five_hour, 1);
        assert_eq!(l.seven_day, 2);
        assert_eq!(l.seven_day_opus, Some(3));
        assert_eq!(l.seven_day_sonnet, None);
        assert_eq!(l.extra_usage, Some(0));
    }

    // --- daily_pct_spent (pure clamp / baseline fallback) -------------------

    #[test]
    fn daily_pct_spent_no_baseline_is_zero() {
        assert_eq!(daily_pct_spent(42.0, None), 0.0);
    }

    #[test]
    fn daily_pct_spent_positive_delta() {
        assert!((daily_pct_spent(25.0, Some(10.0)) - 15.0).abs() < 1e-9);
    }

    #[test]
    fn daily_pct_spent_clamps_negative_after_reset() {
        // Mid-day reset: current dropped below the morning baseline → 0, not negative.
        assert_eq!(daily_pct_spent(5.0, Some(40.0)), 0.0);
    }

    // --- today_spent_for ----------------------------------------------------

    fn budget_usage(seven_day_pct: f64) -> UsageData {
        UsageData {
            five_hour: tier(0.0),
            seven_day: tier(seven_day_pct),
            seven_day_opus: None,
            seven_day_sonnet: None,
            extra_usage: None,
            prepaid_balance: None,
            prepaid_currency: None,
        }
    }

    #[test]
    fn today_spent_none_when_budget_disabled() {
        let db = StatsDb::open(std::path::Path::new(":memory:")).unwrap();
        let cfg = AppConfig {
            daily_budget_enabled: false,
            ..AppConfig::default()
        };
        let now = Utc::now().to_rfc3339();
        assert_eq!(today_spent_for(&db, &cfg, &budget_usage(40.0), &now), None);
    }

    #[test]
    fn today_spent_cc_branch_sums_cost_since_midnight() {
        let db = StatsDb::open(std::path::Path::new(":memory:")).unwrap();
        let cfg = AppConfig {
            daily_budget_enabled: true,
            cc_analytics_enabled: true,
            ..AppConfig::default()
        };
        // A CC row stamped exactly at local midnight is inside [midnight, now).
        let midnight = local_midnight_rfc3339();
        db.cc_upsert(&[CcUsageRow {
            message_id: "m1".into(),
            ts: midnight,
            model: "claude-opus-4-7".into(),
            input: 0,
            output: 0,
            cache_create: 0,
            cache_read: 0,
            cost: 0.5,
            session_id: Some("s1".into()),
            project: None,
        }])
        .unwrap();
        let now = Utc::now().to_rfc3339();
        let spent = today_spent_for(&db, &cfg, &budget_usage(0.0), &now).unwrap();
        assert!((spent - 0.5).abs() < 1e-9, "spent = {spent}");
    }

    #[test]
    fn today_spent_pct_branch_no_baseline_is_zero() {
        // CC analytics off, empty DB: baseline falls back to current → delta 0.
        let db = StatsDb::open(std::path::Path::new(":memory:")).unwrap();
        let cfg = AppConfig {
            daily_budget_enabled: true,
            cc_analytics_enabled: false,
            ..AppConfig::default()
        };
        let now = Utc::now().to_rfc3339();
        let spent = today_spent_for(&db, &cfg, &budget_usage(42.0), &now).unwrap();
        assert_eq!(spent, 0.0);
    }

    // --- local_midnight_rfc3339 --------------------------------------------

    #[test]
    fn local_midnight_round_trips_to_local_zero_oclock() {
        let s = local_midnight_rfc3339();
        let parsed = DateTime::parse_from_rfc3339(&s).unwrap();
        let local = parsed.with_timezone(&chrono::Local);
        assert_eq!(local.hour(), 0);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.second(), 0);
    }
}
