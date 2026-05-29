//! Exhaustion forecast (issue #7): per-tier burn-rate, ETA to 100% and the
//! recommended pace to last until reset, derived from the recent snapshots.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::StatsDb;

// Mirror of the burn-rate guards in `alerts.rs`. Duplicated on purpose: `stats`
// is the lower layer and must not depend on `alerts` (which already depends on
// `stats`). Keep the two in sync.
const MIN_SPAN_MIN: f64 = 10.0; // need at least this much history to estimate a rate
const MIN_RATE: f64 = 0.05; // %/min — below this is noise/flat, no ETA

#[derive(Debug, Serialize, PartialEq)]
pub struct TierForecast {
    pub rate_per_hour: f64,            // measured burn, %/h (clamped ≥ 0)
    pub eta_minutes: Option<f64>,      // minutes to 100% at the measured rate
    pub allowed_per_hour: Option<f64>, // %/h you may still spend to last until reset
    pub pace: String,                  // "idle" | "ok" | "warn"
}

impl TierForecast {
    /// No snapshot / not enough history to estimate anything yet.
    pub(crate) fn unknown() -> Self {
        Self {
            rate_per_hour: 0.0,
            eta_minutes: None,
            allowed_per_hour: None,
            pace: "unknown".to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ForecastData {
    pub five_hour: TierForecast,
    pub seven_day: TierForecast,
    pub extra_usage: Option<TierForecast>,
}

/// Pure forecast math for one tier. `span_min` is the history span backing the
/// rate (None when there's too little to measure). `reset_at` drives the
/// *allowed* pace (independent of history); the measured rate drives the ETA.
fn tier_forecast(
    current: f64,
    reset_at: Option<&str>,
    earliest: Option<f64>,
    span_min: Option<f64>,
    now: DateTime<Utc>,
) -> TierForecast {
    // Minutes until reset (positive only). Drives allowed pace + ahead/behind.
    let time_to_reset_min = reset_at
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|r| (r.with_timezone(&Utc) - now).num_milliseconds() as f64 / 60000.0)
        .filter(|&m| m > 0.0);

    // Recommended pace to land exactly at 100% on reset — needs no history.
    let allowed_per_hour = match time_to_reset_min {
        Some(ttr) if current < 100.0 => Some((100.0 - current) / ttr * 60.0),
        _ => None,
    };

    // Measured burn → ETA. Requires enough history and a non-trivial rate.
    let rate_per_min = match (earliest, span_min) {
        (Some(e), Some(s)) if s >= MIN_SPAN_MIN => Some((current - e) / s),
        _ => None,
    };
    let rate_per_hour = rate_per_min.map(|r| r.max(0.0) * 60.0).unwrap_or(0.0);
    let eta_minutes = match rate_per_min {
        Some(r) if r >= MIN_RATE && current < 100.0 => Some((100.0 - current) / r),
        _ => None,
    };

    let pace = if rate_per_min.is_none() {
        // Too little history to measure a burn rate — say so, don't claim safety.
        "unknown"
    } else if let (Some(eta), Some(ttr)) = (eta_minutes, time_to_reset_min) {
        // Measured rate gives an ETA: warn only if it lands before the reset.
        if eta < ttr {
            "warn"
        } else {
            "ok"
        }
    } else {
        // Measured but flat (rate below noise), or no reset to race → will last.
        "ok"
    };

    TierForecast {
        rate_per_hour,
        eta_minutes,
        allowed_per_hour,
        pace: pace.to_string(),
    }
}

impl StatsDb {
    /// Exhaustion forecast per tier, derived from the latest snapshot's current
    /// values plus the burn rate over `[now − window_min, now]`. `now` is injected
    /// so the math (window bound + time-to-reset) is deterministic under test.
    pub fn forecast(
        &self,
        window_min: i64,
        now: DateTime<Utc>,
    ) -> Result<ForecastData, rusqlite::Error> {
        // Current state = the most recent snapshot (recorded just before the
        // usage-updated that triggers this call, so it matches the live cards).
        let latest = match self.latest(1)?.into_iter().next() {
            Some(s) => s,
            None => {
                return Ok(ForecastData {
                    five_hour: TierForecast::unknown(),
                    seven_day: TierForecast::unknown(),
                    extra_usage: None,
                })
            }
        };

        // Earliest snapshot inside the averaging window, for the rate baseline.
        let from = (now - Duration::minutes(window_min)).to_rfc3339();
        let earliest: Option<(String, f64, f64, Option<f64>)> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT timestamp, five_hour_pct, seven_day_pct, extra_pct
                 FROM usage_snapshots WHERE timestamp >= ?1
                 ORDER BY timestamp ASC LIMIT 1",
                params![from],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?
        };

        // Span of measured history (None when the earliest == latest row).
        let span_min = earliest.as_ref().and_then(|e| {
            let a = DateTime::parse_from_rfc3339(&e.0).ok()?;
            let b = DateTime::parse_from_rfc3339(&latest.timestamp).ok()?;
            let s = (b - a).num_milliseconds() as f64 / 60000.0;
            (s > 0.0).then_some(s)
        });

        Ok(ForecastData {
            five_hour: tier_forecast(
                latest.five_hour_pct,
                latest.five_hour_reset.as_deref(),
                earliest.as_ref().map(|e| e.1),
                span_min,
                now,
            ),
            seven_day: tier_forecast(
                latest.seven_day_pct,
                latest.seven_day_reset.as_deref(),
                earliest.as_ref().map(|e| e.2),
                span_min,
                now,
            ),
            // Extra usage has no reset_at in snapshots → no allowed pace, ETA only.
            extra_usage: latest.extra_pct.map(|cur| {
                tier_forecast(cur, None, earliest.as_ref().and_then(|e| e.3), span_min, now)
            }),
        })
    }
}
