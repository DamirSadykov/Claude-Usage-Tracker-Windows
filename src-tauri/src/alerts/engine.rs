//! The alert engine: decides *what* to notify (threshold crossings, limits,
//! resets, exhaustion forecast, daily budget), with priming, per-bucket
//! deduplication and quiet-hours/snooze queueing. Pure: `evaluate` takes the
//! current local minute-of-day and an injected usage delta, so it is fully
//! deterministic under test. Localization + the OS toast stay in the UI.

use std::collections::HashMap;

use serde::Serialize;

use super::config::AppConfig;
use super::util::{in_quiet_hours, normalize, thresholds_for_tier, tier_level};
use crate::stats::UsageDelta;
use crate::usage::{UsageData, UsageTier};

// --- Tuning constants (mirror the former alerts.ts) ---
const MIN_SPAN_MIN: f64 = 10.0; // need at least this much history to forecast
const MIN_RATE: f64 = 0.05; // %/min — below this is noise/flat
const MAX_PENDING: usize = 10;
const RESET_EPSILON: f64 = 1.0; // percent_used <= this counts as "reset"

// --- Runtime-insight tuning (issue #46) ---
// long_session: number of assistant turns in the active session before we nudge
// "this is getting long, consider splitting". Time/cost are intentionally not
// used in v1.
const LONG_SESSION_MESSAGES: i64 = 200;
// cold-rewrite detection (the runtime side of `cold_rewrites`). Empirically the
// prompt cache survives well past the 5-min default TTL, so we don't predict from
// idle time — we detect the *actual* rewrite on the latest turn: tiny read +
// a large create means the whole prefix was rebuilt at 1.25× pricing.
const COLD_READ_MAX: i64 = 5_000;
const COLD_CREATE_GATE: i64 = 50_000;
// Cause split: a real idle/TTL expiry only ever appears after a long pause
// (scanning local transcripts: nothing between ~5 and ~19 min, then idle rewrites
// from there up). A near-zero gap means the prefix was invalidated in-flow — a
// compaction or history/model change, not an idle gap.
const COLD_IDLE_GAP_MIN: f64 = 15.0;

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
    /// A runtime optimization tip about the active Claude Code session. `name` is
    /// the insight kind (`long_session` / `cold_rewrites`); `params` carries the
    /// localization placeholders. The inner field is `name`, not `kind`, to avoid
    /// colliding with the serde tag.
    Insight {
        name: String,
        params: serde_json::Value,
    },
}

