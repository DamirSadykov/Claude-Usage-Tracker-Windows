//! Journal side of task blocks (t#297): WHEN was a session bound to a task?
//!
//! `task-sessions.jsonl` (app data dir, sibling of todos.json) is an append-only
//! log owned by the Node CLI: `cli todos take` / `set-status` and the autonomous
//! runner (`run-step`) write an EXPLICIT binding, the SessionStart hook writes an
//! `auto` one. One JSON object per line:
//! `{"ts","session","task","event":"start"|"end","source","project"}`, where
//! `task` is a `Todo.id`. This module is load-only over it (same split as
//! task_cost.rs / corrections.rs) and turns the event stream into BLOCKS —
//! `(task, session, [from, to])` spans, the unit the board shows and the unit
//! stats/analytics sums.
//!
//! Block boundaries: a `start` opens a block; the next `start` or `end` OF THE
//! SAME SESSION closes it; the last open block of a session is closed by the
//! session's end (its last `cc_usage` ts, passed in — this module never touches
//! SQLite). Both ends are inclusive, so the closing message belongs to the block.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::stats::BlockTotals;
use crate::todos::TodoFile;

/// Sources that mean "the binding was STATED" — everything else (the
/// SessionStart hook's `auto`, an unknown/blank source from a future writer) is
/// a guess. `run-step` is the autonomous runner (t#305): it mints the step's
/// session id itself and binds it to the node it is executing, so its binding is
/// as stated as `take` is — the graph said so instead of a human.
const EXPLICIT_SOURCES: [&str; 3] = ["take", "set-status", "run-step"];

/// One line of the journal. Everything defaults so a partial/older line loads.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskSessionEvent {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub project: Option<String>,
}

impl TaskSessionEvent {
    pub fn is_explicit(&self) -> bool {
        EXPLICIT_SOURCES.contains(&self.source.as_str())
    }
}

/// One span of a session spent on one task.
#[derive(Debug, Clone, Serialize)]
pub struct TaskBlock {
    pub task: String,
    pub session: String,
    pub from: String,
    pub to: String,
    pub explicit: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// A block joined with the board (subject/number) and its sums from SQLite.
#[derive(Debug, Clone, Serialize)]
pub struct TaskBlockRow {
    pub task: String,
    pub number: u32,
    pub subject: String,
    pub session: String,
    pub from: String,
    pub to: String,
    pub explicit: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub cost: f64,
    pub total_tokens: i64,
    pub messages: i64,
    pub tool_calls: i64,
    pub tool_errors: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskBlocks {
    pub blocks: Vec<TaskBlockRow>,
    pub explicit_blocks: u32,
    pub auto_blocks: u32,
}

/// Forgiving read: a missing file is an empty journal, a malformed line is
/// skipped (the file is appended to concurrently — a torn last line is normal).
pub fn load(path: &Path) -> Vec<TaskSessionEvent> {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse(&raw),
        Err(_) => Vec::new(),
    }
}

pub fn parse(raw: &str) -> Vec<TaskSessionEvent> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TaskSessionEvent>(l).ok())
        .filter(|e| {
            !e.ts.is_empty()
                && !e.session.is_empty()
                && !e.task.is_empty()
                && (e.event == "start" || e.event == "end")
        })
        .collect()
}

