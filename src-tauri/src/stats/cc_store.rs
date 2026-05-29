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
}
