//! Claude Code usage rows ingested from `~/.claude` transcripts: dedup-insert by
//! message id, plus the per-file (size, mtime) state that makes ingest incremental.

use rusqlite::{params, OptionalExtension};

use super::StatsDb;

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
    /// Working-directory basename the message was produced in (from the
    /// transcript's `cwd`). None for older rows / lines without a cwd.
    pub project: Option<String>,
    /// True when the line was produced by a Task() subagent (sidechain).
    pub is_subagent: bool,
    /// Subagent label exposed by the transcript (`agentName`/`attributionAgent`),
    /// when present — useful for grouping subagent spend by agent type.
    pub agent_name: Option<String>,
    /// Tool-use blocks in this message, grouped by tool name (e.g. ("Edit", 3),
    /// ("Bash", 1)). Empty when the message had no tool calls.
    pub tool_uses: Vec<(String, i64)>,
}

impl StatsDb {
    /// Dedup-insert a batch of usage rows. Returns how many were newly inserted
    /// (existing message ids are ignored). Runs in one transaction for speed.
    pub fn cc_upsert(&self, rows: &[CcUsageRow]) -> Result<usize, rusqlite::Error> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut inserted = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO cc_usage
                 (message_id, ts, model, input, output, cache_create, cache_read, cost,
                  session_id, project, is_subagent, agent_name)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            )?;
            // Backfill `project` / `is_subagent` / `agent_name` onto rows stored
            // before those columns existed. INSERT OR IGNORE leaves an existing
            // message untouched, so without this a re-ingest would never
            // attribute already-stored messages.
            let mut backfill = tx.prepare(
                "UPDATE cc_usage
                    SET project     = COALESCE(project, ?2),
                        is_subagent = CASE WHEN ?3 = 1 THEN 1 ELSE is_subagent END,
                        agent_name  = COALESCE(agent_name, ?4)
                  WHERE message_id = ?1",
            )?;
            // Per-message tool-use rows are inserted once per (message_id, tool).
            // INSERT OR IGNORE so re-ingest of the same transcript line is a no-op.
            let mut tool_stmt = tx.prepare(
                "INSERT OR IGNORE INTO cc_tool_use (message_id, tool_name, n)
                 VALUES (?1, ?2, ?3)",
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
                    r.project,
                    r.is_subagent as i64,
                    r.agent_name,
                ])?;
                backfill.execute(params![
                    r.message_id,
                    r.project,
                    r.is_subagent as i64,
                    r.agent_name,
                ])?;
                for (tool, n) in &r.tool_uses {
                    tool_stmt.execute(params![r.message_id, tool, n])?;
                }
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

    /// The currently-active main session = the non-subagent session with the most
    /// recent assistant turn. Returns the metrics runtime insights need (issue
    /// #46): message count, the latest turn's timestamp + its predecessor's (the
    /// gap that preceded any rewrite), the latest turn's read/create token split
    /// (to detect a cold prefix rewrite), and the model (for pricing). None when
    /// no transcripts have been ingested. Reads only aggregate columns — no
    /// transcript content.
    pub fn cc_active_session(&self) -> Result<Option<CcActiveSession>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let latest = conn
            .query_row(
                "WITH g AS (
                    SELECT session_id, project, ts, model, cache_read, cache_create,
                           LAG(ts) OVER (PARTITION BY session_id ORDER BY ts) AS prev_ts
                    FROM cc_usage
                    WHERE is_subagent = 0 AND session_id IS NOT NULL
                 )
                 SELECT session_id, project, ts, prev_ts, cache_read, cache_create, model
                 FROM g ORDER BY ts DESC LIMIT 1",
                [],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((session_id, project, last_ts, prev_ts, last_cache_read, last_cache_create, model)) =
            latest
        else {
            return Ok(None);
        };
        let messages: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cc_usage WHERE session_id = ?1 AND is_subagent = 0",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(Some(CcActiveSession {
            session_id,
            project,
            last_ts,
            prev_ts,
            last_cache_read,
            last_cache_create,
            messages,
            model,
        }))
    }
}

/// Aggregate snapshot of the active main session, used to build a runtime-insight
/// `ActiveSession` in the caller (which derives the gap and the rewrite cost).
#[derive(Debug, Clone)]
pub struct CcActiveSession {
    pub session_id: String,
    pub project: Option<String>,
    pub last_ts: String,
    /// Timestamp of the turn before `last_ts` in the same session (None = first turn).
    pub prev_ts: Option<String>,
    pub last_cache_read: i64,
    pub last_cache_create: i64,
    pub messages: i64,
    pub model: String,
}