/// Fold the event stream into blocks. An open block is closed by a `start` of
/// any task — a session works on one task at a time — or by an `end` of THAT
/// task; an `end` of another task leaves it open, because closing a second task
/// that was left in_progress says nothing about the work going on right now
/// (t#326: a 20-minute step was recorded as 67 seconds, and its tokens landed
/// on no task at all). `session_end` maps a session id to its last recorded
/// `cc_usage` ts; a session missing from it (no usage ingested yet) yields a
/// zero-length trailing block rather than an open-ended one. ISO-8601 UTC
/// timestamps compare lexicographically.
pub fn blocks(
    events: &[TaskSessionEvent],
    session_end: &HashMap<String, String>,
) -> Vec<TaskBlock> {
    let mut by_session: HashMap<&str, Vec<&TaskSessionEvent>> = HashMap::new();
    for e in events {
        by_session.entry(e.session.as_str()).or_default().push(e);
    }
    let mut out: Vec<TaskBlock> = Vec::new();
    for (session, mut evs) in by_session {
        evs.sort_by(|a, b| a.ts.cmp(&b.ts));
        let mut open: Option<TaskBlock> = None;
        for e in evs {
            if open
                .as_ref()
                .is_some_and(|b| e.event == "start" || e.task == b.task)
            {
                let mut b = open.take().expect("checked above");
                b.to = e.ts.clone();
                out.push(b);
            }
            if e.event == "start" {
                open = Some(TaskBlock {
                    task: e.task.clone(),
                    session: session.to_string(),
                    from: e.ts.clone(),
                    to: String::new(),
                    explicit: e.is_explicit(),
                    source: e.source.clone(),
                    project: e.project.clone(),
                });
            }
        }
        if let Some(mut b) = open.take() {
            let end = session_end.get(session).cloned().unwrap_or_default();
            b.to = if end.as_str() > b.from.as_str() {
                end
            } else {
                b.from.clone()
            };
            out.push(b);
        }
    }
    out.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.session.cmp(&b.session)));
    out
}

/// Distinct tasks (as `Todo.id`) a session is bound to, with whether ANY of its
/// blocks is an explicit binding. Used by task_cost.rs to decide attribution.
pub fn tasks_by_session(blocks: &[TaskBlock]) -> HashMap<&str, Vec<(&str, bool)>> {
    let mut out: HashMap<&str, Vec<(&str, bool)>> = HashMap::new();
    for b in blocks {
        let e = out.entry(b.session.as_str()).or_default();
        match e.iter_mut().find(|(t, _)| *t == b.task.as_str()) {
            Some(hit) => hit.1 |= b.explicit,
            None => e.push((b.task.as_str(), b.explicit)),
        }
    }
    out
}

/// Resolve a UI/CLI task ref (`<uuid>` | `N` | `#N` | `t#N`) to a `Todo.id`.
pub fn resolve_task_ref(todos: &TodoFile, task_ref: &str) -> Option<String> {
    let r = task_ref.trim();
    if let Some(t) = todos.todos.iter().find(|t| t.id == r) {
        return Some(t.id.clone());
    }
    let n: u32 = r.trim_start_matches("t#").trim_start_matches('#').parse().ok()?;
    todos.todos.iter().find(|t| t.number == n).map(|t| t.id.clone())
}

