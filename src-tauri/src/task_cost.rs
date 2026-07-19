//! Join side of tokens-per-task (t#87): what did a TASK cost?
//!
//! Three sources meet here, none of which this module owns:
//!   • `task-attribution.json` — which tasks each session MOVED (worked), written
//!     by `cli.mjs task-cost publish` from the transcripts (this module is
//!     load-only over it, same split as corrections.rs / the CLI);
//!   • `todos.json` — the board, for resolving refs (id | number) and for the
//!     `status_history` in_progress intervals;
//!   • per-session token totals from SQLite (analytics::sessions_in via StatsDb).
//!
//! Attribution is deliberately CONSERVATIVE (t#87's explicit call): a session's
//! tokens land on a task only when the evidence names exactly ONE task —
//!   1. direct, tier 1 — the session itself moved exactly one task into a
//!      worked status (`set-status`). The strongest signal: it wins even when
//!      the session also commented on other tasks in passing;
//!   2. direct, tier 2 (no moves) — the session touched exactly one task via
//!      `comment add` / `handoff [set]` (what a post-/clear continuation
//!      typically leaves behind);
//!   3. interval fallback (no direct evidence at all) — exactly one
//!      same-project task was `in_progress` (per its `status_history`) during
//!      the session's time span AND the session MENTIONED it (user text /
//!      triage CLI verbs, collected by the Node scanner). The mention
//!      requirement is what keeps an unrelated same-project session that
//!      merely overlaps the window from inheriting the task's cost.
//! A session whose evidence names two or more tasks within a tier is counted
//! as AMBIGUOUS and reported as such — never smeared proportionally across the
//! candidates. A session with no evidence at all is simply untracked (the vast
//! majority: chats, research, work outside the board).
//!
//! Numeric refs additionally resolve only within the session's own project
//! (plus global tasks); uuid refs are exempt — see `resolve_idx`. The scanner
//! side (task-cost.mjs) contributes its own precision guard: evidence from a
//! command whose tool_result was an error (rejected, `set-status 99999`, bogus
//! status) is discarded before it ever reaches this join.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::stats::SessionUsage;
use crate::todos::{Todo, TodoFile};

fn default_version() -> u32 {
    1
}

/// One task a session moved: the ref exactly as the command named it (an id or
/// a number — resolution happens here, against the live board).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributionMove {
    #[serde(rename = "ref", default)]
    pub task_ref: String,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub first_ts: Option<String>,
    #[serde(default)]
    pub last_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributionSession {
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub project_dir: Option<String>,
    #[serde(default)]
    pub modified_at: Option<String>,
    #[serde(default)]
    pub moves: Vec<AttributionMove>,
    /// Tasks worked without a status move: `comment add` / `handoff [set]`
    /// targets (schema v2; empty for v1 files).
    #[serde(default)]
    pub touched: Vec<String>,
    /// Corroboration-only refs (user-text `t#N`/`#N`, triage CLI verbs) — the
    /// interval fallback requires the candidate to appear here (schema v2).
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// The on-disk shape of `task-attribution.json` (schema owned by
/// scripts/cli/task-cost.mjs). Every field defaults so a partial file loads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributionFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub sessions: Vec<AttributionSession>,
}

/// Forgiving read, mirroring corrections::load: missing/malformed → None.
pub fn load(path: &Path) -> Option<AttributionFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Cost of one task: every attributed session's tokens summed. `direct` vs
/// `interval` says which evidence attributed them (a task can have both).
#[derive(Debug, Clone, Serialize)]
pub struct TaskCostRow {
    pub id: String,
    pub number: u32,
    pub subject: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub sessions: u32,
    pub direct_sessions: u32,
    pub interval_sessions: u32,
    pub total_tokens: i64,
    pub cost: f64,
}

/// The whole join, ready for the UI. Ambiguous sessions are surfaced as a
/// bucket of their own so the board can say "this much work was real but
/// couldn't be pinned to one task" instead of silently dropping it.
#[derive(Debug, Clone, Serialize)]
pub struct TaskCosts {
    /// When the attribution side was generated (the freshness the card shows).
    pub generated_at: String,
    pub tasks: Vec<TaskCostRow>,
    pub ambiguous_sessions: u32,
    pub ambiguous_tokens: i64,
    pub ambiguous_cost: f64,
}

