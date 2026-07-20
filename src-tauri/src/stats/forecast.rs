//! Exhaustion forecast (issue #7): per-tier burn-rate, ETA to 100% and the
//! recommended pace to last until reset.
//!
//! The displayed ETA is driven by a **moving average of hourly burn** over
//! the past `LOOKBACK_HOURS` (7 days), per the issue #7 spec ("скользящее
//! среднее с настраиваемым окном"). A median was tried first — it gave the
//! sensible "1 hot hour doesn't dominate" property — but for typical users
//! more than half of the 168 weekly hours are idle, so the median sits at 0
//! and ETA is permanently absent ("хватит до сброса" forever). The mean
//! correctly amortises real total burn across the whole window: a single
//! 20%/h spike in a week of zeros becomes 20/168 ≈ 0.12%/h going forward,
//! which is the honest forward-projection.
//!
//! Coverage is widened with `cc_usage` activity: an hour bucket that has no
//! snapshot coverage (app was off, gap > 3h) but also no Claude Code event
//! is a verified idle zero, not missing data. This stops the mean from being
//! biased toward "average burn during active hours" for users who only run
//! the tracker while coding. See `mean_hourly_rate` for the gory details and
//! the web/API caveat.
//!
//! The short-window rate ALSO drives the 5h card: its displayed rate is
//! `max(weekly mean, recent short-window burn)`, so a live spike is reflected
//! immediately and then decays back to the weekly mean once activity stops
//! (see `recent_hourly_rate`). The same short-window burn is what
//! `alerts::engine` uses for "your 5h session is about to end" — computed there
//! directly from `compute_delta`, over the same `forecast_window_min`. Only the
//! 5h tier blends it in; the 7-day tiers stay on the pure weekly mean.

use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde::Serialize;

use super::StatsDb;

// `alerts::engine` keeps its own MIN_RATE (0.05 %/min ≈ 3 %/h) — appropriate
// for a short-window burn that's about to exhaust the 5h session. For the
// display forecast we average over a week, so typical burn lands at well under
// 1 %/h; gating on 3 %/h would suppress every ETA. We let the pace check
// (eta < ttr) do the "is this worth warning about" filtering instead, and
// only treat rate=0 as "no ETA".

/// Lookback for the moving-average rate. A full week covers the slowest
/// reset tier and smooths diurnal/weekly idle patterns into the denominator.
const LOOKBACK_HOURS: i64 = 7 * 24;

/// An hour bucket counts only if its two endpoints can be sampled from
/// snapshots no more than this far apart. 3h covers normal usage gaps (a
/// lunch break, a meeting) without inventing data for genuine off-periods.
const MAX_INTERP_GAP_MIN: i64 = 180;

/// A recent-burn window shorter than this (in minutes) is too noisy to trust
/// as the 5h card's spike signal — mirrors `alerts::engine::MIN_SPAN_MIN`,
/// which gates the same short-window delta for the exhaustion alert.
const RECENT_MIN_SPAN_MIN: f64 = 10.0;

/// Forward-fill window for the "right edge of the most recent bucket". The
/// loop's h=1 bucket ends at `now`, but the latest snapshot is always tens of
/// seconds older (poll interval ≥ 10s, forecast is called right after the
/// usage-updated emit). Without this we'd permanently drop the most recent
/// hour and never reach coverage > 0 for users with little history.
const FORWARD_FILL_GAP_MIN: i64 = 10;

#[derive(Debug, Serialize, PartialEq)]
pub struct TierForecast {
    pub rate_per_hour: f64,            // moving-average burn, %/h (clamped ≥ 0)
    pub eta_minutes: Option<f64>,      // minutes to 100% at the moving-average rate
    pub allowed_per_hour: Option<f64>, // %/h you may still spend to last until reset
    pub pace: String,                  // "unknown" | "ok" | "warn"
    pub coverage_hours: u32,           // # hour buckets backing the average
}

