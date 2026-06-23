//! Memory-bloat watcher for Claude's per-project memory.
//!
//! Claude Code keeps a per-project memory under
//! `~/.claude/projects/<encoded-cwd>/memory/`: a `MEMORY.md` index that is
//! loaded IN FULL every session (so it truncates past a size, silently dropping
//! facts) plus one `*.md` file per fact. A pasted log / blob bloats either the
//! index or an entry and quietly overflows the budget.
//!
//! This module only STATS files (never reads contents), so a periodic scan is
//! cheap. [`scan`] returns per-project sizes; `lib.rs::spawn_memory_loop` turns
//! them into a desktop notification on a sudden jump (delta) or, once at startup,
//! an already-bloated index/entry (absolute). Thresholds are derived from real
//! memory: healthy indexes are <3 KB and entries 1-6 KB; observed breakage ~27 KB.

use std::path::{Path, PathBuf};

/// `MEMORY.md` loads in full each session; past this it risks a partial load.
pub const MEMORY_MD_LIMIT: u64 = 10 * 1024;
/// A single entry this large is almost certainly a blob / log dump, not a fact.
pub const ENTRY_LIMIT: u64 = 12 * 1024;
/// A jump this large in a project's total memory between scans is suspicious
/// (a normal new fact is 1-3 KB).
pub const DELTA_LIMIT: u64 = 5 * 1024;

/// Per-project memory footprint; all sizes in bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemStat {
    /// The project's memory dir name (the encoded cwd, e.g. `D--projects-foo`).
    pub project: String,
    /// Sum of every `*.md` in `memory/`.
    pub total: u64,
    /// `MEMORY.md` size (the always-loaded index).
    pub memory_md: u64,
    /// Largest non-index `*.md` and its name.
    pub max_entry: u64,
    pub max_entry_name: String,
}

/// `~/.claude/projects`, or None if HOME/USERPROFILE is unset or it's absent.
fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let p = Path::new(&home).join(".claude").join("projects");
    p.is_dir().then_some(p)
}

/// Stat one `memory/` dir into a [`MemStat`] (no content reads).
fn stat_dir(project: String, dir: &Path) -> Option<MemStat> {
    let files = std::fs::read_dir(dir).ok()?;
    let mut total = 0u64;
    let mut memory_md = 0u64;
    let mut max_entry = 0u64;
    let mut max_entry_name = String::new();
    for f in files.flatten() {
        let path = f.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        total += size;
        let name = f.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case("MEMORY.md") {
            memory_md = size;
        } else if size > max_entry {
            max_entry = size;
            max_entry_name = name;
        }
    }
    Some(MemStat {
        project,
        total,
        memory_md,
        max_entry,
        max_entry_name,
    })
}

/// Scan every project's `memory/` dir. Cheap (stat only). One entry per project
/// that has a `memory/` dir; empty on any IO problem (never errors a caller).
pub fn scan() -> Vec<MemStat> {
    let Some(root) = claude_projects_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for ent in entries.flatten() {
        let dir = ent.path().join("memory");
        if !dir.is_dir() {
            continue;
        }
        let project = ent.file_name().to_string_lossy().into_owned();
        if let Some(stat) = stat_dir(project, &dir) {
            out.push(stat);
        }
    }
    out
}

/// A friendlier label for a notification: drop a leading drive marker so
/// `D--projects-MVPs-foo` reads as `projects-MVPs-foo`. The path encoding isn't
/// reversible, so this is lossy by design — just enough to recognize the project.
pub fn label(project: &str) -> String {
    if let Some(rest) = project.strip_prefix(|c: char| c.is_ascii_alphabetic()) {
        if let Some(rest) = rest.strip_prefix("--") {
            return rest.to_string();
        }
    }
    project.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_strips_drive_marker() {
        assert_eq!(label("D--projects-MVPs-foo"), "projects-MVPs-foo");
        assert_eq!(label("C--work-bar"), "work-bar");
        // No drive marker → unchanged.
        assert_eq!(label("plain-name"), "plain-name");
    }

    #[test]
    fn stat_dir_sums_md_and_finds_largest_entry() {
        let dir = std::env::temp_dir().join("cut_mem_stat_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("MEMORY.md"), vec![b'x'; 100]).unwrap();
        std::fs::write(dir.join("a.md"), vec![b'x'; 500]).unwrap();
        std::fs::write(dir.join("b.md"), vec![b'x'; 300]).unwrap();
        std::fs::write(dir.join("note.txt"), vec![b'x'; 9999]).unwrap(); // ignored (not .md)

        let s = stat_dir("proj".into(), &dir).unwrap();
        assert_eq!(s.total, 900); // 100 + 500 + 300, txt excluded
        assert_eq!(s.memory_md, 100);
        assert_eq!(s.max_entry, 500);
        assert_eq!(s.max_entry_name, "a.md");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
