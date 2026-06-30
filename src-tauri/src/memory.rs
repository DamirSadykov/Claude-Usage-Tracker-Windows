//! Memory-bloat watcher for Claude's per-project memory.
//!
//! Claude Code keeps a per-project memory under
//! `~/.claude/projects/<encoded-cwd>/memory/`: a `MEMORY.md` index that is
//! loaded IN FULL every session plus one `*.md` file per fact. A pasted log /
//! blob bloats the total and quietly overflows the budget.
//!
//! We watch ONLY the *active* project — the one whose transcript was written most
//! recently — so a bloat alert is about what you're working on now, not every
//! project that ever lived on disk. The module only STATS files (never reads
//! contents), so a scan is cheap. [`scan`] returns the active project's size;
//! `lib.rs::spawn_memory_loop` turns a sudden settled jump (delta) into a desktop
//! notification. The growth threshold is derived from real memory: a normal new
//! fact is 1-3 KB, so a multi-KB jump is a paste/blob, not an edit.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A jump this large in the active project's total memory between settled scans
/// is suspicious (a normal new fact is 1-3 KB).
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
    /// Sum of every `*.md` in `memory/` (the index plus all fact files).
    pub total: u64,
}

/// Per-project, debounced bloat watcher. It tracks a STABLE baseline and only
/// alerts once a reading has settled, so moving bytes between files without
/// changing the total (a reorganization) is silent — fixing the alert flood seen
/// when a bloated `MEMORY.md` is split into thematic files (#48).
///
/// Replaces the old "compare against the immediately-previous scan" logic, which
/// counted transient intermediate sizes (new files written before the index is
/// trimmed) as growth.
#[derive(Clone, Debug, Default)]
pub struct Watch {
    /// Previous raw total; `None` until the first scan.
    last: Option<u64>,
    /// Consecutive scans the total has equalled `last`.
    stable_for: u32,
    /// Last SETTLED total; `None` until the first settle.
    baseline: Option<u64>,
}

impl Watch {
    /// Feed one scan of a project's [`MemStat`]. Returns `Some(delta_bytes)` only
    /// when the reading has settled (held steady for [`SETTLE_SCANS`] scans) AND
    /// grew at least [`DELTA_LIMIT`] above the last stable baseline; `None` while
    /// the total is still churning or within limits.
    pub fn observe(&mut self, s: &MemStat) -> Option<u64> {
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
                // First settled observation: adopt it as the baseline silently.
                // A project that was already large before we started watching is
                // not "growth" — only a jump from here on is.
                self.baseline = Some(s.total);
                None
            }
            Some(base) => {
                // Re-baseline to this plateau regardless: a reorganization that
                // returns to ~the same total has delta ~0 and stays silent, while
                // gradual growth never accumulates past the threshold in one settle.
                self.baseline = Some(s.total);
                (s.total >= base.saturating_add(DELTA_LIMIT)).then_some(s.total - base)
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

/// Newest mtime among a transcript dir's `*.jsonl` files; `None` if it has none.
/// This is the project's "last activity" signal — content appends bump a file's
/// mtime, whereas the dir's own mtime only changes on file create/delete.
fn newest_transcript_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    for ent in std::fs::read_dir(dir).ok()?.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(mt) = ent.metadata().and_then(|m| m.modified()) {
            if newest.is_none_or(|n| mt > n) {
                newest = Some(mt);
            }
        }
    }
    newest
}

/// Among `(project_dir_name, newest_transcript_mtime)` pairs, the name with the
/// newest mtime. Pure so it's testable without touching the clock or filesystem.
fn pick_active(candidates: Vec<(String, SystemTime)>) -> Option<String> {
    candidates.into_iter().max_by_key(|(_, t)| *t).map(|(n, _)| n)
}

/// The encoded dir name of the active project — the one whose transcript was
/// written most recently. `None` when no project under `root` has a transcript.
fn active_project(root: &Path) -> Option<String> {
    let mut candidates = Vec::new();
    for ent in std::fs::read_dir(root).ok()?.flatten() {
        let dir = ent.path();
        if !dir.is_dir() {
            continue;
        }
        if let Some(mt) = newest_transcript_mtime(&dir) {
            candidates.push((ent.file_name().to_string_lossy().into_owned(), mt));
        }
    }
    pick_active(candidates)
}

/// Stat one `memory/` dir into a [`MemStat`] (no content reads).
fn stat_dir(project: String, dir: &Path) -> Option<MemStat> {
    let files = std::fs::read_dir(dir).ok()?;
    let mut total = 0u64;
    for f in files.flatten() {
        let path = f.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        total += f.metadata().map(|m| m.len()).unwrap_or(0);
    }
    Some(MemStat { project, total })
}