impl TierForecast {
    /// No snapshot / not enough history to estimate anything yet.
    pub(crate) fn unknown() -> Self {
        Self {
            rate_per_hour: 0.0,
            eta_minutes: None,
            allowed_per_hour: None,
            pace: "unknown".to_string(),
            coverage_hours: 0,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ForecastData {
    pub five_hour: TierForecast,
    pub seven_day: TierForecast,
    pub extra_usage: Option<TierForecast>,
}

/// One sample of a tier's percent at a given moment, plus the `reset_at` it was
/// reported with. `reset_at` is carried so we can tell that consecutive
/// snapshots straddle a reset boundary (drop the pair — it isn't burn).
type Series = Vec<(DateTime<Utc>, f64, Option<String>)>;

/// Linearly interpolate `pct` at moment `t` between the snapshot pair that
/// brackets it. Returns `None` when the bracket either has too large a gap
/// (likely the app was off — interpolating fabricates burn) or straddles a
/// reset. Reset detection uses `hi.pct < lo.pct` rather than `reset_at`
/// equality: the API returns `resets_at` with microsecond precision that can
/// drift between responses, and string-equal comparison was dropping almost
/// every pair in production even when no reset had happened.
fn pct_at(series: &Series, t: DateTime<Utc>) -> Option<(f64, Option<String>)> {
    if series.is_empty() {
        return None;
    }
    let idx_hi = series.partition_point(|s| s.0 <= t);
    if idx_hi == 0 {
        return None; // no snapshot at-or-before t
    }
    let lo = &series[idx_hi - 1];
    if lo.0 == t {
        return Some((lo.1, lo.2.clone()));
    }
    if idx_hi == series.len() {
        // No snapshot after t. Forward-fill from the most recent one only if
        // it's still fresh — otherwise we'd extend stale state forever.
        let age_min = (t - lo.0).num_minutes();
        if age_min <= FORWARD_FILL_GAP_MIN {
            return Some((lo.1, lo.2.clone()));
        }
        return None;
    }
    let hi = &series[idx_hi];
    let gap_min = (hi.0 - lo.0).num_minutes();
    if gap_min > MAX_INTERP_GAP_MIN {
        return None;
    }
    // Pct decreased between brackets → a reset (or limit-clear) happened
    // somewhere inside, can't linearly interpolate across it.
    if hi.1 < lo.1 {
        return None;
    }
    let span_ms = (hi.0 - lo.0).num_milliseconds() as f64;
    if span_ms <= 0.0 {
        return Some((lo.1, lo.2.clone()));
    }
    let frac = (t - lo.0).num_milliseconds() as f64 / span_ms;
    Some((lo.1 + (hi.1 - lo.1) * frac, lo.2.clone()))
}

/// Arithmetic mean of hourly `%/hour` burn over the past `lookback_hours`,
/// plus the count of hour buckets that contributed.
///
/// A bucket contributes in one of two ways:
/// 1. Snapshot-sampled: both endpoints come from `pct_at`, and the end pct
///    didn't drop below the start (resets are caught here or inside `pct_at`).
/// 2. **CC-confirmed idle**: snapshots can't sample the bucket (app was off,
///    too large a gap, etc.), BUT `cc_activity` has no row in [start, end].
///    Since Claude Code activity is the only way `pct` can grow for this
///    user, an hour with zero CC events is a verified zero — we add it as
///    0 burn instead of dropping it. This grows the denominator for users
///    who keep the app off when not coding, pulling the projection toward
///    the typical-week truth and away from "average of active hours".
///
/// The CC signal misses pure web/API usage; for users who routinely burn
/// limits through the web UI without recording to ~/.claude, the projection
/// will under-count. That's acceptable: the active-only branch was already
/// over-counting in the other direction, and most users of this app are
/// CC-primary by self-selection.
fn mean_hourly_rate(
    series: &Series,
    cc_activity: &[DateTime<Utc>],
    now: DateTime<Utc>,
    lookback_hours: i64,
) -> (Option<f64>, u32) {
    // Only use CC as an idle witness when there's *some* CC activity in the
    // lookback. An empty cc_activity could mean either "user doesn't use CC"
    // or "ingest is broken" — either way the absence isn't evidence of idle.
    let cc_witness_available = !cc_activity.is_empty();

    let mut total: f64 = 0.0;
    let mut count: u32 = 0;
    for h in 1..=lookback_hours {
        let end = now - Duration::hours(h - 1);
        let start = end - Duration::hours(1);
        match (pct_at(series, start), pct_at(series, end)) {
            (Some((sp, _)), Some((ep, _))) if ep >= sp => {
                total += ep - sp;
                count += 1;
            }
            _ => {
                if cc_witness_available
                    && !has_activity_in_range(cc_activity, start, end)
                {
                    count += 1; // confirmed idle hour, contributes 0
                }
            }
        }
    }
    if count == 0 {
        return (None, 0);
    }
    (Some(total / count as f64), count)
}

/// True iff `activity` (sorted ascending) has any timestamp in the half-open
/// interval `[start, end)`. Binary-searches both edges — O(log n) per bucket.
fn has_activity_in_range(
    activity: &[DateTime<Utc>],
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> bool {
    let lo = activity.partition_point(|t| *t < start);
    let hi = activity.partition_point(|t| *t < end);
    hi > lo
}

/// Recent burn as %/h over the last `window_min` of snapshots — the same
/// short-window question `alerts::engine::eval_forecast` asks (first→last delta
/// across the window). Blended into the 5h card's rate so the card reacts to a
/// live spike instead of amortising it across the week. Returns `None` when the
/// window holds less than `RECENT_MIN_SPAN_MIN` of history (too little to
/// trust) or the endpoints straddle a reset (`delta < 0` — not real burn); the
/// caller then falls back to the weekly mean.
fn recent_hourly_rate(
    series: &Series,
    now: DateTime<Utc>,
    window_min: i64,
) -> Option<f64> {
    if window_min <= 0 {
        return None;
    }
    let window_start = now - Duration::minutes(window_min);
    let idx = series.partition_point(|s| s.0 < window_start);
    let recent = series.get(idx..)?;
    let first = recent.first()?;
    let last = recent.last()?;
    let span_min = (last.0 - first.0).num_milliseconds() as f64 / 60000.0;
    if span_min < RECENT_MIN_SPAN_MIN {
        return None;
    }
    let delta = last.1 - first.1;
    if delta < 0.0 {
        return None; // endpoints straddle a reset — not real burn
    }
    Some(delta / span_min * 60.0)
}

/// Build the per-tier forecast from the latest snapshot + the precomputed
/// mean rate. `reset_at` drives the allowed pace (independent of history). The
/// ETA is driven by `max(mean, recent)`: `recent_rate_per_hour` is `Some` only
/// for the 5h tier (its spike-reactive short-window burn) and `None` for the
/// 7-day tiers, which stay on the pure weekly mean.
fn tier_forecast(
    current: f64,
    reset_at: Option<&str>,
    mean_rate_per_hour: Option<f64>,
    recent_rate_per_hour: Option<f64>,
    coverage_hours: u32,
    now: DateTime<Utc>,
) -> TierForecast {
    let time_to_reset_min = reset_at
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|r| (r.with_timezone(&Utc) - now).num_milliseconds() as f64 / 60000.0)
        .filter(|&m| m > 0.0);

    let allowed_per_hour = match time_to_reset_min {
        Some(ttr) if current < 100.0 => Some((100.0 - current) / ttr * 60.0),
        _ => None,
    };

    // Worst (fastest) of the weekly mean and the recent short-window burn. A
    // spike lifts the ETA immediately; once it passes, `recent` decays toward 0
    // and the mean — never below the honest weekly projection — takes over.
    let mean = mean_rate_per_hour.unwrap_or(0.0).max(0.0);
    let recent = recent_rate_per_hour.unwrap_or(0.0).max(0.0);
    let rate_per_hour = mean.max(recent);
    let rate_known = mean_rate_per_hour.is_some() || recent_rate_per_hour.is_some();

    let eta_minutes = if rate_per_hour > 0.0 && current < 100.0 {
        Some((100.0 - current) / (rate_per_hour / 60.0))
    } else {
        None
    };

    let pace = if !rate_known {
        "unknown"
    } else if let (Some(eta), Some(ttr)) = (eta_minutes, time_to_reset_min) {
        if eta < ttr {
            "warn"
        } else {
            "ok"
        }
    } else {
        "ok"
    };

    TierForecast {
        rate_per_hour,
        eta_minutes,
        allowed_per_hour,
        pace: pace.to_string(),
        coverage_hours,
    }
}

impl StatsDb {
    /// Exhaustion forecast per tier. `window_min` bounds the *recent* burn
    /// sample that makes the 5h tier's rate spike-reactive (see
    /// `recent_hourly_rate`); the 7-day tiers ignore it and use the weekly
    /// mean. `now` is injected so the math (lookback bound + time-to-reset) is
    /// deterministic under test.
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

        // Single batched read of the 7-day window for all three tiers.
        let lookback_from = (now - Duration::hours(LOOKBACK_HOURS)).to_rfc3339();
        let rows: Vec<(String, f64, Option<String>, f64, Option<String>, Option<f64>)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT timestamp, five_hour_pct, five_hour_reset,
                        seven_day_pct, seven_day_reset, extra_pct
                 FROM usage_snapshots
                 WHERE timestamp >= ?1
                 ORDER BY timestamp ASC",
            )?;
            let mapped = stmt.query_map(params![lookback_from], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<f64>>(5)?,
                ))
            })?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };

        let mut five_series: Series = Vec::with_capacity(rows.len());
        let mut seven_series: Series = Vec::with_capacity(rows.len());
        let mut extra_series: Series = Vec::with_capacity(rows.len());
        for (ts, fhp, fhr, sdp, sdr, ex) in &rows {
            let t = match DateTime::parse_from_rfc3339(ts) {
                Ok(d) => d.with_timezone(&Utc),
                Err(_) => continue,
            };
            five_series.push((t, *fhp, fhr.clone()));
            seven_series.push((t, *sdp, sdr.clone()));
            // Extra has no per-row reset_at in snapshots → drop the column to
            // avoid spurious "reset boundary" splits.
            if let Some(p) = ex {
                extra_series.push((t, *p, None));
            }
        }

        // Claude Code activity in the same lookback. Used as an "idle witness":
        // an hour bucket with no snapshot coverage but also no CC event is a
        // verified zero, not a missing measurement.
        let cc_activity: Vec<DateTime<Utc>> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT ts FROM cc_usage WHERE ts >= ?1 ORDER BY ts ASC",
            )?;
            let mapped = stmt.query_map(params![lookback_from], |r| r.get::<_, String>(0))?;
            mapped
                .filter_map(|r| r.ok())
                .filter_map(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|d| d.with_timezone(&Utc))
                })
                .collect()
        };

        let (fh_med, fh_cov) =
            mean_hourly_rate(&five_series, &cc_activity, now, LOOKBACK_HOURS);
        let (sd_med, sd_cov) =
            mean_hourly_rate(&seven_series, &cc_activity, now, LOOKBACK_HOURS);
        let (ex_med, ex_cov) =
            mean_hourly_rate(&extra_series, &cc_activity, now, LOOKBACK_HOURS);

        // 5h-only: the recent short-window burn that makes the card react to a
        // live spike. Blended as `max(mean, recent)` inside `tier_forecast`.
        let fh_recent = recent_hourly_rate(&five_series, now, window_min);

        // Allowed-pace pre-touches `latest` which is also needed below; avoid
        // re-querying by reusing it.
        let latest_ref = &latest;

        Ok(ForecastData {
            five_hour: tier_forecast(
                latest_ref.five_hour_pct,
                latest_ref.five_hour_reset.as_deref(),
                fh_med,
                fh_recent,
                fh_cov,
                now,
            ),
            seven_day: tier_forecast(
                latest_ref.seven_day_pct,
                latest_ref.seven_day_reset.as_deref(),
                sd_med,
                None,
                sd_cov,
                now,
            ),
            extra_usage: latest_ref
                .extra_pct
                .map(|cur| tier_forecast(cur, None, ex_med, None, ex_cov, now)),
        })
    }
}

