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
}
