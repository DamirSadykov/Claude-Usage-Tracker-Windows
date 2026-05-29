//! Usage snapshots: the periodic record of each tier's percent + reset, and the
//! range/delta/baseline queries derived from them.

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::StatsDb;
use crate::usage::UsageData;

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
}