/// A snapshot of the currently-active Claude Code session, computed by the caller
/// (newest-mtime transcript) and injected before `evaluate`. The engine reads it
/// to decide runtime tips; it never reads transcript content — only these
/// aggregate metrics. `idle_minutes` and `rewrite_waste_usd` are derived caller
/// side (the engine is time- and pricing-agnostic).
#[derive(Clone, Debug)]
pub struct ActiveSession {
    pub session_id: String,
    /// Working-directory basename (the project label shown in the toast).
    pub project: Option<String>,
    /// Assistant turns in this session so far.
    pub messages: i64,
    /// Timestamp of the latest assistant turn — the de-dup key for cold rewrites.
    pub last_ts: String,
    /// False when the latest turn is the session's first (initial cache write, not
    /// a *re*write — must not fire a cold-rewrite tip).
    pub has_prev: bool,
    /// Minutes between the latest turn and its predecessor (the pause that
    /// preceded a rewrite — large = idle/TTL, near-zero = compaction).
    pub gap_minutes: f64,
    /// The latest turn's cache read / create token counts.
    pub last_cache_read: i64,
    pub last_cache_create: i64,
    /// Actual USD the latest turn spent rebuilding the prefix (create × 1.25).
    pub rewrite_cost_usd: f64,
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
    // --- runtime-insight state ---
    /// Transient input: the active session for the current `evaluate` cycle.
    active_session: Option<ActiveSession>,
    /// session_id we already fired `long_session` for (once per session).
    long_session_fired_for: Option<String>,
    /// The latest turn timestamp we've already evaluated for a cold rewrite —
    /// fires at most once per turn, and primes (no fire) on the first sighting.
    cold_last_ts: Option<String>,
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
        self.active_session = None;
        self.long_session_fired_for = None;
        self.cold_last_ts = None;
    }

    /// Inject the active-session snapshot consumed by the next `evaluate`. The
    /// caller sets this each poll (None when runtime insights are off or no
    /// session is active). Kept separate from `evaluate`'s args so the existing
    /// usage-alert tests stay unchanged — they leave it None and emit no tips.
    pub fn set_active_session(&mut self, session: Option<ActiveSession>) {
        self.active_session = session;
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

        self.eval_insights(cfg, suppressed, &mut out);

        out
    }

    /// Runtime optimization tips about the active session. Gated by the master
    /// opt-in and the per-kind enable set; each rule has its own de-dup so a tip
    /// fires once per session / idle episode, not every poll.
    fn eval_insights(&mut self, cfg: &AppConfig, suppressed: bool, out: &mut Vec<AlertEvent>) {
        if !cfg.runtime_insights_enabled {
            return;
        }
        let session = match self.active_session.clone() {
            Some(s) => s,
            None => return,
        };
        let enabled = |kind: &str| cfg.runtime_insight_kinds.iter().any(|k| k == kind);

        if enabled("long_session") {
            self.eval_long_session(&session, suppressed, out);
        }
        if enabled("cold_rewrites") {
            self.eval_cold_rewrite(&session, suppressed, out);
        }
    }

    /// Fires once per session_id once it crosses the message threshold.
    fn eval_long_session(
        &mut self,
        s: &ActiveSession,
        suppressed: bool,
        out: &mut Vec<AlertEvent>,
    ) {
        if s.messages < LONG_SESSION_MESSAGES {
            return;
        }
        if self.long_session_fired_for.as_deref() == Some(s.session_id.as_str()) {
            return;
        }
        self.long_session_fired_for = Some(s.session_id.clone());
        self.dispatch(
            AlertEvent::Insight {
                name: "long_session".into(),
                params: serde_json::json!({
                    "project": s.project,
                    "messages": s.messages,
                }),
            },
            suppressed,
            out,
        );
    }

    /// Detects an *actual* cold prefix rewrite on the latest turn (tiny read +
    /// large create) and toasts it once, labelling the cause by the preceding
    /// gap (long pause → idle/TTL; near-zero → compaction/history change). Primes
    /// on first sighting so a rewrite that predates app start doesn't fire.
    fn eval_cold_rewrite(&mut self, s: &ActiveSession, suppressed: bool, out: &mut Vec<AlertEvent>) {
        let first = self.cold_last_ts.is_none();
        let seen = self.cold_last_ts.as_deref() == Some(s.last_ts.as_str());
        self.cold_last_ts = Some(s.last_ts.clone());
        if first || seen {
            return;
        }
        // The session's first turn writes the cache (read 0, create large) but is
        // not a *re*write — needs a predecessor turn.
        if !s.has_prev {
            return;
        }
        let cold = s.last_cache_read < COLD_READ_MAX && s.last_cache_create >= COLD_CREATE_GATE;
        if !cold {
            return;
        }
        let cause = if s.gap_minutes > COLD_IDLE_GAP_MIN {
            "idle"
        } else {
            "compact"
        };
        self.dispatch(
            AlertEvent::Insight {
                name: "cold_rewrites".into(),
                params: serde_json::json!({
                    "project": s.project,
                    "cause": cause,
                    "cost_usd": s.rewrite_cost_usd,
                    "tokens": s.last_cache_create,
                    "gap_minutes": s.gap_minutes.round(),
                }),
            },
            suppressed,
            out,
        );
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