/// Resolve a transcript ref (id | number, '#' already stripped by the CLI)
/// against the board. Id wins; a purely numeric ref falls back to `number`.
///
/// Numeric refs are SCOPED to the session's project (global tasks always
/// match): board numbers are board-wide, so a session quoting numbers while
/// demonstrating or testing the tracker can name real tasks of a foreign
/// project (verified case: demo `set-status 220..226` drowned the task
/// actually being worked in an 8-candidate ambiguity). A cross-project move
/// by NUMBER is therefore dropped — conservative, like everything here. An id
/// ref is exempt: typing a full uuid is deliberate, not demo noise.
fn resolve_idx(todos: &TodoFile, task_ref: &str, sess_proj: Option<&str>) -> Option<usize> {
    if let Some(i) = todos.todos.iter().position(|t| t.id == task_ref) {
        return Some(i);
    }
    let n: u32 = task_ref.parse().ok()?;
    todos.todos.iter().position(|t| {
        t.number == n
            && match (t.project.as_deref(), sess_proj) {
                (None, _) => true, // global task — any session may name it
                (Some(p), Some(sp)) => p == sp,
                (Some(_), None) => false, // session project unknown — don't guess
            }
    })
}

/// Distinct task indexes a set of refs resolves to (unresolvable refs —
/// deleted tasks, out-of-scope numbers, garbage — drop out).
fn resolve_distinct<'a>(
    todos: &TodoFile,
    refs: impl Iterator<Item = &'a str>,
    sess_proj: Option<&str>,
) -> Vec<usize> {
    let mut seen: Vec<usize> = Vec::new();
    for r in refs {
        if let Some(idx) = resolve_idx(todos, r, sess_proj) {
            if !seen.contains(&idx) {
                seen.push(idx);
            }
        }
    }
    seen
}

/// A task's `in_progress` spans derived from its transition log: each
/// `in_progress` entry opens a span that the NEXT entry closes (or leaves open).
/// Timestamps are ISO-8601 UTC strings, so plain string comparison orders them.
fn in_progress_spans(t: &Todo) -> Vec<(String, Option<String>)> {
    let mut spans = Vec::new();
    for (i, e) in t.status_history.iter().enumerate() {
        if e.status != "in_progress" || e.at.is_empty() {
            continue;
        }
        let end = t.status_history.get(i + 1).map(|n| n.at.clone());
        spans.push((e.at.clone(), end));
    }
    spans
}

/// Does `[start, end]` overlap a span? Open-ended spans run to "now".
fn overlaps(start: &str, end: &str, span: &(String, Option<String>)) -> bool {
    let after_start = match &span.1 {
        Some(span_end) => start.as_bytes() < span_end.as_bytes(),
        None => true,
    };
    after_start && span.0.as_str() < end
}

/// What one session's evidence says. Direct vs Interval is preserved so the
/// consumer can trust the former and treat the latter as an estimate.
#[derive(Clone, Copy)]
enum Verdict {
    Direct(usize),   // index into todos.todos — the session's own CLI evidence
    Interval(usize), // time-overlap corroborated by a mention
    Ambiguous,       // ≥2 distinct tasks named within a tier — report, never smear
    None,            // no evidence — untracked
}

