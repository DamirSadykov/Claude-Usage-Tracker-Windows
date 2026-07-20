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
mod project_links;
mod snapshots;

pub use analytics::{
    Analytics, AnalyticsExt, DailyPoint, HeatCell, Insight, ModelUsage, PeriodCompare,
    Productivity, ProjectUsage, SessionUsage, SubagentSummary, SubagentUsage, TierBreakdown,
    ToolErrorStats, ToolUsage, Totals, TrendMetrics,
};
pub use cc_store::{CcActiveSession, CcUsageRow, ToolResultRow, TurnRow};
pub use project_links::ProjectLink;
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
    // v7 — recompute stored `cost` after the Opus price correction. Cost is
    // snapshotted at ingest time, so rows stored before the fix keep the old
    // Opus rate ($15/$75 — the legacy Opus 4/4.1 price); current Opus 4.5–4.8 is
    // $5/$25, which had overstated Opus spend 3×. A re-ingest can't fix this
    // (cc_upsert is INSERT-OR-IGNORE and never rewrites cost), and transcripts
    // may be gone, so we recompute in place. Mirrors cc::price_per_mtok /
    // cost_for at the time of writing; if prices change again, APPEND a new
    // migration rather than editing this one.
    "UPDATE cc_usage SET cost = CASE
        WHEN model LIKE '%fable%'  THEN (input*10.0 + cache_create*10.0*1.25 + cache_read*10.0*0.1 + output*50.0) / 1000000.0
        WHEN model LIKE '%opus%'   THEN (input* 5.0 + cache_create* 5.0*1.25 + cache_read* 5.0*0.1 + output*25.0) / 1000000.0
        WHEN model LIKE '%sonnet%' THEN (input* 3.0 + cache_create* 3.0*1.25 + cache_read* 3.0*0.1 + output*15.0) / 1000000.0
        WHEN model LIKE '%haiku%'  THEN (input* 1.0 + cache_create* 1.0*1.25 + cache_read* 1.0*0.1 + output* 5.0) / 1000000.0
        ELSE 0.0
     END;",
    // v8 — service tier per assistant message + a one-time full re-ingest.
    // `service_tier` is the value Anthropic's API echoes in
    // message.usage.service_tier ("standard" / "priority" / "batch"); a low
    // standard-share is an indirect throttling signal. NULL for older rows /
    // lines that didn't carry the field. The single `DELETE FROM cc_files`
    // forces every transcript to re-ingest once, back-filling this column AND
    // the new tables/columns added by v9–v11 (all migrations run before the
    // first ingest, so one wipe covers the whole batch of schema changes).
    "ALTER TABLE cc_usage ADD COLUMN service_tier TEXT;
     DELETE FROM cc_files;",
    // v9 — tool-result outcomes. One row per tool_use_id: whether the tool call
    // failed (is_error). Lives in type:"user" transcript lines (message.content[*]
    // with type "tool_result"); we keep ONLY the boolean flag + ids/ts, never the
    // tool output content (privacy contract). tool_use_id is the natural dedup
    // key (one result per call).
    "CREATE TABLE IF NOT EXISTS cc_tool_result (
        tool_use_id TEXT PRIMARY KEY,
        session_id  TEXT,
        ts          TEXT NOT NULL,
        is_error    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cc_tool_result_ts ON cc_tool_result(ts);",
    // v10 — active-time turns. `cc_turn` stores one row per `turn_duration`
    // system line (real wall-clock active time per turn, deduped by its uuid).
    // `is_subagent` mirrors isSidechain (in practice always 0 — subagents don't
    // emit turn_duration); `project` is the cwd basename for project filtering.
    "CREATE TABLE IF NOT EXISTS cc_turn (
        uuid          TEXT PRIMARY KEY,
        session_id    TEXT,
        ts            TEXT NOT NULL,
        duration_ms   INTEGER,
        message_count INTEGER,
        is_subagent   INTEGER,
        project       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cc_turn_session_ts ON cc_turn(session_id, ts);",
    // v11 — git-commit/push counters per assistant message. Each counts the
    // `git commit` / `git push` Bash invocations seen in that message; only the
    // COUNT is stored, never the command text (privacy contract). Existing rows
    // get DEFAULT 0 and are back-filled by the v8 re-ingest.
    "ALTER TABLE cc_usage ADD COLUMN git_commits INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE cc_usage ADD COLUMN git_pushes  INTEGER NOT NULL DEFAULT 0;",
    // v12 — project merge links (issue #13). Maps a raw project name (`alias`, the
    // cwd basename stored in cc_usage/cc_turn) to the `canonical` name it should be
    // aggregated under, so a renamed/absorbed project's history doesn't fragment
    // across the rename. Resolution is READ-TIME only — analytics queries COALESCE
    // the raw project through this table (see `resolved_project` in analytics.rs);
    // raw rows are never rewritten, so removing a link restores the original split.
    // Single-level by construction: writes normalize so a canonical is never itself
    // an alias (see `set_project_link` in project_links.rs).
    "CREATE TABLE IF NOT EXISTS project_links (
        alias     TEXT PRIMARY KEY,
        canonical TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_links_canonical ON project_links(canonical);",
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
    fn v7_recomputes_cost_for_current_prices() {
        // Rows stored with a deliberately wrong cost get rewritten by the v7
        // recompute migration to the current per-family price (mirrors cost_for).
        let db = mem_db();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch(
            "INSERT INTO cc_usage (message_id, ts, model, input, output, cache_create, cache_read, cost)
             VALUES ('o','t','claude-opus-4-7', 1000, 2000, 0, 0, 999.0),
                    ('s','t','claude-sonnet-4-5', 500, 1000, 0, 0, 999.0),
                    ('f','t','claude-fable-5',   1000, 2000, 0, 0, 999.0),
                    ('h','t','claude-haiku-4-5',  100,  100, 1000, 10000, 999.0);",
        )
        .unwrap();
        // Re-run only the cost-recompute migration (v7 = index 6); idempotent.
        conn.execute_batch(MIGRATIONS[6]).unwrap();
        let cost = |id: &str| -> f64 {
            conn.query_row("SELECT cost FROM cc_usage WHERE message_id=?1", [id], |r| r.get(0))
                .unwrap()
        };
        // opus $5/$25; sonnet $3/$15; fable $10/$50; haiku $1/$5 (+cache mults).
        assert!((cost("o") - 0.055).abs() < 1e-9, "opus {}", cost("o"));
        assert!((cost("s") - 0.0165).abs() < 1e-9, "sonnet {}", cost("s"));
        assert!((cost("f") - 0.11).abs() < 1e-9, "fable {}", cost("f"));
        // haiku: (100 + 1000*1.25 + 10000*0.1 + 100*5)/1e6 = (100+1250+1000+500)/1e6
        assert!((cost("h") - 0.00285).abs() < 1e-9, "haiku {}", cost("h"));
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
            scoped_weekly: Vec::new(),
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
            service_tier: None,
            git_commits: 0,
            git_pushes: 0,
        }
    }

    fn tr(id: &str, ts: &str, sess: &str, is_error: bool) -> ToolResultRow {
        ToolResultRow {
            tool_use_id: id.into(),
            session_id: Some(sess.into()),
            ts: ts.into(),
            is_error,
        }
    }

    /// Build a turn row directly (mirrors what parse_turn_line would produce).
    fn turn(uuid: &str, ts: &str, sess: &str, duration_ms: i64) -> TurnRow {
        TurnRow {
            uuid: uuid.into(),
            session_id: Some(sess.into()),
            ts: ts.into(),
            duration_ms,
            message_count: 1,
            is_subagent: false,
            project: None,
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

    // --- migrations: v8–v11 ---

    #[test]
    fn migration_count_advances_to_twelve() {
        let db = mem_db();
        let conn = db.conn.lock().unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        assert_eq!(MIGRATIONS.len(), 12);
    }

    #[test]
    fn cc_tool_result_and_turn_tables_exist_after_migrate() {
        let db = mem_db();
        let conn = db.conn.lock().unwrap();
        for name in ["cc_tool_result", "cc_turn", "project_links"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "table {name} should exist");
        }
        // git counter columns present on cc_usage.
        for col in ["service_tier", "git_commits", "git_pushes"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('cc_usage') WHERE name=?1",
                    [col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "column {col} should exist");
        }
    }

    // --- tool_result dedup + error rate ---

    #[test]
    fn cc_tool_result_dedups_by_tool_use_id() {
        let db = mem_db();
        let rows = vec![
            tr("a", "2026-01-01T10:00:00Z", "s1", false),
            tr("b", "2026-01-01T10:01:00Z", "s1", true),
        ];
        assert_eq!(db.cc_tool_result_upsert(&rows).unwrap(), 2);
        // re-ingest same ids → 0 new
        assert_eq!(db.cc_tool_result_upsert(&rows).unwrap(), 0);
        // new id alongside existing → only the new one
        let more = vec![
            tr("a", "2026-01-01T10:00:00Z", "s1", false),
            tr("c", "2026-01-02T10:00:00Z", "s2", true),
        ];
        assert_eq!(db.cc_tool_result_upsert(&more).unwrap(), 1);
    }

    #[test]
    fn analytics_ext_computes_tool_error_rate() {
        let db = mem_db();
        db.cc_upsert(&[cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 10, 5, 0.1, "s1")])
            .unwrap();
        // 1 of 4 calls errored → 25%
        db.cc_tool_result_upsert(&[
            tr("a", "2026-01-01T10:00:00Z", "s1", false),
            tr("b", "2026-01-01T10:00:01Z", "s1", false),
            tr("c", "2026-01-01T10:00:02Z", "s1", false),
            tr("d", "2026-01-01T10:00:03Z", "s1", true),
        ])
        .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert_eq!(a.tool_error.total, 4);
        assert_eq!(a.tool_error.errors, 1);
        assert!((a.tool_error.error_rate.unwrap() - 25.0).abs() < 1e-9);
    }

    #[test]
    fn analytics_ext_tool_error_none_when_empty() {
        let db = mem_db();
        db.cc_upsert(&[cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 10, 5, 0.1, "s1")])
            .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert_eq!(a.tool_error.total, 0);
        assert!(a.tool_error.error_rate.is_none());
    }

    #[test]
    fn insight_tool_error_rate_fires_on_volume_and_rate() {
        let db = mem_db();
        db.cc_upsert(&[cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 10, 5, 0.1, "s1")])
            .unwrap();
        // 40 calls, 8 errors → 20% ≥ 15%, total ≥ 30 → fires
        let mut rows = Vec::new();
        for i in 0..40 {
            rows.push(tr(
                &format!("t{i}"),
                "2026-01-01T10:00:00Z",
                "s1",
                i < 8, // first 8 are errors
            ));
        }
        db.cc_tool_result_upsert(&rows).unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert!(a.insights.iter().any(|i| i.kind == "tool_error_rate"));
    }

    // --- service tier ---

    #[test]
    fn analytics_ext_computes_tier_breakdown() {
        let db = mem_db();
        let mk = |id: &str, tier: Option<&str>| CcUsageRow {
            service_tier: tier.map(String::from),
            ..cc_row(id, "2026-01-01T10:00:00Z", "claude-opus-4-7", 10, 5, 0.1, "s1")
        };
        db.cc_upsert(&[
            mk("m1", Some("standard")),
            mk("m2", Some("standard")),
            mk("m3", Some("priority")),
            mk("m4", None),
        ])
        .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert_eq!(a.tier_breakdown.standard, 2);
        assert_eq!(a.tier_breakdown.non_standard, 1);
        assert_eq!(a.tier_breakdown.unknown, 1);
        // 2 / (2+1) = 66.67%
        assert!((a.tier_breakdown.standard_pct.unwrap() - 66.6667).abs() < 1e-2);
    }

    // --- cache hit ratio + savings ---

    #[test]
    fn analytics_computes_cache_hit_ratio() {
        let db = mem_db();
        // input=100, cache_read=900 → ratio = 900/(100+900) = 0.9
        let m = CcUsageRow {
            cache_read: 900,
            cache_create: 0,
            ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 50, 1.0, "s1")
        };
        db.cc_upsert(&[m]).unwrap();
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert!((a.totals.cache_hit_ratio - 0.9).abs() < 1e-9, "{}", a.totals.cache_hit_ratio);
    }

    #[test]
    fn cache_hit_ratio_zero_when_no_read_or_input() {
        let db = mem_db();
        let m = CcUsageRow {
            cache_create: 5000,
            cache_read: 0,
            ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 0, 200, 1.0, "s1")
        };
        db.cc_upsert(&[m]).unwrap();
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(a.totals.cache_hit_ratio, 0.0);
    }

    #[test]
    fn analytics_computes_cache_savings_per_model() {
        let db = mem_db();
        // opus pin=5: read 1M → +4.5 ; create 1M → −1.25
        let opus = CcUsageRow {
            cache_read: 1_000_000,
            cache_create: 1_000_000,
            ..cc_row("o", "2026-01-01T10:00:00Z", "claude-opus-4-7", 0, 0, 0.0, "s1")
        };
        // sonnet pin=3: read 1M → +2.7 ; no create
        let son = CcUsageRow {
            cache_read: 1_000_000,
            cache_create: 0,
            ..cc_row("s", "2026-01-01T11:00:00Z", "claude-sonnet-4-5", 0, 0, 0.0, "s2")
        };
        db.cc_upsert(&[opus, son]).unwrap();
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        // (4.5 − 1.25) + 2.7 = 5.95
        assert!((a.totals.cache_savings_usd - 5.95).abs() < 1e-9, "{}", a.totals.cache_savings_usd);
    }

    #[test]
    fn cache_savings_can_be_negative_and_skips_unknown_model() {
        let db = mem_db();
        let churn = CcUsageRow {
            cache_create: 1_000_000,
            cache_read: 0,
            ..cc_row("c", "2026-01-01T10:00:00Z", "claude-opus-4-7", 0, 0, 0.0, "s1")
        };
        let unknown = CcUsageRow {
            cache_read: 1_000_000,
            cache_create: 0,
            ..cc_row("u", "2026-01-01T11:00:00Z", "mystery-model", 0, 0, 0.0, "s2")
        };
        db.cc_upsert(&[churn, unknown]).unwrap();
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert!((a.totals.cache_savings_usd + 1.25).abs() < 1e-9, "{}", a.totals.cache_savings_usd);
    }

    #[test]
    fn insight_low_cache_hit_fires_on_volume_and_low_ratio() {
        let db = mem_db();
        // input=1.2M, cache_read=0.3M → read_input=1.5M (>1M), ratio=0.2 (<0.5)
        let m = CcUsageRow {
            cache_read: 300_000,
            cache_create: 0,
            ..cc_row("m", "2026-01-01T10:00:00Z", "claude-opus-4-7", 1_200_000, 0, 6.0, "s1")
        };
        db.cc_upsert(&[m]).unwrap();
        let ext = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert!(ext.insights.iter().any(|i| i.kind == "low_cache_hit"));
    }

    #[test]
    fn insight_low_cache_hit_silent_on_high_ratio() {
        let db = mem_db();
        // opus read 2M, input 50K → ratio ~0.975 → no low_cache_hit recommendation.
        let m = CcUsageRow {
            cache_read: 2_000_000,
            cache_create: 0,
            ..cc_row("m", "2026-01-01T10:00:00Z", "claude-opus-4-7", 50_000, 0, 1.0, "s1")
        };
        db.cc_upsert(&[m]).unwrap();
        let ext = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert!(
            !ext.insights.iter().any(|i| i.kind == "low_cache_hit"),
            "ratio ~0.975 should not trigger the low-hit recommendation"
        );
    }

    // --- turns / active time / productivity ---

    #[test]
    fn cc_turn_upsert_dedups_by_uuid() {
        let db = mem_db();
        let rows = vec![
            turn("u1", "2026-01-01T10:00:00Z", "s1", 60_000),
            turn("u2", "2026-01-01T10:05:00Z", "s1", 120_000),
        ];
        assert_eq!(db.cc_turn_upsert(&rows).unwrap(), 2);
        assert_eq!(db.cc_turn_upsert(&rows).unwrap(), 0);
        let more = vec![
            turn("u1", "2026-01-01T10:00:00Z", "s1", 60_000),
            turn("u3", "2026-01-02T10:00:00Z", "s2", 30_000),
        ];
        assert_eq!(db.cc_turn_upsert(&more).unwrap(), 1);
    }

    #[test]
    fn productivity_sums_active_time_with_cap() {
        let db = mem_db();
        // anchor cost so derivatives are computable
        db.cc_upsert(&[cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 6.0, "s1")])
            .unwrap();
        // 60_000 + 120_000 + 3_600_000(capped to 1_800_000) = 1_980_000 ms
        db.cc_turn_upsert(&[
            turn("t1", "2026-01-01T10:00:00Z", "s1", 60_000),
            turn("t2", "2026-01-01T10:01:00Z", "s1", 120_000),
            turn("t3", "2026-01-01T10:02:00Z", "s1", 3_600_000),
        ])
        .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        let p = &a.productivity;
        assert_eq!(p.active_ms, 1_980_000);
        assert_eq!(p.turns, 3);
        assert!((p.active_hours - 0.55).abs() < 1e-9, "{}", p.active_hours);
        // cost 6.0 / 0.55h = 10.909.../h
        assert!((p.cost_per_active_hour.unwrap() - 6.0 / 0.55).abs() < 1e-9);
    }

    #[test]
    fn productivity_derivatives_none_without_denominators() {
        let db = mem_db();
        // cost present but no turns/commits/edits → all per-X are None.
        db.cc_upsert(&[cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 6.0, "s1")])
            .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        let p = &a.productivity;
        assert_eq!(p.active_ms, 0);
        assert!(p.cost_per_active_hour.is_none());
        assert!(p.tokens_per_active_minute.is_none());
        assert!(p.cost_per_commit.is_none());
        assert!(p.cost_per_edit.is_none());
    }

    #[test]
    fn productivity_counts_git_commits_in_window() {
        let db = mem_db();
        db.cc_upsert(&[
            CcUsageRow {
                git_commits: 2,
                git_pushes: 1,
                ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 10.0, "s1")
            },
            // outside the window → not counted
            CcUsageRow {
                git_commits: 5,
                ..cc_row("m2", "2026-02-01T10:00:00Z", "claude-opus-4-7", 100, 0, 1.0, "s2")
            },
        ])
        .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert_eq!(a.productivity.git_commits, 2);
        assert_eq!(a.productivity.git_pushes, 1);
        // cost_per_commit = 10.0 / 2 = 5.0
        assert!((a.productivity.cost_per_commit.unwrap() - 5.0).abs() < 1e-9);
    }

    #[test]
    fn insight_low_roi_fires_above_median() {
        let db = mem_db();
        // 5 typical sessions: cost 1.0 over 1h each → 1.0 $/h.
        for i in 0..5 {
            let sess = format!("s{i}");
            db.cc_upsert(&[cc_row(
                &format!("m{i}"),
                "2026-01-01T10:00:00Z",
                "claude-opus-4-7",
                100,
                0,
                1.0,
                &sess,
            )])
            .unwrap();
            db.cc_turn_upsert(&[turn(&format!("u{i}"), "2026-01-01T10:00:00Z", &sess, 1_800_000)])
                .unwrap();
        }
        // window cost is dominated by an expensive session: cost 50 over ~30min
        // active. Window active_hours small, $/h high vs median 1.0.
        db.cc_upsert(&[cc_row("big", "2026-01-01T12:00:00Z", "claude-opus-4-7", 100, 0, 50.0, "sbig")])
            .unwrap();
        db.cc_turn_upsert(&[turn("ubig", "2026-01-01T12:00:00Z", "sbig", 1_800_000)])
            .unwrap();
        let a = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", None, 10)
            .unwrap();
        assert!(a.insights.iter().any(|i| i.kind == "low_roi"));
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
        // Trend block mirrors the Totals for cost/tokens and carries the extras.
        assert_eq!(c.current_trend.total_tokens, 100);
        assert_eq!(c.previous_trend.total_tokens, 50);
        assert!((c.current_trend.cost - 1.0).abs() < 1e-9);
        assert!((c.previous_trend.cost - 0.5).abs() < 1e-9);
    }

    #[test]
    fn trend_compare_computes_error_rate_and_cost_per_hour_both_periods() {
        let db = mem_db();
        // --- current window (Jan 8..15): cost 6 over 0.5h active, 1/4 tool errors.
        db.cc_upsert(&[cc_row("c1", "2026-01-10T10:00:00Z", "claude-opus-4-7", 100, 0, 6.0, "sc")])
            .unwrap();
        db.cc_turn_upsert(&[turn("tc", "2026-01-10T10:00:00Z", "sc", 1_800_000)]) // 0.5h
            .unwrap();
        db.cc_tool_result_upsert(&[
            tr("ca", "2026-01-10T10:00:00Z", "sc", false),
            tr("cb", "2026-01-10T10:00:01Z", "sc", false),
            tr("cc", "2026-01-10T10:00:02Z", "sc", false),
            tr("cd", "2026-01-10T10:00:03Z", "sc", true),
        ])
        .unwrap();
        // --- previous window (Jan 1..8): cost 2 over 1h active, 0 tool errors.
        // Two 30-min turns (each at the MAX_TURN_MS cap) sum to a clean 1h.
        db.cc_upsert(&[cc_row("p1", "2026-01-03T10:00:00Z", "claude-opus-4-7", 50, 0, 2.0, "sp")])
            .unwrap();
        db.cc_turn_upsert(&[
            turn("tp1", "2026-01-03T10:00:00Z", "sp", 1_800_000), // 0.5h
            turn("tp2", "2026-01-03T10:30:00Z", "sp", 1_800_000), // 0.5h
        ])
        .unwrap();
        db.cc_tool_result_upsert(&[
            tr("pa", "2026-01-03T10:00:00Z", "sp", false),
            tr("pb", "2026-01-03T10:00:01Z", "sp", false),
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
        // error_rate is a FRACTION (0..1): current 1/4 = 0.25, previous 0/2 = 0.0.
        assert!((c.current_trend.error_rate.unwrap() - 0.25).abs() < 1e-9);
        assert!((c.previous_trend.error_rate.unwrap() - 0.0).abs() < 1e-9);
        // cost_per_active_hour: current 6/0.5 = 12, previous 2/1 = 2.
        assert!((c.current_trend.cost_per_active_hour.unwrap() - 12.0).abs() < 1e-9);
        assert!((c.previous_trend.cost_per_active_hour.unwrap() - 2.0).abs() < 1e-9);
    }

    #[test]
    fn trend_compare_empty_previous_yields_none_and_zero() {
        let db = mem_db();
        // Only the current window has data; previous window is empty.
        db.cc_upsert(&[cc_row("c1", "2026-01-10T10:00:00Z", "claude-opus-4-7", 100, 0, 6.0, "sc")])
            .unwrap();
        db.cc_turn_upsert(&[turn("tc", "2026-01-10T10:00:00Z", "sc", 1_800_000)])
            .unwrap();

        let c = db
            .analytics_compare(
                "2026-01-08T00:00:00Z",
                "2026-01-15T00:00:00Z",
                "2026-01-01T00:00:00Z",
                "2026-01-08T00:00:00Z",
            )
            .unwrap();
        // Previous period: no rows, no turns, no tool results.
        assert_eq!(c.previous_trend.total_tokens, 0);
        assert_eq!(c.previous_trend.cost, 0.0);
        assert_eq!(c.previous_trend.cache_hit_ratio, 0.0);
        assert!(c.previous_trend.error_rate.is_none());
        assert!(c.previous_trend.cost_per_active_hour.is_none());
        // Current still has measurable cost-per-hour and no tool results → None rate.
        assert!((c.current_trend.cost_per_active_hour.unwrap() - 12.0).abs() < 1e-9);
        assert!(c.current_trend.error_rate.is_none());
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
    fn analytics_merges_linked_projects() {
        let db = mem_db();
        db.cc_upsert(&[
            CcUsageRow { project: Some("alpha".into()), ..cc_row("m1", "2026-01-01T10:00:00Z", "claude-opus-4-7", 100, 0, 1.0, "s1") },
            CcUsageRow { project: Some("beta".into()), ..cc_row("m2", "2026-01-01T11:00:00Z", "claude-opus-4-7", 200, 0, 2.0, "s2") },
        ])
        .unwrap();
        // Merge alpha into beta (rename/absorption).
        db.set_project_link("alpha", "beta").unwrap();

        // by_project collapses both raw names into one canonical line: tokens sum
        // and the distinct-session count spans both projects.
        let a = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(a.by_project.len(), 1);
        assert_eq!(a.by_project[0].project.as_deref(), Some("beta"));
        assert_eq!(a.by_project[0].total_tokens, 300);
        assert_eq!(a.by_project[0].sessions, 2);

        // Filtering by the canonical pulls in the alias's rows too; the filter list
        // shows only the canonical name.
        let ext = db
            .analytics_ext("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", Some("beta"), 10)
            .unwrap();
        assert_eq!(ext.totals.total_tokens, 300);
        assert_eq!(ext.totals.sessions, 2);
        assert_eq!(ext.projects, vec!["beta".to_string()]);

        // cc_projects (task picker) collapses to the canonical; cc_raw_projects
        // keeps both for the management UI.
        assert_eq!(db.cc_projects().unwrap(), vec!["beta".to_string()]);
        let mut raw = db.cc_raw_projects().unwrap();
        raw.sort();
        assert_eq!(raw, vec!["alpha".to_string(), "beta".to_string()]);

        // Dropping the link restores the original split.
        db.remove_project_link("alpha").unwrap();
        let a2 = db.analytics("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(a2.by_project.len(), 2);
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

    // --- 5h card reacts to a recent spike (recent-темп) ---

    #[test]
    fn forecast_five_hour_reacts_to_recent_spike_while_week_amortises() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset_five = "2026-01-08T05:00:00Z"; // 300 min away
        let reset_seven = "2026-01-14T00:00:00Z";
        // A quiet week: both tiers flat at 5% for 168 hourly snapshots…
        for h in 0..=167 {
            let ts = (now_at("2026-01-01T00:00:00Z") + chrono::Duration::hours(h)).to_rfc3339();
            db.insert_full(&ts, 5.0, Some(reset_five), 5.0, Some(reset_seven), None);
        }
        // …then a hot final hour: both jump 5%→25% (a 20%/h spike).
        db.insert_full("2026-01-08T00:00:00Z", 25.0, Some(reset_five), 25.0, Some(reset_seven), None);

        let f = db.forecast(60, now).unwrap();
        // 5h blends in the recent short-window burn → reacts to the spike.
        assert!(
            (f.five_hour.rate_per_hour - 20.0).abs() < 1e-6,
            "5h should react to spike, got {}",
            f.five_hour.rate_per_hour
        );
        // 25% used, 20%/h → eta 225min < 300min to reset → warn.
        assert_eq!(f.five_hour.pace, "warn");
        // 7-day tier still amortises the same spike across the week.
        let amortised = 20.0 / 168.0;
        assert!(
            (f.seven_day.rate_per_hour - amortised).abs() < 1e-6,
            "7d should amortise, got {}",
            f.seven_day.rate_per_hour
        );
    }

    #[test]
    fn forecast_five_hour_recent_idle_falls_back_to_weekly_mean() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset_five = "2026-01-08T05:00:00Z";
        // One burst early in the week (5%→25% in hour 1), then flat 25% for the
        // rest — including the whole recent window, which is idle.
        db.insert_full("2026-01-01T00:00:00Z", 5.0, Some(reset_five), 0.0, None, None);
        for h in 1..=168 {
            let ts = (now_at("2026-01-01T00:00:00Z") + chrono::Duration::hours(h)).to_rfc3339();
            db.insert_full(&ts, 25.0, Some(reset_five), 0.0, None, None);
        }

        let fh = db.forecast(60, now).unwrap().five_hour;
        // Recent window is flat → recent burn 0. The rate must NOT collapse to
        // 0; it falls back to the weekly mean (one 20% bucket over 168).
        let mean = 20.0 / 168.0;
        assert!(
            (fh.rate_per_hour - mean).abs() < 1e-6,
            "idle recent must fall back to weekly mean, got {}",
            fh.rate_per_hour
        );
    }

    #[test]
    fn forecast_five_hour_recent_ignores_reset_crossing() {
        let db = mem_db();
        let now = now_at("2026-01-08T00:00:00Z");
        let reset_a = "2026-01-08T00:00:00Z"; // reset happens at `now`
        let reset_b = "2026-01-08T05:00:00Z"; // fresh window after the reset
        // One 20% burn bucket early in the week gives a small positive mean…
        db.insert_full("2026-01-01T00:00:00Z", 5.0, Some(reset_a), 0.0, None, None);
        for h in 1..=167 {
            let ts = (now_at("2026-01-01T00:00:00Z") + chrono::Duration::hours(h)).to_rfc3339();
            db.insert_full(&ts, 25.0, Some(reset_a), 0.0, None, None);
        }
        // Recent window: 25% at 23:00, then a reset drops it to 3% at `now`.
        db.insert_full("2026-01-08T00:00:00Z", 3.0, Some(reset_b), 0.0, None, None);

        let fh = db.forecast(60, now).unwrap().five_hour;
        // Recent delta is negative (25→3, a reset) → recent ignored, not a huge
        // negative rate. Falls back to the weekly mean; rate stays ≥ 0.
        assert!(fh.rate_per_hour >= 0.0, "rate must not go negative: {}", fh.rate_per_hour);
        let mean = 20.0 / 167.0;
        assert!(
            (fh.rate_per_hour - mean).abs() < 1e-6,
            "reset-crossing recent must fall back to mean, got {}",
            fh.rate_per_hour
        );
    }
}
