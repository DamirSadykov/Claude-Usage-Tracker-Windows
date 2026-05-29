//! Analytics over ingested Claude Code usage: daily series, per-model breakdown,
//! weekday×hour heatmap, period totals and the cost-in-window query.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::StatsDb;

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
    /// Total Claude Code cost (USD) recorded in `[from, to)`. Drives the daily
    /// budget when CC analytics is enabled.
    pub fn cost_in(&self, from: &str, to: &str) -> Result<f64, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        Ok(totals_for(&conn, from, to)?.cost)
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
}