fn judge(
    todos: &TodoFile,
    attr_sess: Option<&AttributionSession>,
    usage: &SessionUsage,
) -> Verdict {
    // The session's project, for scoping numeric refs: SQLite is authoritative,
    // the transcript-derived `project` from the scanner is the fallback (both
    // come from the session's cwd).
    let sess_proj = usage
        .project
        .as_deref()
        .or_else(|| attr_sess.and_then(|a| a.project.as_deref()));
    if let Some(attr) = attr_sess {
        // Tier 1: worked set-status moves. The strongest signal — a clean
        // single-task mover wins even if the session also commented on others
        // in passing (a follow-up note must not poison the attribution).
        let moved = resolve_distinct(
            todos,
            attr.moves.iter().map(|m| m.task_ref.as_str()),
            sess_proj,
        );
        match moved.len() {
            1 => return Verdict::Direct(moved[0]),
            0 => {} // refs resolved to nothing (deleted task, garbage) → next tier
            _ => return Verdict::Ambiguous,
        }
        // Tier 2: comment add / handoff targets — the trace a post-/clear
        // continuation leaves when it never re-runs set-status.
        let touched = resolve_distinct(todos, attr.touched.iter().map(String::as_str), sess_proj);
        match touched.len() {
            1 => return Verdict::Direct(touched[0]),
            0 => {}
            _ => return Verdict::Ambiguous,
        }
    }
    // Interval fallback: same-project tasks that were in_progress during the
    // session — but ONLY those the session also mentioned. Without the mention
    // requirement any unrelated same-project session inside the task's
    // in_progress window would inherit its cost. Requires both sides to know
    // their project — a global task or an unattributed session would match far
    // too much.
    let Some(sess_proj) = sess_proj else {
        return Verdict::None;
    };
    let Some(attr) = attr_sess else {
        return Verdict::None; // no scanner record → no mentions → no corroboration
    };
    let mentioned = resolve_distinct(todos, attr.mentions.iter().map(String::as_str), Some(sess_proj));
    if mentioned.is_empty() {
        return Verdict::None;
    }
    let mut seen: Vec<usize> = Vec::new();
    for (idx, t) in todos.todos.iter().enumerate() {
        if t.project.as_deref() != Some(sess_proj) || !mentioned.contains(&idx) {
            continue;
        }
        if in_progress_spans(t)
            .iter()
            .any(|s| overlaps(&usage.start, &usage.end, s))
        {
            seen.push(idx);
        }
    }
    match seen.len() {
        1 => Verdict::Interval(seen[0]),
        0 => Verdict::None,
        _ => Verdict::Ambiguous,
    }
}