/// Stat the ACTIVE project's `memory/` dir. `None` when there's no detectable
/// active project or it has no `memory/` dir. Cheap (stat only); never errors a
/// caller.
pub fn scan() -> Option<MemStat> {
    let root = claude_projects_dir()?;
    let project = active_project(&root)?;
    let dir = root.join(&project).join("memory");
    if !dir.is_dir() {
        return None;
    }
    stat_dir(project, &dir)
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
    use std::time::Duration;

    #[test]
    fn label_strips_drive_marker() {
        assert_eq!(label("D--projects-MVPs-foo"), "projects-MVPs-foo");
        assert_eq!(label("C--work-bar"), "work-bar");
        // No drive marker → unchanged.
        assert_eq!(label("plain-name"), "plain-name");
    }

    #[test]
    fn pick_active_takes_newest_mtime() {
        let t0 = SystemTime::UNIX_EPOCH;
        let t1 = t0 + Duration::from_secs(10);
        let t2 = t0 + Duration::from_secs(20);
        let active = pick_active(vec![
            ("old".into(), t0),
            ("newest".into(), t2),
            ("mid".into(), t1),
        ]);
        assert_eq!(active.as_deref(), Some("newest"));
        // No candidates → no active project.
        assert_eq!(pick_active(vec![]), None);
    }

    #[test]
    fn stat_dir_sums_md_files() {
        let dir = std::env::temp_dir().join("cut_mem_stat_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("MEMORY.md"), vec![b'x'; 100]).unwrap();
        std::fs::write(dir.join("a.md"), vec![b'x'; 500]).unwrap();
        std::fs::write(dir.join("b.md"), vec![b'x'; 300]).unwrap();
        std::fs::write(dir.join("note.txt"), vec![b'x'; 9999]).unwrap(); // ignored (not .md)

        let s = stat_dir("proj".into(), &dir).unwrap();
        assert_eq!(s.total, 900); // 100 + 500 + 300, txt excluded
        assert_eq!(s.project, "proj");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A MemStat with a given total.
    fn stat(total: u64) -> MemStat {
        MemStat {
            project: "p".into(),
            total,
        }
    }

    #[test]
    fn first_settle_adopts_baseline_silently() {
        let mut w = Watch::default();
        // Even an already-large total only establishes the baseline — no alert,
        // because it didn't *grow* while we were watching.
        let s = stat(40 * 1024);
        assert_eq!(w.observe(&s), None); // first sighting — establish only
        for _ in 0..(SETTLE_SCANS + 2) {
            assert_eq!(w.observe(&s), None); // settles, adopts baseline, stays quiet
        }
    }

    #[test]
    fn reorg_keeping_total_steady_never_alerts() {
        let mut w = Watch::default();
        let base = 20 * 1024;
        let healthy = stat(base);
        for _ in 0..=SETTLE_SCANS {
            assert_eq!(w.observe(&healthy), None); // settle a clean baseline
        }
        // A "распил": total spikes (new files written) then returns (index trimmed).
        let spike = stat(base + 15 * 1024);
        assert_eq!(w.observe(&spike), None); // churn — not settled
        assert_eq!(w.observe(&healthy), None); // back down — not settled
        // Even once it settles again at the original total, delta ~0 ⇒ silent.
        for _ in 0..=SETTLE_SCANS {
            assert_eq!(w.observe(&healthy), None);
        }
    }

    #[test]
    fn sudden_settled_growth_flags_delta_once() {
        let mut w = Watch::default();
        let base = 20 * 1024;
        let healthy = stat(base);
        for _ in 0..=SETTLE_SCANS {
            assert_eq!(w.observe(&healthy), None);
        }
        // A blob is pasted: +10 KB, and it stays.
        let grown = stat(base + 10 * 1024);
        let mut deltas = Vec::new();
        for _ in 0..=SETTLE_SCANS {
            if let Some(d) = w.observe(&grown) {
                deltas.push(d);
            }
        }
        assert_eq!(deltas, vec![10 * 1024]);
    }

    #[test]
    fn churning_total_never_settles_so_never_alerts() {
        let mut w = Watch::default();
        // A total that changes every scan never reaches SETTLE_SCANS, so growth
        // that never plateaus stays silent until things settle.
        for i in 0..8u64 {
            let s = stat((20 + i) * 1024);
            assert_eq!(w.observe(&s), None);
        }
    }
}
