use chrono::Utc;
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
}
