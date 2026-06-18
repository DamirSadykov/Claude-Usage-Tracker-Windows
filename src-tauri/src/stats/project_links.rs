//! Project merge links (issue #13): map a raw project name (the cwd basename
//! stored in cc_usage/cc_turn) to a `canonical` project it should be aggregated
//! under, so a renamed or absorbed project's usage history doesn't fragment.
//!
//! Resolution happens READ-TIME in the analytics queries (see `resolved_project`
//! in analytics.rs) — the raw rows in cc_usage/cc_turn are never rewritten, so
//! removing a link instantly restores the original per-project split.
//!
//! Invariant: the table is always SINGLE-LEVEL — a name that appears as a
//! `canonical` never also appears as an `alias`. `set_project_link` normalizes on
//! write to preserve this (following the target to its root and repointing any
//! links that pointed at the new alias), so the read-time COALESCE needs only one
//! hop and can never loop.

use rusqlite::params;
use serde::Serialize;

use super::StatsDb;

/// One alias→canonical merge mapping.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectLink {
    pub alias: String,
    pub canonical: String,
}

impl StatsDb {
    /// All merge links, ordered by canonical then alias. Drives the "Projects"
    /// management tab so the user sees which raw names fold into which canonical.
    pub fn project_links_all(&self) -> Result<Vec<ProjectLink>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT alias, canonical FROM project_links ORDER BY canonical, alias")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProjectLink {
                    alias: r.get(0)?,
                    canonical: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Merge `alias` into `canonical` (alias's usage is henceforth aggregated under
    /// canonical). Normalizes to keep the table single-level:
    ///   1. follow `canonical` to its root if it is itself an alias,
    ///   2. reject a self-link or a cycle,
    ///   3. repoint any links that pointed at `alias` to the root (since `alias`
    ///      is becoming an alias, it can no longer be a canonical),
    ///   4. upsert alias→root, then drop any self-loop step 3 produced.
    /// Empty/whitespace names are rejected.
    pub fn set_project_link(&self, alias: &str, canonical: &str) -> Result<(), String> {
        let alias = alias.trim();
        let canonical = canonical.trim();
        if alias.is_empty() || canonical.is_empty() {
            return Err("project name must not be empty".into());
        }
        if alias == canonical {
            return Err("a project cannot be merged into itself".into());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // 1. follow canonical to its root (bounded — the table is single-level, so
        // at most one hop in practice; the cap guards against any malformed state).
        let mut root = canonical.to_string();
        for _ in 0..64 {
            let next: Option<String> = tx
                .query_row(
                    "SELECT canonical FROM project_links WHERE alias = ?1",
                    params![root],
                    |r| r.get(0),
                )
                .ok();
            match next {
                Some(n) if n != root => root = n,
                _ => break,
            }
        }
        // 2. a cycle would make alias its own canonical — reject.
        if root == alias {
            return Err("that merge would create a cycle".into());
        }
        // 3. anything that pointed at `alias` must now point at the root.
        tx.execute(
            "UPDATE project_links SET canonical = ?1 WHERE canonical = ?2",
            params![root, alias],
        )
        .map_err(|e| e.to_string())?;
        // 4. record alias→root, then clear any self-loop step 3 may have created.
        tx.execute(
            "INSERT INTO project_links (alias, canonical) VALUES (?1, ?2)
             ON CONFLICT(alias) DO UPDATE SET canonical = ?2",
            params![alias, root],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM project_links WHERE alias = canonical", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Drop the merge for `alias`, restoring its own per-project line.
    pub fn remove_project_link(&self, alias: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM project_links WHERE alias = ?1", params![alias])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn db() -> StatsDb {
        StatsDb::open(Path::new(":memory:")).unwrap()
    }

    /// Map alias→canonical for easy assertions.
    fn links(db: &StatsDb) -> Vec<(String, String)> {
        db.project_links_all()
            .unwrap()
            .into_iter()
            .map(|l| (l.alias, l.canonical))
            .collect()
    }

    #[test]
    fn set_and_remove_roundtrip() {
        let db = db();
        db.set_project_link("alpha", "beta").unwrap();
        assert_eq!(links(&db), vec![("alpha".into(), "beta".into())]);
        db.remove_project_link("alpha").unwrap();
        assert!(links(&db).is_empty());
    }

    #[test]
    fn rejects_self_and_empty() {
        let db = db();
        assert!(db.set_project_link("a", "a").is_err());
        assert!(db.set_project_link("  ", "b").is_err());
        assert!(db.set_project_link("a", "").is_err());
    }

    #[test]
    fn names_are_trimmed() {
        let db = db();
        db.set_project_link("  alpha ", " beta ").unwrap();
        assert_eq!(links(&db), vec![("alpha".into(), "beta".into())]);
    }

    #[test]
    fn following_root_keeps_single_level() {
        // B→A exists; merging C into B must land C on the root A, not on B.
        let db = db();
        db.set_project_link("B", "A").unwrap();
        db.set_project_link("C", "B").unwrap();
        let mut got = links(&db);
        got.sort();
        assert_eq!(got, vec![("B".into(), "A".into()), ("C".into(), "A".into())]);
    }

    #[test]
    fn repoints_followers_when_canonical_becomes_alias() {
        // B→A exists; now merge A into C. A's follower B must come along to C.
        let db = db();
        db.set_project_link("B", "A").unwrap();
        db.set_project_link("A", "C").unwrap();
        let mut got = links(&db);
        got.sort();
        assert_eq!(got, vec![("A".into(), "C".into()), ("B".into(), "C".into())]);
    }

    #[test]
    fn rejects_cycle() {
        // A→B exists; the reverse B→A would create A↔B — reject, don't corrupt.
        let db = db();
        db.set_project_link("A", "B").unwrap();
        assert!(db.set_project_link("B", "A").is_err());
        assert_eq!(links(&db), vec![("A".into(), "B".into())]);
    }

    #[test]
    fn relinking_alias_overwrites_target() {
        let db = db();
        db.set_project_link("x", "one").unwrap();
        db.set_project_link("x", "two").unwrap();
        assert_eq!(links(&db), vec![("x".into(), "two".into())]);
    }
}
