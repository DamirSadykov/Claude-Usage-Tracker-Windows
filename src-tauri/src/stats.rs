use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

use crate::usage::UsageData;

/// Ordered schema migrations. Each entry advances the DB by one version
/// (tracked via `PRAGMA user_version`). On startup, every migration with an
/// index >= the current version is applied, then user_version is bumped.
///
/// RULES for future changes:
///   - NEVER edit or reorder an existing migration — it has already run on
///     users' machines. Append a new one instead.
///   - New columns must be additive: `ALTER TABLE usage_snapshots ADD COLUMN ...`
///     (SQLite added columns are NULL/default for existing rows — no data loss).
const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    "CREATE TABLE IF NOT EXISTS usage_snapshots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       TEXT NOT NULL,
        five_hour_pct   REAL NOT NULL,
        five_hour_reset TEXT,
        seven_day_pct   REAL NOT NULL,
        seven_day_reset TEXT,
        opus_pct        REAL,
        sonnet_pct      REAL,
        extra_used      REAL,
        extra_limit     REAL,
        extra_pct       REAL,
        extra_currency  TEXT,
        prepaid_balance REAL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON usage_snapshots(timestamp);",
    // v2 — Claude Code usage ingested from ~/.claude transcripts.
    // `cc_usage` is keyed by the assistant message id for natural dedup across
    // resumed sessions; `cc_files` tracks per-file size/mtime so ingestion only
    // re-reads transcripts that actually changed.
    "CREATE TABLE IF NOT EXISTS cc_usage (
        message_id   TEXT PRIMARY KEY,
        ts           TEXT NOT NULL,
        model        TEXT NOT NULL,
        input        INTEGER NOT NULL,
        output       INTEGER NOT NULL,
        cache_create INTEGER NOT NULL,
        cache_read   INTEGER NOT NULL,
        cost         REAL NOT NULL,
        session_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cc_usage_ts ON cc_usage(ts);
    CREATE TABLE IF NOT EXISTS cc_files (
        path  TEXT PRIMARY KEY,
        size  INTEGER NOT NULL,
        mtime TEXT NOT NULL
    );",
];

fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        conn.execute_batch(sql)?;
        // user_version doesn't accept bound params — interpolate the trusted index.
        conn.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
    }
    Ok(())
}

