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
/// How many consecutive scans a project's total must hold steady before we judge
/// it. This DEBOUNCES a reorganization (a "распил" of a bloated `MEMORY.md` into
/// thematic files): a burst of Writes keeps the total churning, so we wait for it
/// to settle and only then compare against the last stable baseline. At the 120s
/// scan cadence (`lib.rs::MEMORY_CHECK_INTERVAL`) this is ~4 min of quiet (#48).
pub const SETTLE_SCANS: u32 = 2;

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

/// What a settled scan decided — surfaced by [`Watch::observe`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Alert {
    /// The index or an entry was ALREADY oversized when first settled (one-time
    /// per project). `name` is the file, `bytes` its size.
    Large { name: String, bytes: u64 },
    /// The total jumped `delta` bytes above the last stable baseline — a paste or
    /// blob, not a reorganization.
    Grew { delta: u64 },
}

/// Per-project, debounced bloat watcher. It tracks a STABLE baseline and only
/// alerts once a reading has settled, so moving bytes between files without
/// changing the total (a reorganization) is silent — fixing the alert flood seen
/// when a bloated `MEMORY.md` is split into thematic files (#48).
///
/// Replaces the old "compare against the immediately-previous scan" logic, which
/// counted transient intermediate sizes (new files written before the index is
/// trimmed) as growth, and re-fired the absolute check on every app launch.
#[derive(Clone, Debug, Default)]
pub struct Watch {
    /// Previous raw total; `None` until the first scan.
    last: Option<u64>,
    /// Consecutive scans the total has equalled `last`.
    stable_for: u32,
    /// Last SETTLED total; `None` until the first settle (which also runs the
    /// one-time already-oversized check).
    baseline: Option<u64>,
}

impl Watch {
    /// Feed one scan of a project's [`MemStat`]. Returns `Some(Alert)` only when
    /// the reading has settled (held steady for [`SETTLE_SCANS`] scans) AND crosses
    /// a threshold; `None` while the total is still churning or within limits.
    pub fn observe(&mut self, s: &MemStat) -> Option<Alert> {
        match self.last {
            None => {
                // First sighting: establish a reading, don't judge it yet.
                self.last = Some(s.total);
                self.stable_for = 0;
                return None;
            }
            Some(prev) => {
                if s.total == prev {
                    self.stable_for += 1;
                } else {
                    self.stable_for = 0;
                }
                self.last = Some(s.total);
            }
        }
        if self.stable_for < SETTLE_SCANS {
            return None; // still churning — wait for the dust to settle
        }
        self.stable_for = 0; // re-arm for the next plateau

        match self.baseline {
            None => {
                // First settled observation: adopt it as the baseline and run the
                // one-time "already oversized" check (the index/entry was big
                // before we started watching, not something that just grew).
                self.baseline = Some(s.total);
                if s.memory_md > MEMORY_MD_LIMIT {
                    Some(Alert::Large {
                        name: "MEMORY.md".into(),
                        bytes: s.memory_md,
                    })
                } else if s.max_entry > ENTRY_LIMIT {
                    Some(Alert::Large {
                        name: s.max_entry_name.clone(),
                        bytes: s.max_entry,
                    })
                } else {
                    None
                }
            }
            Some(base) => {
                // Re-baseline to this plateau regardless: a reorganization that
                // returns to ~the same total has delta ~0 and stays silent, while
                // gradual growth never accumulates past the threshold in one settle.
                self.baseline = Some(s.total);
                if s.total >= base.saturating_add(DELTA_LIMIT) {
                    Some(Alert::Grew {
                        delta: s.total - base,
                    })
                } else {
                    None
                }
            }
        }
    }
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

    // A MemStat with a given total and (optionally) an oversized index/entry.
    fn stat(total: u64, memory_md: u64, max_entry: u64) -> MemStat {
        MemStat {
            project: "p".into(),
            total,
            memory_md,
            max_entry,
            max_entry_name: "big.md".into(),
        }
    }

    #[test]
    fn settles_then_flags_already_oversized_index_once() {
        let mut w = Watch::default();
        let s = stat(27 * 1024, 27 * 1024, 0);
        assert_eq!(w.observe(&s), None); // first sighting — establish only
        for _ in 0..(SETTLE_SCANS - 1) {
            assert_eq!(w.observe(&s), None); // settling, not yet judged
        }
        // The scan that reaches SETTLE_SCANS fires the one-time Large.
        assert_eq!(
            w.observe(&s),
            Some(Alert::Large {
                name: "MEMORY.md".into(),
                bytes: 27 * 1024
            })
        );
        // It does NOT re-fire while sitting on the same stable plateau.
        for _ in 0..(SETTLE_SCANS + 2) {
            assert_eq!(w.observe(&s), None);
        }
    }

    #[test]
    fn reorg_keeping_total_steady_never_alerts() {
        let mut w = Watch::default();
        let base = 20 * 1024;
        let healthy = stat(base, 8 * 1024, 0); // index under limit, total 20 KB
        for _ in 0..=SETTLE_SCANS {
            assert_eq!(w.observe(&healthy), None); // settle a clean baseline
        }
        // A "распил": total spikes (new files written) then returns (index trimmed).
        let spike = stat(base + 15 * 1024, 8 * 1024, 0);
        assert_eq!(w.observe(&spike), None); // churn — not settled
        assert_eq!(w.observe(&healthy), None); // back down — not settled
        // Even once it settles again at the original total, delta ~0 ⇒ silent.
        for _ in 0..=SETTLE_SCANS {
            assert_eq!(w.observe(&healthy), None);
        }
    }

    #[test]
    fn sudden_settled_growth_flags_grew_once() {
        let mut w = Watch::default();
        let base = 20 * 1024;
        let healthy = stat(base, 8 * 1024, 0);
        for _ in 0..=SETTLE_SCANS {
            assert_eq!(w.observe(&healthy), None);
        }
        // A blob is pasted: +10 KB, and it stays.
        let grown = stat(base + 10 * 1024, 8 * 1024, 0);
        let mut alerts = Vec::new();
        for _ in 0..=SETTLE_SCANS {
            if let Some(a) = w.observe(&grown) {
                alerts.push(a);
            }
        }
        assert_eq!(alerts, vec![Alert::Grew { delta: 10 * 1024 }]);
    }

    #[test]
    fn churning_total_never_settles_so_never_alerts() {
        let mut w = Watch::default();
        // A total that changes every scan never reaches SETTLE_SCANS — so even an
        // oversized index (memory_md > limit) stays silent until things settle.
        for i in 0..8u64 {
            let s = stat((20 + i) * 1024, 30 * 1024, 0);
            assert_eq!(w.observe(&s), None);
        }
    }
}
