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
}