pub struct StatsDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageSnapshot {
    pub id: i64,
    pub timestamp: String,
    pub five_hour_pct: f64,
    pub five_hour_reset: Option<String>,
    pub seven_day_pct: f64,
    pub seven_day_reset: Option<String>,
    pub opus_pct: Option<f64>,
    pub sonnet_pct: Option<f64>,
    pub extra_used: Option<f64>,
    pub extra_limit: Option<f64>,
    pub extra_pct: Option<f64>,
    pub extra_currency: Option<String>,
    pub prepaid_balance: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageDelta {
    pub from_timestamp: String,
    pub to_timestamp: String,
    pub five_hour_delta: f64,
    pub seven_day_delta: f64,
    pub opus_delta: Option<f64>,
    pub sonnet_delta: Option<f64>,
}

// --- Exhaustion forecast (issue #7) ---

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
    fn unknown() -> Self {
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

// --- Claude Code usage analytics (sourced from ~/.claude transcripts) ---

/// One deduplicated assistant message's token usage + computed cost.
#[derive(Debug, Clone)]
pub struct CcUsageRow {
    pub message_id: String,
    pub ts: String,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_create: i64,
    pub cache_read: i64,
    pub cost: f64,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DailyPoint {
    pub date: String, // local YYYY-MM-DD
    pub input: i64,
    pub output: i64,
    pub cache_create: i64,
    pub cache_read: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize)]
pub struct ModelUsage {
    pub model: String,
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
}

#[derive(Debug, Serialize)]
pub struct HeatCell {
    pub weekday: i64, // 0=Sunday .. 6=Saturday (strftime %w, localtime)
    pub hour: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize, Default)]
pub struct Totals {
    pub input: i64,
    pub output: i64,
    pub cache_create: i64,
    pub cache_read: i64,
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
    pub sessions: i64,
}

#[derive(Debug, Serialize)]
pub struct Analytics {
    pub daily: Vec<DailyPoint>,
    pub by_model: Vec<ModelUsage>,
    pub heatmap: Vec<HeatCell>,
    pub totals: Totals,
}

#[derive(Debug, Serialize)]
pub struct PeriodCompare {
    pub current: Totals,
    pub previous: Totals,
}

fn totals_for(conn: &Connection, from: &str, to: &str) -> Result<Totals, rusqlite::Error> {
    conn.query_row(
        "SELECT COALESCE(SUM(input),0), COALESCE(SUM(output),0),
                COALESCE(SUM(cache_create),0), COALESCE(SUM(cache_read),0),
                COALESCE(SUM(cost),0.0), COUNT(*), COUNT(DISTINCT session_id)
         FROM cc_usage WHERE ts >= ?1 AND ts < ?2",
        params![from, to],
        |r| {
            let input: i64 = r.get(0)?;
            let output: i64 = r.get(1)?;
            let cc: i64 = r.get(2)?;
            let cr: i64 = r.get(3)?;
            Ok(Totals {
                input,
                output,
                cache_create: cc,
                cache_read: cr,
                total_tokens: input + output + cc + cr,
                cost: r.get(4)?,
                messages: r.get(5)?,
                sessions: r.get(6)?,
            })
        },
    )
}

impl StatsDb {
    pub fn open(db_path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_path)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn record_snapshot(&self, data: &UsageData) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let ts = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO usage_snapshots (
                timestamp, five_hour_pct, five_hour_reset,
                seven_day_pct, seven_day_reset,
                opus_pct, sonnet_pct,
                extra_used, extra_limit, extra_pct, extra_currency,
                prepaid_balance
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                ts,
                data.five_hour.percent_used,
                data.five_hour.reset_at,
                data.seven_day.percent_used,
                data.seven_day.reset_at,
                data.seven_day_opus.as_ref().map(|t| t.percent_used),
                data.seven_day_sonnet.as_ref().map(|t| t.percent_used),
                data.extra_usage.as_ref().map(|e| e.used_credits),
                data.extra_usage.as_ref().map(|e| e.monthly_limit),
                data.extra_usage.as_ref().map(|e| e.utilization),
                data.extra_usage.as_ref().map(|e| e.currency.clone()),
                data.prepaid_balance,
            ],
        )?;
        Ok(())
    }

    pub fn query_range(&self, from: &str, to: &str) -> Result<Vec<UsageSnapshot>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, timestamp, five_hour_pct, five_hour_reset,
                    seven_day_pct, seven_day_reset, opus_pct, sonnet_pct,
                    extra_used, extra_limit, extra_pct, extra_currency,
                    prepaid_balance
             FROM usage_snapshots
             WHERE timestamp >= ?1 AND timestamp <= ?2
             ORDER BY timestamp ASC",
        )?;
        let rows = stmt.query_map(params![from, to], |row| {
            Ok(UsageSnapshot {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                five_hour_pct: row.get(2)?,
                five_hour_reset: row.get(3)?,
                seven_day_pct: row.get(4)?,
                seven_day_reset: row.get(5)?,
                opus_pct: row.get(6)?,
                sonnet_pct: row.get(7)?,
                extra_used: row.get(8)?,
                extra_limit: row.get(9)?,
                extra_pct: row.get(10)?,
                extra_currency: row.get(11)?,
                prepaid_balance: row.get(12)?,
            })
        })?;
        rows.collect()
    }

    /// Total Claude Code cost (USD) recorded in `[from, to)`. Drives the daily
    /// budget when CC analytics is enabled.
    pub fn cost_in(&self, from: &str, to: &str) -> Result<f64, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        Ok(totals_for(&conn, from, to)?.cost)
    }

    /// Earliest recorded `seven_day_pct` in `[from, to]` — the day's starting
    /// weekly usage, used to derive "consumed today" when CC analytics is off.
    pub fn seven_day_baseline(&self, from: &str, to: &str) -> Result<Option<f64>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT seven_day_pct FROM usage_snapshots
             WHERE timestamp >= ?1 AND timestamp <= ?2
             ORDER BY timestamp ASC LIMIT 1",
            params![from, to],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn compute_delta(&self, from: &str, to: &str) -> Result<Option<UsageDelta>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        let first: Option<(String, f64, f64, Option<f64>, Option<f64>)> = conn
            .query_row(
                "SELECT timestamp, five_hour_pct, seven_day_pct, opus_pct, sonnet_pct
                 FROM usage_snapshots WHERE timestamp >= ?1 AND timestamp <= ?2
                 ORDER BY timestamp ASC LIMIT 1",
                params![from, to],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;

        let last: Option<(String, f64, f64, Option<f64>, Option<f64>)> = conn
            .query_row(
                "SELECT timestamp, five_hour_pct, seven_day_pct, opus_pct, sonnet_pct
                 FROM usage_snapshots WHERE timestamp >= ?1 AND timestamp <= ?2
                 ORDER BY timestamp DESC LIMIT 1",
                params![from, to],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;

        match (first, last) {
            (Some(f), Some(l)) if f.0 != l.0 => Ok(Some(UsageDelta {
                from_timestamp: f.0,
                to_timestamp: l.0,
                five_hour_delta: l.1 - f.1,
                seven_day_delta: l.2 - f.2,
                opus_delta: match (f.3, l.3) {
                    (Some(a), Some(b)) => Some(b - a),
                    _ => None,
                },
                sonnet_delta: match (f.4, l.4) {
                    (Some(a), Some(b)) => Some(b - a),
                    _ => None,
                },
            })),
            _ => Ok(None),
        }
    }

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

    pub fn latest(&self, count: u32) -> Result<Vec<UsageSnapshot>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, timestamp, five_hour_pct, five_hour_reset,
                    seven_day_pct, seven_day_reset, opus_pct, sonnet_pct,
                    extra_used, extra_limit, extra_pct, extra_currency,
                    prepaid_balance
             FROM usage_snapshots
             ORDER BY timestamp DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![count], |row| {
            Ok(UsageSnapshot {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                five_hour_pct: row.get(2)?,
                five_hour_reset: row.get(3)?,
                seven_day_pct: row.get(4)?,
                seven_day_reset: row.get(5)?,
                opus_pct: row.get(6)?,
                sonnet_pct: row.get(7)?,
                extra_used: row.get(8)?,
                extra_limit: row.get(9)?,
                extra_pct: row.get(10)?,
                extra_currency: row.get(11)?,
                prepaid_balance: row.get(12)?,
            })
        })?;
        let mut result: Vec<UsageSnapshot> = rows.collect::<Result<_, _>>()?;
        result.reverse();
        Ok(result)
    }

    pub fn cleanup_before(&self, before: &str) -> Result<usize, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM usage_snapshots WHERE timestamp < ?1",
            params![before],
        )
    }

    // --- Claude Code usage ingest + analytics ---

    /// Dedup-insert a batch of usage rows. Returns how many were newly inserted
    /// (existing message ids are ignored). Runs in one transaction for speed.
    pub fn cc_upsert(&self, rows: &[CcUsageRow]) -> Result<usize, rusqlite::Error> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut inserted = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO cc_usage
                 (message_id, ts, model, input, output, cache_create, cache_read, cost, session_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            )?;
            for r in rows {
                inserted += stmt.execute(params![
                    r.message_id,
                    r.ts,
                    r.model,
                    r.input,
                    r.output,
                    r.cache_create,
                    r.cache_read,
                    r.cost,
                    r.session_id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// Stored (size, mtime) for a transcript file, if previously ingested.
    pub fn cc_file_state(&self, path: &str) -> Result<Option<(i64, String)>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT size, mtime FROM cc_files WHERE path = ?1",
            params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
    }

    pub fn cc_set_file_state(&self, path: &str, size: i64, mtime: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cc_files (path, size, mtime) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET size = ?2, mtime = ?3",
            params![path, size, mtime],
        )?;
        Ok(())
    }

    /// Bundle of analytics over [from, to): daily series, per-model breakdown,
    /// weekday×hour heatmap and totals. Day/heatmap buckets use local time.
    pub fn analytics(&self, from: &str, to: &str) -> Result<Analytics, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        let daily = {
            let mut stmt = conn.prepare(
                "SELECT date(ts,'localtime') d, SUM(input), SUM(output),
                        SUM(cache_create), SUM(cache_read), SUM(cost)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY d ORDER BY d",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    let input: i64 = r.get(1)?;
                    let output: i64 = r.get(2)?;
                    let cc: i64 = r.get(3)?;
                    let cr: i64 = r.get(4)?;
                    Ok(DailyPoint {
                        date: r.get(0)?,
                        input,
                        output,
                        cache_create: cc,
                        cache_read: cr,
                        total_tokens: input + output + cc + cr,
                        cost: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let by_model = {
            let mut stmt = conn.prepare(
                "SELECT model, SUM(input+output+cache_create+cache_read), SUM(cost), COUNT(*)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY model ORDER BY 2 DESC",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    Ok(ModelUsage {
                        model: r.get(0)?,
                        total_tokens: r.get(1)?,
                        cost: r.get(2)?,
                        messages: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let heatmap = {
            let mut stmt = conn.prepare(
                "SELECT CAST(strftime('%w',ts,'localtime') AS INTEGER) w,
                        CAST(strftime('%H',ts,'localtime') AS INTEGER) h,
                        SUM(input+output+cache_create+cache_read), SUM(cost)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY w, h",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    Ok(HeatCell {
                        weekday: r.get(0)?,
                        hour: r.get(1)?,
                        total_tokens: r.get(2)?,
                        cost: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let totals = totals_for(&conn, from, to)?;
        Ok(Analytics {
            daily,
            by_model,
            heatmap,
            totals,
        })
    }

    pub fn analytics_compare(
        &self,
        cur_from: &str,
        cur_to: &str,
        prev_from: &str,
        prev_to: &str,
    ) -> Result<PeriodCompare, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        Ok(PeriodCompare {
            current: totals_for(&conn, cur_from, cur_to)?,
            previous: totals_for(&conn, prev_from, prev_to)?,
        })
    }

    /// Insert a snapshot with an explicit timestamp. Test-only — production code
    /// records "now"; tests need deterministic ordering and delta windows.
    #[cfg(test)]
    fn insert_at(&self, ts: &str, five: f64, seven: f64, opus: Option<f64>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_snapshots (timestamp, five_hour_pct, seven_day_pct, opus_pct)
             VALUES (?1, ?2, ?3, ?4)",
            params![ts, five, seven, opus],
        )
        .unwrap();
    }

    /// Test-only insert that also sets reset columns + extra_pct — the fields the
    /// forecast reads beyond the plain `insert_at` set.
    #[cfg(test)]
    fn insert_full(
        &self,
        ts: &str,
        five: f64,
        five_reset: Option<&str>,
        seven: f64,
        seven_reset: Option<&str>,
        extra: Option<f64>,
    ) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_snapshots
                (timestamp, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset, extra_pct)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ts, five, five_reset, seven, seven_reset, extra],
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> StatsDb {
        StatsDb::open(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn migration_sets_user_version() {
        let db = mem_db();
        let conn = db.conn.lock().unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrate_is_idempotent() {
        // Running migrate twice on the same connection must not error or regress.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }

    #[test]
    fn query_range_is_ordered_and_bounded() {
        let db = mem_db();
        db.insert_at("2026-01-01T00:00:00Z", 10.0, 1.0, None);
        db.insert_at("2026-01-01T02:00:00Z", 30.0, 3.0, None);
        db.insert_at("2026-01-01T01:00:00Z", 20.0, 2.0, None);

        let rows = db
            .query_range("2026-01-01T00:30:00Z", "2026-01-01T02:30:00Z")
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].five_hour_pct, 20.0); // ascending by timestamp
        assert_eq!(rows[1].five_hour_pct, 30.0);
    }

    #[test]
    fn compute_delta_first_to_last() {
        let db = mem_db();
        db.insert_at("2026-01-01T00:00:00Z", 10.0, 1.0, Some(5.0));
        db.insert_at("2026-01-01T01:00:00Z", 45.0, 4.0, Some(9.0));

        let d = db
            .compute_delta("2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z")
            .unwrap()
            .unwrap();
        assert_eq!(d.five_hour_delta, 35.0);
        assert_eq!(d.seven_day_delta, 3.0);
        assert_eq!(d.opus_delta, Some(4.0));
        assert_eq!(d.from_timestamp, "2026-01-01T00:00:00Z");
        assert_eq!(d.to_timestamp, "2026-01-01T01:00:00Z");
    }

    #[test]
    fn compute_delta_none_with_single_snapshot() {
        let db = mem_db();
        db.insert_at("2026-01-01T00:00:00Z", 10.0, 1.0, None);
        let d = db
            .compute_delta("2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z")
            .unwrap();
        assert!(d.is_none(), "a single snapshot yields no delta");
    }

    #[test]
    fn cleanup_before_removes_old_rows() {
        let db = mem_db();
        db.insert_at("2026-01-01T00:00:00Z", 10.0, 1.0, None);
        db.insert_at("2026-01-05T00:00:00Z", 20.0, 2.0, None);
        let removed = db.cleanup_before("2026-01-03T00:00:00Z").unwrap();
        assert_eq!(removed, 1);
        let rows = db
            .query_range("2026-01-01T00:00:00Z", "2026-01-31T00:00:00Z")
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].five_hour_pct, 20.0);
    }

    #[test]
    fn record_snapshot_roundtrip() {
        let db = mem_db();
        let data = UsageData {
            five_hour: crate::usage::UsageTier {
                percent_used: 42.0,
                reset_at: Some("2026-01-01T00:00:00Z".into()),
                is_limited: false,
            },
            seven_day: crate::usage::UsageTier {
                percent_used: 7.0,
                reset_at: None,
                is_limited: false,
            },
            seven_day_opus: None,
            seven_day_sonnet: None,
            extra_usage: Some(crate::usage::ExtraUsage {
                used_credits: 8.88,
                monthly_limit: 30.0,
                utilization: 29.6,
                currency: "USD".into(),
            }),
            prepaid_balance: Some(85.0),
            prepaid_currency: Some("USD".into()),
        };
        db.record_snapshot(&data).unwrap();
        let rows = db.latest(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].five_hour_pct, 42.0);
        assert_eq!(rows[0].extra_used, Some(8.88));
        assert_eq!(rows[0].prepaid_balance, Some(85.0));
    }

    // --- Claude Code analytics ---

    fn cc_row(id: &str, ts: &str, model: &str, input: i64, output: i64, cost: f64, session: &str) -> CcUsageRow {
        CcUsageRow {
            message_id: id.into(),
            ts: ts.into(),
            model: model.into(),
            input,
            output,
            cache_create: 0,
            cache_read: 0,
            cost,
            session_id: Some(session.into()),
        }
    }

    #[test]
    fn cc_upsert_dedups_by_message_id() {
        let db = mem_db();
        let rows = vec![
            cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1"),
            cc_row("m2", "2026-01-01T11:00:00Z", "claude-sonnet-4-5", 200, 80, 0.5, "s1"),
        ];
        assert_eq!(db.cc_upsert(&rows).unwrap(), 2);
        // re-inserting the same ids inserts nothing
        assert_eq!(db.cc_upsert(&rows).unwrap(), 0);
        // a new id alongside existing ones inserts only the new one
        let more = vec![
            cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1"),
            cc_row("m3", "2026-01-02T10:00:00Z", "claude-haiku-4-5", 10, 5, 0.01, "s2"),
        ];
        assert_eq!(db.cc_upsert(&more).unwrap(), 1);
    }

    #[test]
    fn cc_file_state_roundtrip() {
        let db = mem_db();
        assert!(db.cc_file_state("a.jsonl").unwrap().is_none());
        db.cc_set_file_state("a.jsonl", 123, "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(
            db.cc_file_state("a.jsonl").unwrap(),
            Some((123, "2026-01-01T00:00:00Z".to_string()))
        );
        // upsert overwrites
        db.cc_set_file_state("a.jsonl", 456, "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(db.cc_file_state("a.jsonl").unwrap().unwrap().0, 456);
    }

    #[test]
    fn analytics_aggregates_models_and_totals() {
        let db = mem_db();
        db.cc_upsert(&[
            cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1"),
            cc_row("m2", "2026-01-01T12:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1"),
            cc_row("m3", "2026-01-02T10:00:00Z", "claude-sonnet-4-5", 200, 80, 0.4, "s2"),
        ])
        .unwrap();

        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z").unwrap();

        // totals: tokens = (100+50)*2 + (200+80) = 580 ; cost = 2.4 ; 3 msgs, 2 sessions
        assert_eq!(a.totals.total_tokens, 580);
        assert!((a.totals.cost - 2.4).abs() < 1e-9);
        assert_eq!(a.totals.messages, 3);
        assert_eq!(a.totals.sessions, 2);

        // by_model ordered by tokens desc: opus (300) before sonnet (280)
        assert_eq!(a.by_model.len(), 2);
        assert_eq!(a.by_model[0].model, "claude-opus-4-7");
        assert_eq!(a.by_model[0].total_tokens, 300);
        assert_eq!(a.by_model[0].messages, 2);
        assert_eq!(a.by_model[1].model, "claude-sonnet-4-5");

        // daily has at least the two days (local bucketing may shift the boundary)
        assert!(a.daily.len() >= 1);
        let daily_total: i64 = a.daily.iter().map(|d| d.total_tokens).sum();
        assert_eq!(daily_total, 580);
    }

    #[test]
    fn analytics_compare_splits_periods() {
        let db = mem_db();
        db.cc_upsert(&[
            cc_row("m1", "2026-01-10T10:00:00Z", "claude-opus-4-7", 100, 0, 1.0, "s1"),
            cc_row("m2", "2026-01-03T10:00:00Z", "claude-opus-4-7", 50, 0, 0.5, "s2"),
        ])
        .unwrap();

        let c = db
            .analytics_compare(
                "2026-01-08T00:00:00Z",
                "2026-01-15T00:00:00Z",
                "2026-01-01T00:00:00Z",
                "2026-01-08T00:00:00Z",
            )
            .unwrap();
        assert_eq!(c.current.total_tokens, 100);
        assert_eq!(c.previous.total_tokens, 50);
    }

    #[test]
    fn analytics_empty_range_is_zeroed() {
        let db = mem_db();
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(a.totals.total_tokens, 0);
        assert_eq!(a.totals.cost, 0.0);
        assert!(a.by_model.is_empty());
        assert!(a.daily.is_empty());
    }

    // --- daily budget helpers ---

    #[test]
    fn cost_in_sums_only_window() {
        let db = mem_db();
        db.cc_upsert(&[
            cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 1.5, "s1"),
            cc_row("m2", "2026-01-01T12:00:00Z", "claude-opus-4-7", 100, 0, 2.0, "s1"),
            cc_row("m3", "2026-01-02T10:00:00Z", "claude-sonnet-4-5", 50, 0, 9.0, "s2"),
        ])
        .unwrap();
        let cost = db.cost_in("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert!((cost - 3.5).abs() < 1e-9, "only Jan 1 rows count, got {cost}");
        // empty window → zero
        assert_eq!(db.cost_in("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z").unwrap(), 0.0);
    }

    #[test]
    fn seven_day_baseline_takes_earliest() {
        let db = mem_db();
        db.insert_at("2026-01-01T08:00:00Z", 10.0, 20.0, None);
        db.insert_at("2026-01-01T12:00:00Z", 30.0, 35.0, None);
        let base = db
            .seven_day_baseline("2026-01-01T00:00:00Z", "2026-01-01T23:59:59Z")
            .unwrap();
        assert_eq!(base, Some(20.0));
        // no snapshot in window → None
        assert!(db
            .seven_day_baseline("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z")
            .unwrap()
            .is_none());
    }

    // --- exhaustion forecast (#7) ---

    fn now_at(ts: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(ts).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn forecast_measures_rate_eta_and_warns() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // 40→60% over 60min = 0.333%/min; remaining 40% → eta 120min.
        db.insert_full("2026-01-01T00:00:00Z", 40.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 60.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let f = db.forecast(60, now).unwrap();
        let fh = f.five_hour;
        assert!((fh.rate_per_hour - 20.0).abs() < 1e-6, "rate {}", fh.rate_per_hour);
        assert!((fh.eta_minutes.unwrap() - 120.0).abs() < 1e-6);
        // reset is 240min away; allowed = 40%/240min·60 = 10%/h.
        assert!((fh.allowed_per_hour.unwrap() - 10.0).abs() < 1e-6);
        // eta (120) < time-to-reset (240) → will exhaust before reset.
        assert_eq!(fh.pace, "warn");
    }

    #[test]
    fn forecast_ok_when_eta_after_reset() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // 50→56% over 60min = 0.1%/min; eta = 44/0.1 = 440min, reset only 60min away.
        db.insert_full("2026-01-01T00:00:00Z", 50.0, Some("2026-01-01T02:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 56.0, Some("2026-01-01T02:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!((fh.eta_minutes.unwrap() - 440.0).abs() < 1e-6);
        assert_eq!(fh.pace, "ok");
    }

    #[test]
    fn forecast_ok_when_rate_below_threshold() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // 40→41% over 60min = 0.0167%/min < MIN_RATE → measured-but-flat → no ETA,
        // pace "ok" (we did measure: it lasts), allowed still set.
        db.insert_full("2026-01-01T00:00:00Z", 40.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 41.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!(fh.eta_minutes.is_none());
        assert!(fh.allowed_per_hour.is_some());
        assert_eq!(fh.pace, "ok");
    }

    #[test]
    fn forecast_unknown_when_span_too_short() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // Only 5min of history (< MIN_SPAN_MIN) → rate unmeasurable → "unknown".
        db.insert_full("2026-01-01T00:55:00Z", 40.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 60.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!(fh.eta_minutes.is_none(), "span < MIN_SPAN_MIN must not yield an ETA");
        assert_eq!(fh.pace, "unknown");
    }

    #[test]
    fn forecast_allowed_without_measurable_history() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // Single snapshot: no span → no rate → "unknown", but recommended pace is
        // still derivable from the reset alone.
        db.insert_full("2026-01-01T01:00:00Z", 50.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!(fh.eta_minutes.is_none());
        // 50% left over 240min → 12.5%/h.
        assert!((fh.allowed_per_hour.unwrap() - 12.5).abs() < 1e-6);
        assert_eq!(fh.pace, "unknown");
    }

    #[test]
    fn forecast_extra_has_eta_but_no_allowed() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // extra 10→30% over 60min → eta = 70/0.333 = 210min; no reset → no allowed pace.
        db.insert_full("2026-01-01T00:00:00Z", 0.0, None, 0.0, None, Some(10.0));
        db.insert_full("2026-01-01T01:00:00Z", 0.0, None, 0.0, None, Some(30.0));

        let ex = db.forecast(60, now).unwrap().extra_usage.unwrap();
        assert!((ex.eta_minutes.unwrap() - 210.0).abs() < 1e-6);
        assert!(ex.allowed_per_hour.is_none(), "extra usage has no reset → no allowed pace");
        assert_eq!(ex.pace, "ok");
    }

    #[test]
    fn forecast_empty_db_is_unknown() {
        let db = mem_db();
        let f = db.forecast(60, now_at("2026-01-01T01:00:00Z")).unwrap();
        assert_eq!(f.five_hour, TierForecast::unknown());
        assert_eq!(f.seven_day, TierForecast::unknown());
        assert!(f.extra_usage.is_none());
    }
}