/// Join blocks with the board and their per-block sums (parallel to `blocks`;
/// a short `totals` leaves the tail at zero rather than panicking).
pub fn compose(blocks: &[TaskBlock], todos: &TodoFile, totals: &[BlockTotals]) -> TaskBlocks {
    let zero = BlockTotals::default();
    let mut explicit_blocks = 0;
    let mut auto_blocks = 0;
    let rows = blocks
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if b.explicit {
                explicit_blocks += 1;
            } else {
                auto_blocks += 1;
            }
            let t = totals.get(i).unwrap_or(&zero);
            let todo = todos.todos.iter().find(|t| t.id == b.task);
            TaskBlockRow {
                task: b.task.clone(),
                number: todo.map(|t| t.number).unwrap_or(0),
                subject: todo.map(|t| t.subject.clone()).unwrap_or_default(),
                session: b.session.clone(),
                from: b.from.clone(),
                to: b.to.clone(),
                explicit: b.explicit,
                source: b.source.clone(),
                project: b.project.clone(),
                cost: t.cost,
                total_tokens: t.total_tokens,
                messages: t.messages,
                tool_calls: t.tool_calls,
                tool_errors: t.tool_errors,
            }
        })
        .collect();
    TaskBlocks {
        blocks: rows,
        explicit_blocks,
        auto_blocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::todos::Todo;

    fn ev(ts: &str, session: &str, task: &str, event: &str, source: &str) -> TaskSessionEvent {
        TaskSessionEvent {
            ts: ts.to_string(),
            session: session.to_string(),
            task: task.to_string(),
            event: event.to_string(),
            source: source.to_string(),
            project: None,
        }
    }

    fn ends(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(s, e)| (s.to_string(), e.to_string()))
            .collect()
    }

    #[test]
    fn a_start_closes_the_previous_block() {
        let evs = vec![
            ev("T1", "s1", "a", "start", "take"),
            ev("T3", "s1", "b", "start", "take"),
        ];
        let out = blocks(&evs, &ends(&[("s1", "T9")]));
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].task.as_str(), out[0].from.as_str(), out[0].to.as_str()), ("a", "T1", "T3"));
        assert_eq!((out[1].task.as_str(), out[1].from.as_str(), out[1].to.as_str()), ("b", "T3", "T9"));
    }

    #[test]
    fn an_end_event_closes_without_opening() {
        let evs = vec![
            ev("T1", "s1", "a", "start", "take"),
            ev("T2", "s1", "a", "end", "set-status"),
            ev("T4", "s1", "a", "end", "set-status"),
        ];
        let out = blocks(&evs, &ends(&[("s1", "T9")]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].to, "T2");
    }

    #[test]
    fn an_end_of_another_task_leaves_the_block_open() {
        // Two tasks left in_progress at once: closing the older one says nothing
        // about the work happening now, and must not cut the live block short.
        let evs = vec![
            ev("T1", "s1", "a", "start", "take"),
            ev("T2", "s1", "b", "start", "take"),
            ev("T3", "s1", "a", "end", "set-status"),
            ev("T8", "s1", "b", "end", "set-status"),
        ];
        let out = blocks(&evs, &ends(&[("s1", "T9")]));
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].task.as_str(), out[0].to.as_str()), ("a", "T2"));
        assert_eq!((out[1].task.as_str(), out[1].to.as_str()), ("b", "T8"));
    }

    #[test]
    fn the_last_open_block_ends_with_the_session() {
        let evs = vec![ev("T1", "s1", "a", "start", "take")];
        let out = blocks(&evs, &ends(&[("s1", "T5")]));
        assert_eq!(out[0].to, "T5");
        // No usage for the session (or an end before the binding) → zero-length.
        let out = blocks(&evs, &ends(&[]));
        assert_eq!(out[0].to, "T1");
        let out = blocks(&evs, &ends(&[("s1", "T0")]));
        assert_eq!(out[0].to, "T1");
    }

    #[test]
    fn sessions_are_folded_independently() {
        // s2's start must not close s1's block.
        let evs = vec![
            ev("T1", "s1", "a", "start", "take"),
            ev("T2", "s2", "b", "start", "take"),
        ];
        let out = blocks(&evs, &ends(&[("s1", "T8"), ("s2", "T9")]));
        assert_eq!(out.len(), 2);
        let s1 = out.iter().find(|b| b.session == "s1").unwrap();
        assert_eq!(s1.to, "T8");
    }

    #[test]
    fn events_are_ordered_by_ts_not_by_file_order() {
        let evs = vec![
            ev("T3", "s1", "b", "start", "take"),
            ev("T1", "s1", "a", "start", "take"),
        ];
        let out = blocks(&evs, &ends(&[("s1", "T9")]));
        assert_eq!(out[0].task, "a");
        assert_eq!(out[0].to, "T3");
    }

    #[test]
    fn explicit_and_auto_are_distinguished() {
        let evs = vec![
            ev("T1", "s1", "a", "start", "auto"),
            ev("T2", "s1", "a", "start", "take"),
            ev("T3", "s2", "b", "start", "set-status"),
            ev("T4", "s3", "c", "start", ""),
        ];
        let out = blocks(&evs, &ends(&[]));
        let ex: Vec<bool> = out.iter().map(|b| b.explicit).collect();
        assert_eq!(ex, vec![false, true, true, false]);
    }

    #[test]
    fn the_runners_binding_is_explicit_and_keeps_its_own_name() {
        // t#312: the runner used to write "take" because that was the only way
        // to be counted explicit, which made its blocks indistinguishable from a
        // human's. Both halves are asserted — counted explicit, still named.
        let out = blocks(
            &[
                ev("T1", "s1", "a", "start", "run-step"),
                ev("T2", "s2", "b", "start", "run-steps"),
            ],
            &ends(&[]),
        );
        assert_eq!((out[0].explicit, out[0].source.as_str()), (true, "run-step"));
        // A near-miss is NOT waved through: the allowlist is exact.
        assert!(!out[1].explicit);
    }

    #[test]
    fn empty_and_broken_journals_yield_nothing() {
        assert!(load(Path::new("does-not-exist-task-sessions-98765.jsonl")).is_empty());
        let path = std::env::temp_dir().join("cut_task_sessions_bad.jsonl");
        std::fs::write(&path, b"").unwrap();
        assert!(load(&path).is_empty());
        std::fs::write(&path, b"{ not json\n\n[]\n{\"ts\":\"T1\"}\n").unwrap();
        assert!(load(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_broken_line_does_not_lose_the_good_ones() {
        let path = std::env::temp_dir().join("cut_task_sessions_mixed.jsonl");
        std::fs::write(
            &path,
            b"{\"ts\":\"T1\",\"session\":\"s1\",\"task\":\"a\",\"event\":\"start\",\"source\":\"take\",\"project\":\"p\"}\n\
              { torn line\n\
              {\"ts\":\"T2\",\"session\":\"s1\",\"task\":\"a\",\"event\":\"end\",\"source\":\"set-status\"}\n",
        )
        .unwrap();
        let evs = load(&path);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].project.as_deref(), Some("p"));
        let out = blocks(&evs, &ends(&[]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].to, "T2");
        let _ = std::fs::remove_file(&path);
    }

    fn todo(id: &str, number: u32) -> Todo {
        Todo {
            id: id.to_string(),
            number,
            subject: format!("task {number}"),
            status: "in_progress".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn refs_resolve_by_id_and_by_number() {
        let board = TodoFile {
            version: 1,
            todos: vec![todo("u-a", 7)],
        };
        for r in ["u-a", "7", "#7", "t#7"] {
            assert_eq!(resolve_task_ref(&board, r).as_deref(), Some("u-a"));
        }
        assert!(resolve_task_ref(&board, "8").is_none());
        assert!(resolve_task_ref(&board, "nope").is_none());
    }

    #[test]
    fn compose_joins_board_and_totals() {
        let board = TodoFile {
            version: 1,
            todos: vec![todo("u-a", 7)],
        };
        let evs = vec![
            ev("T1", "s1", "u-a", "start", "take"),
            ev("T2", "s1", "gone", "start", "auto"),
        ];
        let bl = blocks(&evs, &ends(&[("s1", "T9")]));
        let totals = vec![
            BlockTotals {
                cost: 1.5,
                total_tokens: 100,
                messages: 3,
                tool_calls: 9,
                tool_errors: 2,
            },
            BlockTotals::default(),
        ];
        let out = compose(&bl, &board, &totals);
        assert_eq!(out.explicit_blocks, 1);
        assert_eq!(out.auto_blocks, 1);
        assert_eq!(out.blocks[0].number, 7);
        assert_eq!(out.blocks[0].subject, "task 7");
        assert_eq!(out.blocks[0].tool_calls, 9);
        assert_eq!(out.blocks[0].tool_errors, 2);
        // A block whose task is no longer on the board still reports its span.
        assert_eq!(out.blocks[1].number, 0);
        assert_eq!(out.blocks[1].subject, "");
    }

    #[test]
    fn compose_survives_a_short_totals_vec() {
        let board = TodoFile { version: 1, todos: vec![todo("u-a", 7)] };
        let bl = blocks(&[ev("T1", "s1", "u-a", "start", "take")], &ends(&[]));
        let out = compose(&bl, &board, &[]);
        assert_eq!(out.blocks.len(), 1);
        assert_eq!(out.blocks[0].cost, 0.0);
    }
}