/// Join attribution + board + per-session usage into per-task costs.
/// `usage` must cover all time (the caller queries without a window): a task's
/// sessions may be arbitrarily old.
pub fn compute(attr: &AttributionFile, todos: &TodoFile, usage: &[SessionUsage]) -> TaskCosts {
    let by_session: HashMap<&str, &AttributionSession> = attr
        .sessions
        .iter()
        .map(|s| (s.session.as_str(), s))
        .collect();

    struct Acc {
        sessions: u32,
        direct: u32,
        interval: u32,
        tokens: i64,
        cost: f64,
    }
    let mut per_task: HashMap<usize, Acc> = HashMap::new();
    let mut ambiguous = (0u32, 0i64, 0f64);

    for u in usage {
        let attr_sess = by_session.get(u.session_id.as_str()).copied();
        let verdict = judge(todos, attr_sess, u);
        match verdict {
            Verdict::Direct(idx) | Verdict::Interval(idx) => {
                let direct = matches!(verdict, Verdict::Direct(_));
                let acc = per_task.entry(idx).or_insert(Acc {
                    sessions: 0,
                    direct: 0,
                    interval: 0,
                    tokens: 0,
                    cost: 0.0,
                });
                acc.sessions += 1;
                if direct {
                    acc.direct += 1;
                } else {
                    acc.interval += 1;
                }
                acc.tokens += u.total_tokens;
                acc.cost += u.cost;
            }
            Verdict::Ambiguous => {
                ambiguous.0 += 1;
                ambiguous.1 += u.total_tokens;
                ambiguous.2 += u.cost;
            }
            Verdict::None => {}
        }
    }

    let mut tasks: Vec<TaskCostRow> = per_task
        .into_iter()
        .map(|(idx, acc)| {
            let t = &todos.todos[idx];
            TaskCostRow {
                id: t.id.clone(),
                number: t.number,
                subject: t.subject.clone(),
                status: t.status.clone(),
                project: t.project.clone(),
                sessions: acc.sessions,
                direct_sessions: acc.direct,
                interval_sessions: acc.interval,
                total_tokens: acc.tokens,
                cost: acc.cost,
            }
        })
        .collect();
    tasks.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    TaskCosts {
        generated_at: attr.generated_at.clone(),
        tasks,
        ambiguous_sessions: ambiguous.0,
        ambiguous_tokens: ambiguous.1,
        ambiguous_cost: ambiguous.2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::todos::StatusChange;

    fn todo(id: &str, number: u32, project: Option<&str>) -> Todo {
        Todo {
            id: id.to_string(),
            number,
            subject: format!("task {number}"),
            description: String::new(),
            status: "in_progress".to_string(),
            status_history: Vec::new(),
            priority: String::new(),
            kind: String::new(),
            estimate_minutes: None,
            scheduled_for: None,
            theme: false,
            plan: String::new(),
            project: project.map(String::from),
            from: None,
            comments: Vec::new(),
            links: Vec::new(),
            depends_on: Vec::new(),
            handoff: String::new(),
            handoff_at: None,
            imported_at: None,
            created_by: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn board(todos: Vec<Todo>) -> TodoFile {
        TodoFile { version: 1, todos }
    }

    fn sess(id: &str, project: Option<&str>, start: &str, end: &str, tokens: i64, cost: f64) -> SessionUsage {
        SessionUsage {
            session_id: id.to_string(),
            project: project.map(String::from),
            start: start.to_string(),
            end: end.to_string(),
            total_tokens: tokens,
            cost,
            messages: 1,
            cache_create: 0,
        }
    }

    fn evidence(
        session: &str,
        moved: &[&str],
        touched: &[&str],
        mentions: &[&str],
    ) -> AttributionSession {
        AttributionSession {
            session: session.to_string(),
            project: None,
            project_dir: None,
            modified_at: None,
            moves: moved
                .iter()
                .map(|r| AttributionMove {
                    task_ref: r.to_string(),
                    statuses: vec!["in_progress".to_string()],
                    first_ts: None,
                    last_ts: None,
                })
                .collect(),
            touched: touched.iter().map(|s| s.to_string()).collect(),
            mentions: mentions.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn moves(session: &str, refs: &[&str]) -> AttributionSession {
        evidence(session, refs, &[], &[])
    }

    fn attr(sessions: Vec<AttributionSession>) -> AttributionFile {
        AttributionFile {
            version: 1,
            kind: "task.attribution".to_string(),
            generated_at: "T".to_string(),
            sessions,
        }
    }

    #[test]
    fn one_task_moved_attributes_the_whole_session() {
        let todos = board(vec![todo("a", 7, None)]);
        // Ref by number and by id both resolve to the same task.
        let a = attr(vec![moves("s1", &["7"]), moves("s2", &["a"])]);
        let usage = vec![
            sess("s1", None, "T1", "T2", 100, 1.0),
            sess("s2", None, "T3", "T4", 50, 0.5),
        ];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 7);
        assert_eq!(out.tasks[0].sessions, 2);
        assert_eq!(out.tasks[0].direct_sessions, 2);
        assert_eq!(out.tasks[0].total_tokens, 150);
        assert_eq!(out.ambiguous_sessions, 0);
    }

    #[test]
    fn two_tasks_moved_is_ambiguous_never_smeared() {
        let todos = board(vec![todo("a", 1, None), todo("b", 2, None)]);
        let a = attr(vec![moves("s1", &["1", "2"])]);
        let usage = vec![sess("s1", None, "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert!(out.tasks.is_empty());
        assert_eq!(out.ambiguous_sessions, 1);
        assert_eq!(out.ambiguous_tokens, 100);
    }

    #[test]
    fn unresolvable_refs_fall_back_gracefully() {
        // Garbage refs (deleted task, docs example) resolve to nothing → the
        // session falls through to the fallback (which finds no corroborating
        // mention here), not counted ambiguous.
        let todos = board(vec![todo("a", 1, None)]);
        let a = attr(vec![moves("s1", &["zzz"])]);
        let usage = vec![sess("s1", None, "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert!(out.tasks.is_empty());
        assert_eq!(out.ambiguous_sessions, 0);
    }

    #[test]
    fn touched_alone_attributes_directly() {
        // A post-/clear continuation: no set-status, but it commented / wrote a
        // handoff on exactly one task → direct attribution, tier 2.
        let todos = board(vec![todo("a", 7, None)]);
        let a = attr(vec![evidence("s1", &[], &["7"], &[])]);
        let usage = vec![sess("s1", None, "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].direct_sessions, 1);
        assert_eq!(out.tasks[0].interval_sessions, 0);
    }

    #[test]
    fn a_clean_move_outranks_touches_on_other_tasks() {
        // Worked #1, left a follow-up note on #2: the single set-status wins —
        // the passing comment must not push the session into ambiguity.
        let todos = board(vec![todo("a", 1, None), todo("b", 2, None)]);
        let a = attr(vec![evidence("s1", &["1"], &["2"], &[])]);
        let usage = vec![sess("s1", None, "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 1);
        assert_eq!(out.ambiguous_sessions, 0);
    }

    #[test]
    fn numeric_ref_to_a_foreign_project_task_is_out_of_scope() {
        // The session's project is "proj"; the moved number belongs to a task
        // of another project → dropped, neither attributed nor ambiguous.
        let todos = board(vec![todo("a", 1, Some("other"))]);
        let a = attr(vec![moves("s1", &["1"])]);
        let usage = vec![sess("s1", Some("proj"), "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert!(out.tasks.is_empty());
        assert_eq!(out.ambiguous_sessions, 0);
    }

    #[test]
    fn foreign_project_demo_refs_leave_a_clean_direct() {
        // The verified self-capture case: a session working task #1 also ran
        // demo `set-status` commands quoting numbers of ANOTHER project's
        // tasks. Scoping drops the demo refs → clean direct, not ambiguous.
        let todos = board(vec![
            todo("a", 1, Some("proj")),
            todo("b", 220, Some("neighbour")),
            todo("c", 221, Some("neighbour")),
        ]);
        let a = attr(vec![moves("s1", &["1", "220", "221"])]);
        let usage = vec![sess("s1", Some("proj"), "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 1);
        assert_eq!(out.ambiguous_sessions, 0);
    }

    #[test]
    fn uuid_ref_crosses_projects_deliberately() {
        // Typing a full id is intent, not demo noise — no scoping for ids.
        let todos = board(vec![todo("u-fixed", 1, Some("other"))]);
        let a = attr(vec![moves("s1", &["u-fixed"])]);
        let usage = vec![sess("s1", Some("proj"), "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 1);
    }

    #[test]
    fn unknown_session_project_never_guesses_a_projected_task() {
        // Neither SQLite nor the scanner knows the session's project → numeric
        // refs may still hit GLOBAL tasks, but never project-owned ones.
        let todos = board(vec![todo("a", 1, Some("proj")), todo("g", 2, None)]);
        let a = attr(vec![moves("s1", &["1"]), moves("s2", &["2"])]);
        let usage = vec![
            sess("s1", None, "T1", "T2", 100, 1.0),
            sess("s2", None, "T1", "T2", 50, 0.5),
        ];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 2);
    }

    #[test]
    fn two_touched_tasks_without_moves_are_ambiguous() {
        let todos = board(vec![todo("a", 1, None), todo("b", 2, None)]);
        let a = attr(vec![evidence("s1", &[], &["1", "2"], &[])]);
        let usage = vec![sess("s1", None, "T1", "T2", 100, 1.0)];
        let out = compute(&a, &todos, &usage);
        assert!(out.tasks.is_empty());
        assert_eq!(out.ambiguous_sessions, 1);
    }

    #[test]
    fn interval_fallback_needs_exactly_one_matching_task() {
        let mut t1 = todo("a", 1, Some("proj"));
        t1.status_history = vec![
            StatusChange { status: "in_progress".into(), at: "2026-07-10T10:00:00Z".into() },
            StatusChange { status: "review".into(), at: "2026-07-10T18:00:00Z".into() },
        ];
        // Same project, but its span doesn't touch the session.
        let mut t2 = todo("b", 2, Some("proj"));
        t2.status_history = vec![StatusChange {
            status: "in_progress".into(),
            at: "2026-07-12T00:00:00Z".into(),
        }];
        let todos = board(vec![t1, t2]);
        // Both tasks mentioned — but only #1's in_progress span overlaps.
        let a = attr(vec![evidence("s1", &[], &[], &["1", "2"])]);
        let usage = vec![sess(
            "s1",
            Some("proj"),
            "2026-07-10T12:00:00Z",
            "2026-07-10T14:00:00Z",
            80,
            0.8,
        )];
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 1);
        assert_eq!(out.tasks[0].interval_sessions, 1);
    }

    #[test]
    fn interval_fallback_requires_a_mention() {
        // THE false-positive fix: an unrelated same-project session inside the
        // task's in_progress window (chat, research) never names the task →
        // untracked, not attributed.
        let mut t = todo("a", 1, Some("proj"));
        t.status_history = vec![StatusChange {
            status: "in_progress".into(),
            at: "2026-07-10T00:00:00Z".into(),
        }];
        let todos = board(vec![t]);
        let usage = vec![sess(
            "s1",
            Some("proj"),
            "2026-07-10T12:00:00Z",
            "2026-07-10T14:00:00Z",
            80,
            0.8,
        )];
        // No scanner record at all, and a record whose mentions name something else.
        for a in [attr(vec![]), attr(vec![evidence("s1", &[], &[], &["999"])])] {
            let out = compute(&a, &todos, &usage);
            assert!(out.tasks.is_empty());
            assert_eq!(out.ambiguous_sessions, 0);
        }
    }

    #[test]
    fn interval_fallback_requires_matching_project() {
        let mut t = todo("a", 1, Some("other"));
        t.status_history = vec![StatusChange {
            status: "in_progress".into(),
            at: "2026-07-10T00:00:00Z".into(),
        }];
        let todos = board(vec![t]);
        let usage = vec![sess(
            "s1",
            Some("proj"),
            "2026-07-10T12:00:00Z",
            "2026-07-10T14:00:00Z",
            80,
            0.8,
        )];
        let out = compute(&attr(vec![evidence("s1", &[], &[], &["1"])]), &todos, &usage);
        assert!(out.tasks.is_empty());
        assert_eq!(out.ambiguous_sessions, 0);
    }

    #[test]
    fn two_overlapping_mentioned_intervals_are_ambiguous() {
        let mk = |id: &str, n: u32| {
            let mut t = todo(id, n, Some("proj"));
            t.status_history = vec![StatusChange {
                status: "in_progress".into(),
                at: "2026-07-10T00:00:00Z".into(),
            }];
            t
        };
        let todos = board(vec![mk("a", 1), mk("b", 2)]);
        let usage = vec![sess(
            "s1",
            Some("proj"),
            "2026-07-10T12:00:00Z",
            "2026-07-10T14:00:00Z",
            80,
            0.8,
        )];
        let a = attr(vec![evidence("s1", &[], &[], &["1", "2"])]);
        let out = compute(&a, &todos, &usage);
        assert!(out.tasks.is_empty());
        assert_eq!(out.ambiguous_sessions, 1);
    }

    #[test]
    fn a_mention_disambiguates_two_overlapping_intervals() {
        // Nice side effect of corroboration: two tasks in_progress at once used
        // to force ambiguity — a session that names only one of them now
        // attributes cleanly.
        let mk = |id: &str, n: u32| {
            let mut t = todo(id, n, Some("proj"));
            t.status_history = vec![StatusChange {
                status: "in_progress".into(),
                at: "2026-07-10T00:00:00Z".into(),
            }];
            t
        };
        let todos = board(vec![mk("a", 1), mk("b", 2)]);
        let usage = vec![sess(
            "s1",
            Some("proj"),
            "2026-07-10T12:00:00Z",
            "2026-07-10T14:00:00Z",
            80,
            0.8,
        )];
        let a = attr(vec![evidence("s1", &[], &[], &["2"])]);
        let out = compute(&a, &todos, &usage);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].number, 2);
        assert_eq!(out.tasks[0].interval_sessions, 1);
    }

    #[test]
    fn load_missing_or_malformed_is_none() {
        assert!(load(Path::new("does-not-exist-attr-98765.json")).is_none());
        let path = std::env::temp_dir().join("cut_attr_bad.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_parses_the_cli_shape() {
        let path = std::env::temp_dir().join("cut_attr_full.json");
        let raw = r#"{
            "version": 2, "kind": "task.attribution",
            "generated_at": "2026-07-16T10:00:00Z", "scope": "all",
            "sessions": [
                {"session": "s1", "project": "p", "project_dir": "D--p",
                 "modified_at": "2026-07-16T10:00:00Z",
                 "moves": [{"ref": "42", "statuses": ["in_progress","done"],
                            "first_ts": "2026-07-16T09:00:00Z", "last_ts": "2026-07-16T09:30:00Z"}],
                 "touched": ["43"], "mentions": ["44"]},
                {"session": "s2", "moves": []}
            ]
        }"#;
        std::fs::write(&path, raw).unwrap();
        let a = load(&path).expect("should parse");
        assert_eq!(a.sessions.len(), 2);
        assert_eq!(a.sessions[0].moves[0].task_ref, "42");
        assert_eq!(a.sessions[0].touched, vec!["43"]);
        assert_eq!(a.sessions[0].mentions, vec!["44"]);
        // A v1-shaped record (no touched/mentions) still loads with defaults.
        assert!(a.sessions[1].touched.is_empty() && a.sessions[1].mentions.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
