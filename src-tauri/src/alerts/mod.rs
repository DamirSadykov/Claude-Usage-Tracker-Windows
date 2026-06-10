//! Alert engine + threshold bucketing — the business logic that used to live in
//! the frontend (`src/alerts.ts` + `src/thresholds.ts`). Split by concern:
//!   - `config` — `AppConfig` + alert tier/type toggles (deserialized from the store)
//!   - `util`   — threshold bucketing + quiet-hours math (the colour levels)
//!   - `engine` — the stateful `AlertEngine` that decides what to notify
//!
//! Kept pure: `evaluate` takes the current local minute-of-day and an optional
//! usage delta injected by the caller, so it is fully deterministic under
//! `cargo test`. The engine only decides *what* to notify; localization and the
//! actual OS toast stay in the UI.

mod config;
mod engine;
mod util;

pub use config::{AlertTiers, AlertTypes, AppConfig};
pub use engine::{ActiveSession, AlertEngine, AlertEvent};
pub use util::{in_quiet_hours, normalize, tier_level};

/// Default colour-bucket thresholds (%), shared by the config defaults and the
/// `normalize` fallback. Kept here so both submodules can reach it.
pub(crate) const DEFAULT_THRESHOLDS: [f64; 3] = [25.0, 50.0, 75.0];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::UsageDelta;
    use crate::usage::{ExtraUsage, UsageData, UsageTier};

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

    // --- runtime insights (issue #46) ---

    // A warm turn baseline (big read, no create); cold-rewrite tests flip the
    // read/create/gap fields on a clone.
    fn warm(id: &str, ts: &str, messages: i64) -> crate::alerts::ActiveSession {
        crate::alerts::ActiveSession {
            session_id: id.into(),
            project: Some("proj".into()),
            messages,
            last_ts: ts.into(),
            has_prev: true,
            gap_minutes: 1.0,
            last_cache_read: 200_000,
            last_cache_create: 0,
            rewrite_cost_usd: 0.0,
        }
    }

    fn runtime_cfg() -> AppConfig {
        let mut c = cfg();
        c.runtime_insights_enabled = true;
        c
    }

    fn flat() -> UsageData {
        usage(tier(0.0, None, false), tier(0.0, None, false))
    }

    fn is_insight(out: &[AlertEvent], kind: &str) -> bool {
        matches!(out, [AlertEvent::Insight { name, .. }] if name == kind)
    }

    // Turn `warm` into a cold prefix rewrite with the given gap (cause driver).
    fn cold(mut s: crate::alerts::ActiveSession, gap: f64) -> crate::alerts::ActiveSession {
        s.last_cache_read = 0;
        s.last_cache_create = 300_000;
        s.gap_minutes = gap;
        s.rewrite_cost_usd = 1.7;
        s
    }

    fn insight_cause(out: &[AlertEvent]) -> Option<String> {
        match out {
            [AlertEvent::Insight { params, .. }] => {
                params.get("cause").and_then(|v| v.as_str()).map(String::from)
            }
            _ => None,
        }
    }

    #[test]
    fn long_session_fires_once_and_rearms_on_new_session() {
        let mut eng = AlertEngine::new();
        let mut c = runtime_cfg();
        c.runtime_insight_kinds = vec!["long_session".into()];
        let u = flat();
        prime(&mut eng, &u, &c);

        eng.set_active_session(Some(warm("s1", "t1", 200)));
        assert!(is_insight(&eng.evaluate(&u, &c, 0, None, None, false), "long_session"));

        // same session, more messages → no repeat
        eng.set_active_session(Some(warm("s1", "t2", 250)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());

        // new session crossing the threshold → fires again
        eng.set_active_session(Some(warm("s2", "t3", 300)));
        assert!(is_insight(&eng.evaluate(&u, &c, 0, None, None, false), "long_session"));
    }

    #[test]
    fn long_session_silent_below_threshold() {
        let mut eng = AlertEngine::new();
        let mut c = runtime_cfg();
        c.runtime_insight_kinds = vec!["long_session".into()];
        let u = flat();
        prime(&mut eng, &u, &c);
        eng.set_active_session(Some(warm("s1", "t1", 199)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());
    }

    #[test]
    fn cold_rewrite_primes_then_fires_once_with_cause() {
        let mut eng = AlertEngine::new();
        let mut c = runtime_cfg();
        c.runtime_insight_kinds = vec!["idle_cache_gap".into()];
        let u = flat();
        prime(&mut eng, &u, &c);

        // first sighting primes the tracker (no fire on a pre-existing turn)
        eng.set_active_session(Some(warm("s1", "t1", 10)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());

        // new cold-rewrite turn after a long gap → fires, labelled idle
        eng.set_active_session(Some(cold(warm("s1", "t2", 11), 40.0)));
        let out = eng.evaluate(&u, &c, 0, None, None, false);
        assert!(is_insight(&out, "idle_cache_gap"));
        assert_eq!(insight_cause(&out).as_deref(), Some("idle"));

        // same turn again → no repeat
        eng.set_active_session(Some(cold(warm("s1", "t2", 11), 40.0)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());

        // a near-zero-gap rewrite is labelled compaction
        eng.set_active_session(Some(cold(warm("s1", "t3", 12), 0.2)));
        let out2 = eng.evaluate(&u, &c, 0, None, None, false);
        assert_eq!(insight_cause(&out2).as_deref(), Some("compact"));
    }

    #[test]
    fn cold_rewrite_guards_warm_small_and_first_turn() {
        let mut eng = AlertEngine::new();
        let mut c = runtime_cfg();
        c.runtime_insight_kinds = vec!["idle_cache_gap".into()];
        let u = flat();
        prime(&mut eng, &u, &c);
        eng.set_active_session(Some(warm("s1", "t0", 5)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty()); // prime

        // warm turn (big read, no create) → silent
        eng.set_active_session(Some(warm("s1", "t1", 6)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());

        // create below the gate → silent
        let mut tiny = warm("s1", "t2", 7);
        tiny.last_cache_read = 0;
        tiny.last_cache_create = 10_000;
        tiny.gap_minutes = 40.0;
        eng.set_active_session(Some(tiny));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());

        // session's first turn writes the cache (no predecessor) → not a rewrite
        let mut first_turn = cold(warm("s1", "t3", 8), 40.0);
        first_turn.has_prev = false;
        eng.set_active_session(Some(first_turn));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());
    }

    #[test]
    fn runtime_master_toggle_and_per_kind_gate() {
        let u = flat();

        // master off → silent even with a qualifying session
        let mut eng = AlertEngine::new();
        let mut c = cfg();
        prime(&mut eng, &u, &c);
        eng.set_active_session(Some(warm("s1", "t1", 500)));
        assert!(eng.evaluate(&u, &c, 0, None, None, false).is_empty());

        // master on but only idle_cache_gap in the kind set → long_session gated out
        c.runtime_insights_enabled = true;
        c.runtime_insight_kinds = vec!["idle_cache_gap".into()];
        let mut eng2 = AlertEngine::new();
        prime(&mut eng2, &u, &c);
        eng2.set_active_session(Some(warm("s1", "t1", 500))); // prime cold tracker
        let _ = eng2.evaluate(&u, &c, 0, None, None, false);
        eng2.set_active_session(Some(cold(warm("s1", "t2", 500), 40.0)));
        assert!(is_insight(&eng2.evaluate(&u, &c, 0, None, None, false), "idle_cache_gap"));
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
