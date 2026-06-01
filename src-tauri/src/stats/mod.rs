//! SQLite-backed stats store. This module owns the connection and the schema
//! migrations; the query/command methods are grouped by concern into submodules,
//! each adding its own `impl StatsDb` block:
//!   - `snapshots` — periodic usage snapshots + range/delta/baseline queries
//!   - `forecast`  — exhaustion forecast (#7)
//!   - `cc_store`  — Claude Code usage rows + per-file ingest state
//!   - `analytics` — daily/model/heatmap aggregates over CC usage

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

mod analytics;
mod cc_store;
mod forecast;
mod snapshots;

pub use analytics::{
    Analytics, AnalyticsExt, DailyPoint, HeatCell, Insight, ModelUsage, PeriodCompare,
    ProjectUsage, SessionUsage, SubagentSummary, SubagentUsage, ToolUsage, Totals,
};
pub use cc_store::CcUsageRow;
pub use forecast::{ForecastData, TierForecast};
pub use snapshots::{UsageDelta, UsageSnapshot};

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
    // v3 — per-project attribution. `project` is the working-directory basename
    // taken from each transcript line's `cwd`; NULL for lines without a cwd.
    "ALTER TABLE cc_usage ADD COLUMN project TEXT;",
    // v4 — force a one-time full re-ingest so the `cc_upsert` backfill can
    // attribute messages that were already stored before the project column
    // existed (INSERT OR IGNORE alone never revisits them).
    "DELETE FROM cc_files;",
    // v5 — subagent attribution. `is_subagent` is 1 when the line was produced
    // by a Task() child (transcript carries isSidechain=true or an agentName /
    // an `agent-*.jsonl` source path); `agent_name` is the subagent label when
    // exposed by the transcript. Wiping cc_files forces a re-ingest so existing
    // rows get backfilled.
    "ALTER TABLE cc_usage ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE cc_usage ADD COLUMN agent_name TEXT;
     DELETE FROM cc_files;",
    // v6 — per-message tool-use counts. One row per (message_id, tool_name)
    // with the call count; we can `SUM(n)` across messages to see how much a
    // session "wrote" (Edit/Write) vs "read" (Read/Grep) vs "ran" (Bash). Wipe
    // cc_files so all transcripts re-ingest and back-fill the new table.
    "CREATE TABLE IF NOT EXISTS cc_tool_use (
        message_id TEXT NOT NULL,
        tool_name  TEXT NOT NULL,
        n          INTEGER NOT NULL,
        PRIMARY KEY (message_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_cc_tool_use_name ON cc_tool_use(tool_name);
    DELETE FROM cc_files;",
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

impl StatsDb {
    pub fn open(db_path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_path)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

#[cfg(test)]
impl StatsDb {
    /// Insert a snapshot with an explicit timestamp. Test-only — production code
    /// records "now"; tests need deterministic ordering and delta windows.
    fn insert_at(&self, ts: &str, five: f64, seven: f64, opus: Option<f64>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_snapshots (timestamp, five_hour_pct, seven_day_pct, opus_pct)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![ts, five, seven, opus],
        )
        .unwrap();
    }

    /// Test-only insert that also sets reset columns + extra_pct — the fields the
    /// forecast reads beyond the plain `insert_at` set.
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
            rusqlite::params![ts, five, five_reset, seven, seven_reset, extra],
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::UsageData;
    use chrono::{DateTime, Utc};

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
            project: None,
            is_subagent: false,
            agent_name: None,
            tool_uses: Vec::new(),
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
        // m1 carries cache tokens so total_tokens exercises all four columns
        // (input + output + cache_create + cache_read), not just input+output.
        let m1 = CcUsageRow {
            cache_create: 10,
            cache_read: 20,
            ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1")
        };
        db.cc_upsert(&[
            m1,
            cc_row("m2", "2026-01-01T12:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1"),
            cc_row("m3", "2026-01-02T10:00:00Z", "claude-sonnet-4-5", 200, 80, 0.4, "s2"),
        ])
        .unwrap();

        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z").unwrap();

        // totals: tokens = (100+50+10+20) + (100+50) + (200+80) = 610 ; cost = 2.4
        assert_eq!(a.totals.total_tokens, 610);
        assert_eq!(a.totals.cache_create, 10);
        assert_eq!(a.totals.cache_read, 20);
        assert!((a.totals.cost - 2.4).abs() < 1e-9);
        assert_eq!(a.totals.messages, 3);
        assert_eq!(a.totals.sessions, 2);

        // by_model ordered by tokens desc: opus (330) before sonnet (280)
        assert_eq!(a.by_model.len(), 2);
        assert_eq!(a.by_model[0].model, "claude-opus-4-7");
        assert_eq!(a.by_model[0].total_tokens, 330);
        assert_eq!(a.by_model[0].messages, 2);
        assert_eq!(a.by_model[1].model, "claude-sonnet-4-5");

        // daily has at least the two days (local bucketing may shift the boundary)
        assert!(a.daily.len() >= 1);
        let daily_total: i64 = a.daily.iter().map(|d| d.total_tokens).sum();
        assert_eq!(daily_total, 610);
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
        assert!(a.by_project.is_empty());
        assert!(a.anomalies.is_empty());
        assert!(a.daily.is_empty());
    }

    #[test]
    fn analytics_groups_by_project() {
        let db = mem_db();
        db.cc_upsert(&[
            CcUsageRow { project: Some("alpha".into()), ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 1.0, "s1") },
            CcUsageRow { project: Some("alpha".into()), ..cc_row("m2", "2026-01-01T11:00:00Z", "claude-opus-4-7", 200, 0, 2.0, "s2") },
            CcUsageRow { project: Some("beta".into()),  ..cc_row("m3", "2026-01-01T12:00:00Z", "claude-sonnet-4-5", 50, 0, 0.5, "s3") },
            CcUsageRow { project: None,                 ..cc_row("m4", "2026-01-01T13:00:00Z", "claude-haiku-4-5", 10, 0, 0.1, "s4") },
        ])
        .unwrap();

        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        // ordered by tokens desc: alpha (300, 2 sessions) before beta (50) before None (10)
        assert_eq!(a.by_project.len(), 3);
        assert_eq!(a.by_project[0].project.as_deref(), Some("alpha"));
        assert_eq!(a.by_project[0].total_tokens, 300);
        assert_eq!(a.by_project[0].sessions, 2);
        assert_eq!(a.by_project[1].project.as_deref(), Some("beta"));
        assert!(a.by_project[2].project.is_none());
    }

    #[test]
    fn cc_upsert_backfills_null_project() {
        let db = mem_db();
        // First seen without a project (e.g. ingested before the column existed).
        assert_eq!(db.cc_upsert(&[cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 1.0, "s1")]).unwrap(), 1);
        // Re-ingest of the same message now carries a project: no new insert, but
        // the stored row gets attributed.
        let with_proj = CcUsageRow { project: Some("alpha".into()), ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 1.0, "s1") };
        assert_eq!(db.cc_upsert(&[with_proj]).unwrap(), 0, "dedup still ignores the duplicate insert");

        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(a.by_project.len(), 1);
        assert_eq!(a.by_project[0].project.as_deref(), Some("alpha"));
    }

    #[test]
    fn analytics_flags_token_outlier_sessions() {
        let db = mem_db();
        // Five typical sessions plus one ~1000× larger — only the big one is an outlier.
        let mut rows = Vec::new();
        for i in 0..5 {
            rows.push(cc_row(
                &format!("s{i}"),
                "2026-01-01T10:00:00Z",
                "claude-opus-4-7",
                100,
                0,
                0.1,
                &format!("sess{i}"),
            ));
        }
        rows.push(cc_row("big", "2026-01-01T12:00:00Z", "claude-opus-4-7", 100_000, 0, 50.0, "sessbig"));
        db.cc_upsert(&rows).unwrap();

        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(a.anomalies.len(), 1, "only the outsized session is flagged");
        assert_eq!(a.anomalies[0].session_id, "sessbig");
        assert_eq!(a.anomalies[0].total_tokens, 100_000);
    }

    #[test]
    fn analytics_no_anomalies_with_thin_history() {
        let db = mem_db();
        // Below the MIN_SESSIONS baseline: even a big session isn't flagged.
        db.cc_upsert(&[
            cc_row("a", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 0.1, "s1"),
            cc_row("b", "2026-01-01T11:00:00Z", "claude-opus-4-7", 100_000, 0, 50.0, "s2"),
        ])
        .unwrap();
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert!(a.anomalies.is_empty());
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
    fn forecast_ok_when_slow_rate_outlasts_reset() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // 40→41 over 60min → mean 1%/h. ETA at 1%/h = (100−41)·60 = 3540min;
        // reset is only 240min away → ETA well past it → pace=ok. The mean
        // path no longer suppresses small rates; the pace check handles it.
        db.insert_full("2026-01-01T00:00:00Z", 40.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 41.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!((fh.eta_minutes.unwrap() - 3540.0).abs() < 1e-6);
        assert!(fh.allowed_per_hour.is_some());
        assert_eq!(fh.pace, "ok");
    }

    #[test]
    fn forecast_unknown_when_history_doesnt_span_an_hour() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // Only 5min of history → no hour bucket fully covered (the earliest
        // sample is at 00:55, so pct_at(00:00) can't be sampled) → unknown.
        db.insert_full("2026-01-01T00:55:00Z", 40.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 60.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!(fh.eta_minutes.is_none(), "no fully covered hour bucket → no ETA");
        assert_eq!(fh.pace, "unknown");
        assert_eq!(fh.coverage_hours, 0);
    }

    #[test]
    fn forecast_spike_amortised_into_week_average() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset_five = "2026-01-08T05:00:00Z";
        let reset_seven = "2026-01-14T00:00:00Z"; // 6 days away
        // Past week: hourly snapshots, all flat at 5% (idle).
        for h in 0..=167 {
            let ts = (now_at("2026-01-01T00:00:00Z") + chrono::Duration::hours(h)).to_rfc3339();
            db.insert_full(&ts, 5.0, Some(reset_five), 5.0, Some(reset_seven), None);
        }
        // Hot final hour: 5%→25% (a 20%/h spike — what the short-window
        // forecast used to extrapolate into "exhausts tomorrow").
        db.insert_full("2026-01-08T00:00:00Z", 25.0, Some(reset_five), 25.0, Some(reset_seven), None);

        let f = db.forecast(60, now).unwrap();
        // Sum of bucket deltas = 20 (just the spike) over 168 covered buckets.
        // The mean amortises that into 20/168 ≈ 0.119%/h going forward.
        assert!(f.seven_day.coverage_hours >= 100, "{}", f.seven_day.coverage_hours);
        let expected = 20.0 / 168.0;
        assert!(
            (f.seven_day.rate_per_hour - expected).abs() < 1e-6,
            "got {}, expected {}",
            f.seven_day.rate_per_hour,
            expected
        );
        // 75% left at ~0.12%/h → ~26 days, reset in 6 → pace=ok.
        assert_eq!(f.seven_day.pace, "ok");
    }

    #[test]
    fn forecast_mean_projects_chronic_burn_to_warn() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset_seven = "2026-01-14T00:00:00Z"; // 6 days = 8640 min away
        // Seven-day pct grows 0.5%/h every hour for a week — no spike, just
        // steady chronic burn. The mean must surface this and project a real
        // ETA, even though no single bucket looks alarming.
        for h in 0..=167 {
            let ts = (now_at("2026-01-01T00:00:00Z") + chrono::Duration::hours(h)).to_rfc3339();
            let pct = (h as f64) * 0.5;
            db.insert_full(&ts, 0.0, Some("2026-01-08T05:00:00Z"), pct, Some(reset_seven), None);
        }
        // Final snapshot at `now` extends the same 0.5%/h trend (h=168 → 84%).
        db.insert_full("2026-01-08T00:00:00Z", 0.0, Some("2026-01-08T05:00:00Z"), 84.0, Some(reset_seven), None);

        let week = db.forecast(60, now).unwrap().seven_day;
        assert!((week.rate_per_hour - 0.5).abs() < 1e-6, "{}", week.rate_per_hour);
        // 16% left at 0.5%/h → 32h = 1920 min vs. 8640 min to reset → warn.
        let eta = week.eta_minutes.expect("chronic burn must produce an ETA");
        assert!((eta - 1920.0).abs() < 1.0, "{eta}");
        assert_eq!(week.pace, "warn");
    }

    #[test]
    fn forecast_forward_fills_when_now_is_slightly_after_latest() {
        let db = mem_db();
        // `now` is 30s after the latest snapshot — the common live case
        // because Utc::now() ticks past the poll loop's record_snapshot.
        // Without forward-fill the h=1 bucket would be dropped on every call
        // and a freshly-installed user would see "collecting data…" forever.
        let now = now_at("2026-01-01T01:00:30Z");
        db.insert_full("2026-01-01T00:00:00Z", 40.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);
        db.insert_full("2026-01-01T01:00:00Z", 60.0, Some("2026-01-01T05:00:00Z"), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!(fh.coverage_hours >= 1, "forward-fill should keep h=1 covered");
        // Interpolated start ≈ 40.17, forward-filled end = 60 → ~19.83%/h.
        assert!(
            fh.rate_per_hour > 15.0 && fh.rate_per_hour < 22.0,
            "{}",
            fh.rate_per_hour
        );
    }

    #[test]
    fn forecast_ignores_reset_at_microsecond_drift() {
        let db = mem_db();
        let now = now_at("2026-01-01T01:00:00Z");
        // Same logical 5h reset window, but the API returned two slightly
        // different sub-second timestamps for it. The earlier reset_at-strict
        // implementation dropped every such pair in production; the rate is
        // now driven by pct-decrease detection, which doesn't care.
        db.insert_full(
            "2026-01-01T00:00:00Z",
            40.0,
            Some("2026-01-01T05:00:00.111111+00:00"),
            0.0,
            None,
            None,
        );
        db.insert_full(
            "2026-01-01T01:00:00Z",
            60.0,
            Some("2026-01-01T05:00:00.222222+00:00"),
            0.0,
            None,
            None,
        );
        let fh = db.forecast(60, now).unwrap().five_hour;
        assert!(fh.coverage_hours >= 1);
        assert!((fh.rate_per_hour - 20.0).abs() < 1e-6);
    }

    #[test]
    fn forecast_drops_pairs_that_cross_reset() {
        let db = mem_db();
        let now = now_at("2026-01-08T02:00:00Z");
        let reset_a = "2026-01-08T01:00:00Z"; // about to reset
        let reset_b = "2026-01-15T01:00:00Z"; // post-reset
        // Pre-reset hour [00:00, 01:00] burns 0.5%/h (80 → 80.5).
        db.insert_full("2026-01-08T00:00:00Z", 80.0, Some(reset_a), 80.0, Some(reset_a), None);
        db.insert_full("2026-01-08T01:00:00Z", 80.5, Some(reset_a), 80.5, Some(reset_a), None);
        // Reset boundary: both tiers drop to 5%, reset_at flips.
        db.insert_full("2026-01-08T01:00:01Z", 5.0, Some(reset_b), 5.0, Some(reset_b), None);
        // Post-reset hour [01:00, 02:00] would be the bucket crossing the reset.
        db.insert_full("2026-01-08T02:00:00Z", 7.0, Some(reset_b), 7.0, Some(reset_b), None);

        let week = db.forecast(60, now).unwrap().seven_day;
        // h=1 ([01:00, 02:00]) brackets the reset_at flip → dropped.
        // h=2 ([00:00, 01:00]) is fully pre-reset → contributes 0.5%/h.
        // No negative "burn" of −75% leaks into the median.
        assert!(week.rate_per_hour >= 0.0);
        assert!((week.rate_per_hour - 0.5).abs() < 1e-6, "{}", week.rate_per_hour);
        assert!(week.coverage_hours >= 1);
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
    fn forecast_uses_cc_activity_to_widen_idle_coverage() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset = "2026-01-14T00:00:00Z";
        // Snapshots only for the last 3 hours — the rest of the week the app
        // was off. CC activity exists somewhere in the past week (proving the
        // CC ingest is wired up), but happened only in one of the off-hours.
        db.insert_full("2026-01-07T21:00:00Z", 8.0,  Some(reset), 8.0,  Some(reset), None);
        db.insert_full("2026-01-07T22:00:00Z", 10.0, Some(reset), 10.0, Some(reset), None);
        db.insert_full("2026-01-07T23:00:00Z", 12.0, Some(reset), 12.0, Some(reset), None);
        db.insert_full("2026-01-08T00:00:00Z", 14.0, Some(reset), 14.0, Some(reset), None);
        // A handful of CC events; only the one at 03:00 falls inside an
        // off-hour bucket, all others sit inside the snapshot-covered hours.
        db.cc_upsert(&[
            cc_row("c1", "2026-01-05T03:00:00Z", "claude-opus-4-7", 100, 0, 0.1, "s1"),
            cc_row("c2", "2026-01-07T22:30:00Z", "claude-opus-4-7", 100, 0, 0.1, "s2"),
            cc_row("c3", "2026-01-07T23:30:00Z", "claude-opus-4-7", 100, 0, 0.1, "s3"),
        ])
        .unwrap();

        // Without the CC witness: only 3 snapshot-covered hours (each 2%/h)
        // would contribute → mean ≈ 2%/h. With the CC witness: 3 covered + many
        // confirmed-idle off-hours → mean drops drastically.
        let week = db.forecast(60, now).unwrap().seven_day;
        assert!(
            week.coverage_hours > 100,
            "CC-confirmed idle should expand coverage well past the 3 snapshot hours, got {}",
            week.coverage_hours
        );
        assert!(
            week.rate_per_hour < 0.5,
            "off-hours should dilute the 2%/h burst, got {}",
            week.rate_per_hour
        );
    }

    #[test]
    fn forecast_does_not_invent_idle_when_cc_data_is_absent() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset = "2026-01-14T00:00:00Z";
        // Same setup as the previous test, but cc_usage is empty — we have
        // no way to tell whether the user simply doesn't use CC or whether
        // the ingest is broken. Falling back to snapshot-only coverage keeps
        // the mean honest to what we can actually verify.
        db.insert_full("2026-01-07T21:00:00Z", 8.0,  Some(reset), 8.0,  Some(reset), None);
        db.insert_full("2026-01-07T22:00:00Z", 10.0, Some(reset), 10.0, Some(reset), None);
        db.insert_full("2026-01-07T23:00:00Z", 12.0, Some(reset), 12.0, Some(reset), None);
        db.insert_full("2026-01-08T00:00:00Z", 14.0, Some(reset), 14.0, Some(reset), None);

        let week = db.forecast(60, now).unwrap().seven_day;
        // Three covered hours (h=1..3), all at 2%/h.
        assert_eq!(week.coverage_hours, 3);
        assert!((week.rate_per_hour - 2.0).abs() < 1e-6, "{}", week.rate_per_hour);
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
