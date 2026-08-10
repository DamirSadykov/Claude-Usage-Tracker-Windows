//! Run graph of a change (t#306): the board's dependency edges plus the block
//! ledger, as a model and as a picture.
//!
//! The board (todos.rs) says WHAT was planned and in what order; the binding
//! journal folded into blocks (task_sessions.rs) plus their sums from SQLite
//! (stats::BlockTotals / the per-agent split of t#300) say what the run actually
//! COST. This module joins the two into one node-per-task model and renders it —
//! Mermaid is the canonical format, D2 an extra.
//!
//! Two honesty rules drive the whole design, both learned from real boards:
//!
//!   * a task whose `status_history` never passed through `in_progress` has NO
//!     recoverable block — neither from the journal nor from the history — so its
//!     cost is UNKNOWN, not zero (see [`Measurability`]). Changes are the common
//!     case, not the exotic one: a change root is closed last, after its children,
//!     and typically goes `backlog → done` without ever being worked itself;
//!   * a block can also exist and measure NOTHING: two parallel agents in one
//!     session make the second `start` close the first block within a fraction of
//!     a second, and the work lands in the neighbouring block (t#296 — a 0.185s
//!     block whose real ~$1.95 sits under t#297). Zero messages inside a block is
//!     therefore a failure to measure, reported as unknown, while a block that
//!     HAS messages and rounds to `$0.00` is an honest zero and stays measured;
//!   * a task whose blocks exist but sum to LESS than the task's whole attributed
//!     cost keeps the difference visible (`unattributed_cost`) — work between
//!     blocks and sessions older than the journal are a real quantity, not noise
//!     to be rounded away.
//!
//! A change root's duration is a CALENDAR span (it stays open while its children
//! are worked), so it is never printed in the same shape as a step's working
//! duration — see `duration_calendar`.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::stats::BlockTotals;
use crate::task_sessions::{self, TaskBlock};
use crate::todos::{Todo, TodoFile};

/// A difference below half a cent is rounding, not unattributed work.
const COST_EPSILON: f64 = 0.005;

/// Subject text is trimmed to this many characters in a rendered label; the
/// model always carries the full subject.
const SUBJECT_LIMIT: usize = 96;

/// Why a node's numbers are (not) there.
///
/// `Measured` — at least one block of the binding journal covers the task AND it
/// holds messages, so the sums are real. `NoInProgress` — the task never entered
/// `in_progress`, so no block can ever be recovered for it: the picture must say
/// "неизвестно", never `$0.00`. `NoBlocks` — it WAS worked, but the journal holds
/// no block for it (a session older than the journal, a binding never written).
/// `EmptyBlocks` — blocks exist but are DEGENERATE: they add up to zero messages,
/// which happens when a second `start` closed the first block within a fraction of
/// a second (parallel agents on two tasks in one session, verified on t#296: a
/// 0.185s block while its real ~$1.95 / 20 messages sit in the neighbouring one).
/// A degenerate block is a failure to measure, not a free step, so it reports
/// nothing — while a block that holds messages and rounds to `$0.00` is an HONEST
/// zero and stays `Measured`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Measurability {
    Measured,
    NoInProgress,
    NoBlocks,
    EmptyBlocks,
}

impl Measurability {
    pub fn is_measured(self) -> bool {
        matches!(self, Measurability::Measured)
    }

    fn reason(self) -> &'static str {
        match self {
            Measurability::Measured => "",
            Measurability::NoInProgress => "не был in_progress",
            Measurability::NoBlocks => "нет блоков в журнале",
            Measurability::EmptyBlocks => "блок вырожден, работа ушла в соседний блок",
        }
    }
}

/// A block sum that holds no messages at all: nothing was billed inside the span,
/// so the span measured nothing. Cost is checked too, but only as a belt — the
/// sums come from the same `cc_usage` rows the message count does.
fn is_degenerate(sums: &BlockTotals) -> bool {
    sums.messages == 0 && sums.cost.abs() < COST_EPSILON
}

/// One executor's share of a node: the main loop (`agent_id = None`) or one
/// subagent instance, summed over every block of the task. Mirrors
/// `stats::BlockAgent`, which is what the caller feeds in per block.
#[derive(Debug, Clone, Serialize)]
pub struct GraphAgent {
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub cost: f64,
    pub total_tokens: i64,
    pub messages: i64,
}

/// One task of the run. Money/token/tool fields are `None` exactly when
/// `measurability` is not `Measured` — a node with no recoverable block reports
/// nothing rather than reporting zeros.
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub number: u32,
    pub subject: String,
    pub status: String,
    /// `auto` | `manual`; an empty/unknown `kind` on the board reads as `manual`.
    pub kind: String,
    /// `kind == manual` — a human gate, drawn differently from an auto node.
    pub gate: bool,
    pub change: bool,
    /// Machine predicate of the node's outcome (t#304): `ok` | `issue`, empty = no
    /// check ran. A SEPARATE axis from [`Measurability`], which answers a different
    /// question: measurability says whether the node's numbers are recoverable, the
    /// predicate says whether its work passed verification. A fully measured node
    /// can be `issue`, an unmeasurable one can be `ok`, and neither implies the
    /// other — so the picture must never fold them into one mark.
    pub outcome: String,
    /// Short machine reason behind `outcome` (`verify:issue`, `missing:<path>`),
    /// carried verbatim from the board.
    pub outcome_reason: String,
    /// First `in_progress` → last `done`/`review` of the transition log, minutes.
    pub duration_minutes: Option<i64>,
    /// True for a change root: its span is CALENDAR time (it stays open while the
    /// children are worked), so it must not be read as time spent on the task.
    pub duration_calendar: bool,
    pub measurability: Measurability,
    pub blocks: u32,
    pub cost: Option<f64>,
    pub total_tokens: Option<i64>,
    pub messages: Option<i64>,
    pub tool_calls: Option<i64>,
    pub tool_errors: Option<i64>,
    /// What the whole task cost per the session-level attribution (task_cost.rs),
    /// when known — the yardstick the block sum is compared against.
    pub task_cost: Option<f64>,
    /// `task_cost` minus the block sum, when the blocks account for less.
    pub unattributed_cost: Option<f64>,
    pub agents: Vec<GraphAgent>,
}

/// A `depends_on` edge, drawn from the prerequisite TO the dependent task, i.e.
/// in the direction the work flows (`a.depends_on = [b]` renders `b -> a`).
#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    /// A member → change-root edge. Kept in the model (it is a real edge) but not
    /// drawn: the group frame already says the node belongs to the change.
    pub membership: bool,
}

/// A change rendered as a frame: the root plus its direct `depends_on` children.
#[derive(Debug, Clone, Serialize)]
pub struct GraphGroup {
    pub id: String,
    pub number: u32,
    pub subject: String,
    pub members: Vec<String>,
}

/// The whole answer: the model (for the UI) and the rendered text (for a paste).
/// An unresolvable change yields an empty graph, never an error.
#[derive(Debug, Clone, Serialize)]
pub struct TaskGraph {
    pub change: Option<String>,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub groups: Vec<GraphGroup>,
    pub format: String,
    pub text: String,
}

/// Task ids of a change's run: the root plus everything it reaches through
/// `depends_on`, ordered by task number. An unresolvable ref yields nothing.
pub fn subtree(board: &TodoFile, change_ref: &str) -> Vec<String> {
    let Some(root) = task_sessions::resolve_task_ref(board, change_ref) else {
        return Vec::new();
    };
    let by_id: HashMap<&str, &Todo> = board.todos.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(t) = by_id.get(id.as_str()) {
            for d in &t.depends_on {
                if !seen.contains(d) {
                    stack.push(d.clone());
                }
            }
        }
    }
    let mut ids: Vec<String> = seen.into_iter().filter(|id| by_id.contains_key(id.as_str())).collect();
    ids.sort_by_key(|id| {
        let t = by_id[id.as_str()];
        (t.number, t.id.clone())
    });
    ids
}

/// `auto` for a node a runner may close on its own, `manual` (the default, and
/// what an empty `kind` means) for a human gate.
fn canonical_kind(t: &Todo) -> &'static str {
    if t.kind == "auto" {
        "auto"
    } else {
        "manual"
    }
}

fn parse_ts(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s).ok()
}

/// Minutes from the FIRST `in_progress` to the LAST `done`/`review` of the
/// transition log. None when either end is missing or the log runs backwards.
fn duration_minutes(t: &Todo) -> Option<i64> {
    let start = t
        .status_history
        .iter()
        .find(|e| e.status == "in_progress" && !e.at.is_empty())
        .and_then(|e| parse_ts(&e.at))?;
    let end = t
        .status_history
        .iter()
        .rev()
        .find(|e| (e.status == "done" || e.status == "review") && !e.at.is_empty())
        .and_then(|e| parse_ts(&e.at))?;
    let minutes = (end - start).num_minutes();
    (minutes >= 0).then_some(minutes)
}

fn was_in_progress(t: &Todo) -> bool {
    t.status_history.iter().any(|e| e.status == "in_progress")
}

/// True if `from` reaches `target` by following `depends_on` inside `ids`.
fn reaches(by_id: &HashMap<&str, &Todo>, ids: &HashSet<&str>, from: &str, target: &str) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack = vec![from];
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(t) = by_id.get(id) {
            for d in &t.depends_on {
                if d == target {
                    return true;
                }
                if ids.contains(d.as_str()) {
                    stack.push(d.as_str());
                }
            }
        }
    }
    false
}

/// Build the model. `blocks`, `totals` and `agents` are parallel (the shape
/// `get_task_blocks` already produces); a short `totals`/`agents` leaves the tail
/// at zero rather than panicking. `task_costs` maps a task id to what the whole
/// task cost per the session-level attribution (task_cost.rs) — the yardstick for
/// `unattributed_cost`; an id missing from it simply has no yardstick.
pub fn build(
    board: &TodoFile,
    change_ref: &str,
    blocks: &[TaskBlock],
    totals: &[BlockTotals],
    agents: &[Vec<GraphAgent>],
    task_costs: &HashMap<String, f64>,
) -> TaskGraph {
    let change = task_sessions::resolve_task_ref(board, change_ref);
    let ids = subtree(board, change_ref);
    let id_set: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let by_id: HashMap<&str, &Todo> = board.todos.iter().map(|t| (t.id.as_str(), t)).collect();

    #[derive(Default)]
    struct Acc {
        blocks: u32,
        sums: BlockTotals,
        agents: Vec<GraphAgent>,
    }
    let mut per_task: HashMap<&str, Acc> = HashMap::new();
    let zero = BlockTotals::default();
    for (i, b) in blocks.iter().enumerate() {
        let Some(&task) = id_set.get(b.task.as_str()) else {
            continue;
        };
        let acc = per_task.entry(task).or_default();
        let t = totals.get(i).unwrap_or(&zero);
        acc.blocks += 1;
        acc.sums.cost += t.cost;
        acc.sums.total_tokens += t.total_tokens;
        acc.sums.messages += t.messages;
        acc.sums.tool_calls += t.tool_calls;
        acc.sums.tool_errors += t.tool_errors;
        for a in agents.get(i).map(Vec::as_slice).unwrap_or(&[]) {
            match acc.agents.iter_mut().find(|x| x.agent_id == a.agent_id) {
                Some(hit) => {
                    hit.cost += a.cost;
                    hit.total_tokens += a.total_tokens;
                    hit.messages += a.messages;
                    if hit.agent_type.is_none() {
                        hit.agent_type = a.agent_type.clone();
                    }
                    if hit.description.is_none() {
                        hit.description = a.description.clone();
                    }
                }
                None => acc.agents.push(a.clone()),
            }
        }
    }

    let nodes: Vec<GraphNode> = ids
        .iter()
        .filter_map(|id| by_id.get(id.as_str()).map(|t| (id, *t)))
        .map(|(id, t)| {
            let acc = per_task.remove(id.as_str());
            let measurability = match &acc {
                Some(a) if a.blocks > 0 && !is_degenerate(&a.sums) => Measurability::Measured,
                Some(a) if a.blocks > 0 => Measurability::EmptyBlocks,
                _ if was_in_progress(t) => Measurability::NoBlocks,
                _ => Measurability::NoInProgress,
            };
            let measured = measurability.is_measured();
            let sums = acc.as_ref().map(|a| a.sums.clone()).unwrap_or_default();
            let block_count = acc.as_ref().map(|a| a.blocks).unwrap_or(0);
            let task_cost = task_costs.get(id.as_str()).copied();
            let unattributed = match (measured, task_cost) {
                (true, Some(whole)) if whole - sums.cost > COST_EPSILON => Some(whole - sums.cost),
                _ => None,
            };
            let mut agents = acc.map(|a| a.agents).unwrap_or_default();
            agents.sort_by(|a, b| {
                b.cost
                    .partial_cmp(&a.cost)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.agent_id.cmp(&b.agent_id))
            });
            let kind = canonical_kind(t);
            GraphNode {
                id: t.id.clone(),
                number: t.number,
                subject: t.subject.clone(),
                status: t.status.clone(),
                kind: kind.to_string(),
                gate: kind == "manual",
                change: t.change,
                outcome: t.outcome.clone(),
                outcome_reason: t.outcome_reason.clone(),
                duration_minutes: duration_minutes(t),
                duration_calendar: t.change,
                measurability,
                blocks: block_count,
                cost: measured.then_some(sums.cost),
                total_tokens: measured.then_some(sums.total_tokens),
                messages: measured.then_some(sums.messages),
                tool_calls: measured.then_some(sums.tool_calls),
                tool_errors: measured.then_some(sums.tool_errors),
                task_cost,
                unattributed_cost: unattributed,
                agents,
            }
        })
        .collect();

    let mut groups: Vec<GraphGroup> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();
    let change_roots: Vec<&str> = nodes
        .iter()
        .filter(|n| n.change)
        .map(|n| n.id.as_str())
        .filter(|id| {
            // Only the OUTERMOST change gets a frame; a nested change stays a node.
            !nodes
                .iter()
                .filter(|o| o.change && o.id != *id)
                .any(|o| reaches(&by_id, &id_set, o.id.as_str(), id))
        })
        .collect();
    let node_order: HashMap<&str, usize> =
        ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    for root in change_roots {
        let Some(t) = by_id.get(root) else { continue };
        let mut members: Vec<String> = t
            .depends_on
            .iter()
            .filter(|d| id_set.contains(d.as_str()) && !claimed.contains(d.as_str()))
            .cloned()
            .collect();
        members.sort_by_key(|m| node_order.get(m.as_str()).copied().unwrap_or(usize::MAX));
        for m in &members {
            claimed.insert(m.clone());
        }
        groups.push(GraphGroup {
            id: t.id.clone(),
            number: t.number,
            subject: t.subject.clone(),
            members,
        });
    }
    groups.sort_by_key(|g| (g.number, g.id.clone()));

    let member_of: HashMap<&str, &str> = groups
        .iter()
        .flat_map(|g| g.members.iter().map(move |m| (m.as_str(), g.id.as_str())))
        .collect();

    let mut edges: Vec<GraphEdge> = Vec::new();
    for id in &ids {
        let Some(t) = by_id.get(id.as_str()) else { continue };
        for dep in &t.depends_on {
            if !id_set.contains(dep.as_str()) {
                continue;
            }
            edges.push(GraphEdge {
                from: dep.clone(),
                to: id.clone(),
                membership: member_of.get(dep.as_str()) == Some(&id.as_str()),
            });
        }
    }
    edges.sort_by_key(|e| {
        (
            node_order.get(e.from.as_str()).copied().unwrap_or(usize::MAX),
            node_order.get(e.to.as_str()).copied().unwrap_or(usize::MAX),
        )
    });

    TaskGraph {
        change,
        nodes,
        edges,
        groups,
        format: String::new(),
        text: String::new(),
    }
}

/// Render the model into `format` (`mermaid` — the canonical one — or `d2`),
/// filling `format` and `text`. An unknown format falls back to Mermaid and says
/// so in `format`, so the caller always knows what it got.
pub fn render(graph: &mut TaskGraph, format: &str) {
    if format.trim().eq_ignore_ascii_case("d2") {
        graph.format = "d2".to_string();
        graph.text = to_d2(graph);
    } else {
        graph.format = "mermaid".to_string();
        graph.text = to_mermaid(graph);
    }
}

fn trim_subject(s: &str) -> String {
    if s.chars().count() <= SUBJECT_LIMIT {
        return s.to_string();
    }
    let head: String = s.chars().take(SUBJECT_LIMIT - 1).collect();
    format!("{}…", head.trim_end())
}

fn plural(n: i64, one: &str, few: &str, many: &str) -> String {
    let last = n.abs() % 10;
    let two = n.abs() % 100;
    let word = if last == 1 && two != 11 {
        one
    } else if (2..=4).contains(&last) && !(12..=14).contains(&two) {
        few
    } else {
        many
    };
    format!("{n} {word}")
}

fn fmt_tokens(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{}k", n / 1_000)
    } else {
        n.to_string()
    }
}

fn fmt_duration(minutes: i64) -> String {
    if minutes < 60 {
        format!("{minutes}м")
    } else if minutes < 1440 {
        format!("{}ч {:02}м", minutes / 60, minutes % 60)
    } else {
        format!("{}д {}ч", minutes / 1440, (minutes % 1440) / 60)
    }
}

/// The outcome mark of a node (t#304), or None when NO check ran — an unchecked
/// node gets no mark at all, because a silent tick would pass "nobody looked" for
/// "passed". Only the two machine predicates get a symbol; any other stored value
/// is printed as-is without one, so an unknown verdict can't be read as a verdict.
fn outcome_mark(n: &GraphNode) -> Option<String> {
    let reason = n.outcome_reason.trim();
    let with = |head: &str| {
        if reason.is_empty() || reason == "ok" {
            head.to_string()
        } else {
            format!("{head} · {reason}")
        }
    };
    match n.outcome.trim() {
        "" => None,
        "ok" => Some(with("✓ сверка")),
        "issue" => Some(with("✗ сверка")),
        other => Some(with(&format!("сверка: {other}"))),
    }
}

/// The raw (unescaped) lines of a node's label — one model, both renderers.
fn label_lines(n: &GraphNode) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(if n.number > 0 {
        format!("#{} {}", n.number, trim_subject(&n.subject))
    } else {
        trim_subject(&n.subject)
    });

    let mut state = n.status.clone();
    if let Some(m) = n.duration_minutes {
        if n.duration_calendar {
            state.push_str(&format!(" · размах {} (календарный)", fmt_duration(m)));
        } else {
            state.push_str(&format!(" · {}", fmt_duration(m)));
        }
    }
    lines.push(state);

    match (n.cost, n.total_tokens) {
        (Some(cost), Some(tokens)) => {
            lines.push(format!(
                "${cost:.2} · {} · {}",
                fmt_tokens(tokens),
                plural(n.blocks as i64, "блок", "блока", "блоков")
            ));
            lines.push(format!(
                "{} · {} · {}",
                plural(n.messages.unwrap_or(0), "сообщение", "сообщения", "сообщений"),
                plural(n.tool_calls.unwrap_or(0), "вызов", "вызова", "вызовов"),
                plural(n.tool_errors.unwrap_or(0), "ошибка", "ошибки", "ошибок")
            ));
        }
        _ => {
            lines.push(format!("стоимость неизвестна: {}", n.measurability.reason()));
            if let Some(whole) = n.task_cost {
                lines.push(format!("по задаче целиком ${whole:.2}"));
            }
        }
    }
    if let Some(extra) = n.unattributed_cost {
        lines.push(format!("вне блоков ещё ${extra:.2}"));
    }
    let subagents = n.agents.iter().filter(|a| a.agent_id.is_some()).count() as i64;
    if subagents > 0 {
        lines.push(plural(subagents, "субагент", "субагента", "субагентов"));
    }
    if let Some(mark) = outcome_mark(n) {
        lines.push(mark);
    }
    lines.push(if n.gate { "гейт".to_string() } else { "⚡ авто".to_string() });
    lines
}

fn sanitize_key(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn node_key(n: &GraphNode) -> String {
    if n.number > 0 {
        format!("t{}", n.number)
    } else {
        format!("n{}", sanitize_key(&n.id))
    }
}

/// The frame's caption. Deliberately just the number: the change root sits INSIDE
/// its own frame as a node, and repeating its subject on the frame reads as the
/// same task printed twice.
fn group_title(g: &GraphGroup) -> String {
    if g.number > 0 {
        format!("change #{}", g.number)
    } else {
        format!("change {}", trim_subject(&g.subject))
    }
}

fn group_key(g: &GraphGroup) -> String {
    if g.number > 0 {
        format!("g{}", g.number)
    } else {
        format!("g_{}", sanitize_key(&g.id))
    }
}

/// Everything that can end a Mermaid statement or a label is replaced by its
/// numeric entity code — task subjects carry arrows, brackets and quotes, and any
/// one of them silently breaks the diagram.
fn escape_mermaid(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '#' => out.push_str("#35;"),
            '"' => out.push_str("#34;"),
            '&' => out.push_str("#38;"),
            '\'' => out.push_str("#39;"),
            '(' => out.push_str("#40;"),
            ')' => out.push_str("#41;"),
            ';' => out.push_str("#59;"),
            '<' => out.push_str("#60;"),
            '>' => out.push_str("#62;"),
            '[' => out.push_str("#91;"),
            '\\' => out.push_str("#92;"),
            ']' => out.push_str("#93;"),
            '{' => out.push_str("#123;"),
            '|' => out.push_str("#124;"),
            '}' => out.push_str("#125;"),
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

fn mermaid_label(n: &GraphNode) -> String {
    label_lines(n)
        .iter()
        .map(|l| escape_mermaid(l))
        .collect::<Vec<_>>()
        .join("<br/>")
}

fn mermaid_node(n: &GraphNode, indent: &str) -> String {
    let key = node_key(n);
    let label = mermaid_label(n);
    if n.gate {
        format!("{indent}{key}{{{{\"{label}\"}}}}\n")
    } else {
        format!("{indent}{key}[\"{label}\"]\n")
    }
}

/// Mermaid `flowchart TD`: a subgraph per change, a hexagon for a manual gate and
/// a box for an auto node, plus a class marking the nodes whose cost is unknown
/// and another marking the nodes whose check came back `issue`.
pub fn to_mermaid(graph: &TaskGraph) -> String {
    let mut out = String::from("flowchart TD\n");
    out.push_str("  classDef gate fill:#fdf6e3,stroke:#b58900,stroke-width:2px\n");
    out.push_str("  classDef auto fill:#eef6ff,stroke:#4a90d9\n");
    out.push_str("  classDef unknown stroke-dasharray:5 4\n");
    out.push_str("  classDef issue stroke:#dc322f,stroke-width:2px\n");

    let by_id: HashMap<&str, &GraphNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut placed: HashSet<&str> = HashSet::new();
    for g in &graph.groups {
        out.push_str(&format!(
            "  subgraph {}[\"{}\"]\n",
            group_key(g),
            escape_mermaid(&group_title(g))
        ));
        for id in std::iter::once(&g.id).chain(g.members.iter()) {
            if let Some(n) = by_id.get(id.as_str()) {
                if placed.insert(n.id.as_str()) {
                    out.push_str(&mermaid_node(n, "    "));
                }
            }
        }
        out.push_str("  end\n");
    }
    for n in &graph.nodes {
        if placed.insert(n.id.as_str()) {
            out.push_str(&mermaid_node(n, "  "));
        }
    }
    for e in &graph.edges {
        if e.membership {
            continue;
        }
        let (Some(from), Some(to)) = (by_id.get(e.from.as_str()), by_id.get(e.to.as_str())) else {
            continue;
        };
        out.push_str(&format!("  {} --> {}\n", node_key(from), node_key(to)));
    }
    for n in &graph.nodes {
        out.push_str(&format!(
            "  class {} {}\n",
            node_key(n),
            if n.gate { "gate" } else { "auto" }
        ));
        if !n.measurability.is_measured() {
            out.push_str(&format!("  class {} unknown\n", node_key(n)));
        }
        // Applied last so the failed check wins over the shape's own stroke; only a
        // real `issue` is painted — an unchecked node keeps the neutral look.
        if n.outcome.trim() == "issue" {
            out.push_str(&format!("  class {} issue\n", node_key(n)));
        }
    }
    out
}

fn escape_d2(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

fn d2_label(n: &GraphNode) -> String {
    label_lines(n)
        .iter()
        .map(|l| escape_d2(l))
        .collect::<Vec<_>>()
        .join("\\n")
}

fn d2_node(n: &GraphNode, indent: &str) -> String {
    let key = node_key(n);
    let mut out = format!("{indent}{key}: \"{}\" {{\n", d2_label(n));
    out.push_str(&format!(
        "{indent}  shape: {}\n",
        if n.gate { "hexagon" } else { "rectangle" }
    ));
    if !n.measurability.is_measured() {
        out.push_str(&format!("{indent}  style.stroke-dash: 3\n"));
    }
    if n.outcome.trim() == "issue" {
        out.push_str(&format!("{indent}  style.stroke: \"#dc322f\"\n"));
    }
    out.push_str(&format!("{indent}}}\n"));
    out
}

/// D2 rendering of the same model: a container per change (Mermaid's subgraph),
/// hexagon vs rectangle for gate vs auto, dashed border for an unknown cost and a
/// red one for a failed check.
pub fn to_d2(graph: &TaskGraph) -> String {
    let mut out = String::from("direction: down\n");
    let by_id: HashMap<&str, &GraphNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut path: HashMap<&str, String> = HashMap::new();
    let mut placed: HashSet<&str> = HashSet::new();

    for g in &graph.groups {
        let key = group_key(g);
        out.push_str(&format!("{key}: \"{}\" {{\n", escape_d2(&group_title(g))));
        for id in std::iter::once(&g.id).chain(g.members.iter()) {
            if let Some(n) = by_id.get(id.as_str()) {
                if placed.insert(n.id.as_str()) {
                    out.push_str(&d2_node(n, "  "));
                    path.insert(n.id.as_str(), format!("{key}.{}", node_key(n)));
                }
            }
        }
        out.push_str("}\n");
    }
    for n in &graph.nodes {
        if placed.insert(n.id.as_str()) {
            out.push_str(&d2_node(n, ""));
            path.insert(n.id.as_str(), node_key(n));
        }
    }
    for e in &graph.edges {
        if e.membership {
            continue;
        }
        let (Some(from), Some(to)) = (path.get(e.from.as_str()), path.get(e.to.as_str())) else {
            continue;
        };
        out.push_str(&format!("{from} -> {to}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::todos::StatusChange;

    fn todo(id: &str, number: u32, subject: &str) -> Todo {
        Todo {
            id: id.to_string(),
            number,
            subject: subject.to_string(),
            status: "done".to_string(),
            ..Default::default()
        }
    }

    fn history(statuses: &[(&str, &str)]) -> Vec<StatusChange> {
        statuses
            .iter()
            .map(|(s, at)| StatusChange {
                status: s.to_string(),
                at: at.to_string(),
            })
            .collect()
    }

    fn board(todos: Vec<Todo>) -> TodoFile {
        TodoFile { version: 2, todos }
    }

    fn block(task: &str) -> TaskBlock {
        TaskBlock {
            task: task.to_string(),
            session: "s1".to_string(),
            from: "2026-07-20T10:00:00Z".to_string(),
            to: "2026-07-20T11:00:00Z".to_string(),
            explicit: true,
            source: "take".to_string(),
            project: None,
        }
    }

    fn totals(cost: f64) -> BlockTotals {
        BlockTotals {
            cost,
            total_tokens: 120_000,
            messages: 20,
            tool_calls: 42,
            tool_errors: 1,
        }
    }

    fn no_costs() -> HashMap<String, f64> {
        HashMap::new()
    }

    /// The change of t#273: a root, one auto step with a block, one gate step whose
    /// history never passed through `in_progress`.
    fn sample() -> TodoFile {
        let mut root = todo("root", 273, "Тема прогона");
        root.change = true;
        root.depends_on = vec!["a".to_string(), "b".to_string()];
        root.status_history = history(&[
            ("in_progress", "2026-07-20T09:00:00Z"),
            ("done", "2026-07-22T03:20:00Z"),
        ]);
        let mut a = todo("a", 275, "Шаг с блоком");
        a.kind = "auto".to_string();
        a.status_history = history(&[
            ("in_progress", "2026-07-20T10:00:00Z"),
            ("done", "2026-07-20T10:30:00Z"),
        ]);
        let mut b = todo("b", 274, "Шаг без in_progress");
        b.depends_on = vec!["a".to_string()];
        b.status_history = history(&[("review", "2026-07-21T10:00:00Z"), ("done", "2026-07-21T11:00:00Z")]);
        board(vec![root, a, b])
    }

    fn built(board: &TodoFile) -> TaskGraph {
        build(
            board,
            "273",
            &[block("a")],
            &[totals(1.25)],
            &[vec![]],
            &no_costs(),
        )
    }

    fn node<'a>(g: &'a TaskGraph, number: u32) -> &'a GraphNode {
        g.nodes.iter().find(|n| n.number == number).unwrap()
    }

    #[test]
    fn a_node_that_never_went_in_progress_is_unknown_not_zero() {
        let g = built(&sample());
        let b = node(&g, 274);
        assert_eq!(b.measurability, Measurability::NoInProgress);
        assert!(b.cost.is_none() && b.total_tokens.is_none() && b.messages.is_none());
        let label = mermaid_label(b);
        assert!(label.contains("стоимость неизвестна"));
        assert!(label.contains("не был in_progress"));
        assert!(!label.contains("$0.00"));
        // The measured neighbour still shows real money.
        assert_eq!(node(&g, 275).cost, Some(1.25));
        assert!(mermaid_label(node(&g, 275)).contains("$1.25"));
    }

    #[test]
    fn a_task_worked_but_missing_from_the_journal_is_unknown_for_its_own_reason() {
        let mut board = sample();
        // #274 was worked, but no block exists for it (session older than the journal).
        board.todos[2].status_history = history(&[
            ("in_progress", "2026-07-21T09:00:00Z"),
            ("done", "2026-07-21T11:00:00Z"),
        ]);
        let g = built(&board);
        let b = node(&g, 274);
        assert_eq!(b.measurability, Measurability::NoBlocks);
        assert!(b.cost.is_none());
        assert!(mermaid_label(b).contains("нет блоков в журнале"));
    }

    /// The норма for changes: a root closed after its children, `backlog → done`,
    /// never `in_progress` — t#294 / t#283. A group must be as honest as a step.
    #[test]
    fn an_unworked_change_root_is_unknown_too() {
        let mut board = sample();
        board.todos[0].status_history =
            history(&[("backlog", "2026-07-20T09:00:00Z"), ("done", "2026-07-22T03:20:00Z")]);
        let g = built(&board);
        let root = node(&g, 273);
        assert_eq!(root.measurability, Measurability::NoInProgress);
        assert!(root.cost.is_none());
        assert!(root.duration_minutes.is_none());
        let text = to_mermaid(&g);
        assert!(text.contains("стоимость неизвестна"));
        assert!(!text.contains("$0.00"));
        // and it is still the frame of the group
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].id, "root");
    }

    #[test]
    fn a_change_duration_is_marked_as_a_calendar_span() {
        let g = built(&sample());
        let root = node(&g, 273);
        assert!(root.duration_calendar);
        assert_eq!(root.duration_minutes, Some(2540));
        assert!(mermaid_label(root).contains("размах"));
        assert!(mermaid_label(root).contains("календарный"));
        // A step's duration is plain working time — no calendar wording.
        let step = node(&g, 275);
        assert!(!step.duration_calendar);
        assert_eq!(step.duration_minutes, Some(30));
        assert!(!mermaid_label(step).contains("размах"));
    }

    #[test]
    fn edges_run_from_the_prerequisite_to_the_dependent() {
        let g = built(&sample());
        // b.depends_on = [a] → a -> b, the direction work flows.
        let e = g
            .edges
            .iter()
            .find(|e| !e.membership)
            .expect("one drawn edge");
        assert_eq!((e.from.as_str(), e.to.as_str()), ("a", "b"));
        assert!(to_mermaid(&g).contains("t275 --> t274"));
        assert!(!to_mermaid(&g).contains("t274 --> t275"));
    }

    #[test]
    fn a_change_becomes_a_group_holding_its_children() {
        let g = built(&sample());
        assert_eq!(g.groups.len(), 1);
        let mut members = g.groups[0].members.clone();
        members.sort();
        assert_eq!(members, vec!["a".to_string(), "b".to_string()]);
        let text = to_mermaid(&g);
        let start = text.find("subgraph g273").expect("subgraph");
        let end = text[start..].find("\n  end").expect("end") + start;
        let inside = &text[start..end];
        for key in ["t273", "t275", "t274"] {
            assert!(inside.contains(key), "{key} must be inside the frame");
        }
        // Membership edges are replaced by the frame, not drawn twice.
        assert!(!text.contains("t275 --> t273"));
        assert!(g.edges.iter().any(|e| e.membership));
    }

    #[test]
    fn a_gate_is_shaped_differently_from_an_auto_node_and_an_empty_kind_is_a_gate() {
        let g = built(&sample());
        assert_eq!(node(&g, 275).kind, "auto");
        assert!(!node(&g, 275).gate);
        // Empty `kind` on the board (t#294 / t#283 boards) → manual gate.
        assert_eq!(node(&g, 274).kind, "manual");
        assert!(node(&g, 274).gate);
        let text = to_mermaid(&g);
        assert!(text.contains("t274{{\""), "a gate is a hexagon");
        assert!(text.contains("t275[\""), "an auto node is a box");
        assert!(text.contains("class t274 gate"));
        assert!(text.contains("class t275 auto"));
        assert!(mermaid_label(node(&g, 275)).contains("авто"));
        assert!(mermaid_label(node(&g, 274)).contains("гейт"));
        let d2 = to_d2(&g);
        assert!(d2.contains("shape: hexagon"));
        assert!(d2.contains("shape: rectangle"));
    }

    /// The predicate and measurability are two axes, and the picture must keep them
    /// apart: #275 is fully measured and FAILED its check, #274 has no recoverable
    /// cost and PASSED. Reading a dashed border as a failure — or a tick as "measured"
    /// — would misreport both nodes.
    #[test]
    fn an_outcome_predicate_is_marked_and_ok_reads_differently_from_issue() {
        let mut b = sample();
        b.todos[1].outcome = "issue".to_string();
        b.todos[1].outcome_reason = "verify:issue".to_string();
        b.todos[1].outcome_at = "2026-07-29T10:00:00Z".to_string();
        b.todos[2].outcome = "ok".to_string();
        b.todos[2].outcome_reason = "ok".to_string();
        let g = built(&b);

        let failed = node(&g, 275);
        assert_eq!(failed.outcome, "issue");
        assert_eq!(failed.outcome_reason, "verify:issue");
        assert_eq!(failed.measurability, Measurability::Measured);
        let passed = node(&g, 274);
        assert_eq!(passed.outcome, "ok");
        assert_eq!(passed.measurability, Measurability::NoInProgress);

        let failed_label = mermaid_label(failed);
        let passed_label = mermaid_label(passed);
        assert!(failed_label.contains("✗ сверка · verify:issue"));
        assert!(!failed_label.contains('✓'));
        assert!(passed_label.contains("✓ сверка"));
        assert!(!passed_label.contains('✗'));
        // `ok` as a reason adds nothing after the tick, so it is not repeated.
        assert!(!passed_label.contains("✓ сверка ·"));

        let text = to_mermaid(&g);
        assert!(text.contains("class t275 issue"));
        assert!(!text.contains("class t274 issue"), "a passed node is not painted");
        // Each axis marks its own node — an unknown cost is not a failed check.
        assert!(text.contains("class t274 unknown"));
        assert!(!text.contains("class t275 unknown"));

        let d2 = to_d2(&g);
        assert!(d2.contains("✗ сверка · verify:issue"));
        assert!(d2.contains("✓ сверка"));
        assert_eq!(d2.matches("style.stroke: \"#dc322f\"").count(), 1);
    }

    /// A node nobody checked gets NO mark in either format: an absent verdict must
    /// never be shown as a passed one. Neither may an unrecognized value.
    #[test]
    fn a_node_without_a_check_carries_no_outcome_mark() {
        let g = built(&sample());
        for number in [273, 274, 275] {
            let n = node(&g, number);
            assert!(n.outcome.is_empty() && n.outcome_reason.is_empty());
            let label = mermaid_label(n);
            assert!(!label.contains('✓') && !label.contains('✗') && !label.contains("сверка"));
        }
        let text = to_mermaid(&g);
        assert!(!text.contains(" issue\n") && !text.contains("сверка"));
        let d2 = to_d2(&g);
        assert!(!d2.contains("сверка") && !d2.contains("style.stroke: "));

        // A value that is neither predicate is printed as-is, without a symbol.
        let mut b = sample();
        b.todos[1].outcome = "maybe".to_string();
        let label = mermaid_label(node(&built(&b), 275));
        assert!(label.contains("сверка: maybe"));
        assert!(!label.contains('✓') && !label.contains('✗'));
        assert!(!to_mermaid(&built(&b)).contains("class t275 issue"));
    }

    /// The real subject of this very task: arrows, angle brackets and a pipe —
    /// plus a child carrying quotes, brackets and a semicolon.
    #[test]
    fn labels_survive_quotes_arrows_brackets_and_pipes() {
        let subject =
            "Генерирую граф прогона из доски и блоков — todos graph <theme> --format mermaid|d2";
        let mut root = todo("root", 306, subject);
        root.change = true;
        root.depends_on = vec!["c".to_string()];
        let child = todo("c", 307, "Кавычки «ёлочки» и \"канон\", скобки (a;b) [x] {y}");
        let g = build(&board(vec![root, child]), "306", &[], &[], &[], &no_costs());
        let text = to_mermaid(&g);

        // Entity codes (`#35;`) are the escaped form, so they are removed before
        // the label is checked for anything that would break the syntax.
        let strip_entities = |s: &str| {
            let chars: Vec<char> = s.chars().collect();
            let mut out = String::new();
            let mut i = 0;
            while i < chars.len() {
                if chars[i] == '#' {
                    let mut j = i + 1;
                    while j < chars.len() && chars[j].is_ascii_digit() {
                        j += 1;
                    }
                    if j > i + 1 && j < chars.len() && chars[j] == ';' {
                        i = j + 1;
                        continue;
                    }
                }
                out.push(chars[i]);
                i += 1;
            }
            out
        };
        for line in text.lines().filter(|l| l.contains('"')) {
            assert_eq!(line.matches('"').count() % 2, 0, "unbalanced quotes: {line}");
            let body = &line[line.find('"').unwrap() + 1..line.rfind('"').unwrap()];
            let cleaned = strip_entities(&body.replace("<br/>", ""));
            for bad in ['"', '[', ']', '(', ')', '{', '}', '|', '<', '>', ';', '#', '&'] {
                assert!(!cleaned.contains(bad), "{bad} leaked into a label: {line}");
            }
        }
        assert!(text.contains("#60;theme#62;"));
        assert!(text.contains("#124;d2"));
        assert!(text.contains("#34;"));

        let d2 = to_d2(&g);
        for line in d2.lines().filter(|l| l.contains(": \"")) {
            let body = &line[line.find(": \"").unwrap() + 3..];
            let body = body.trim_end_matches(" {").trim_end_matches('"');
            assert!(!body.contains('"') || body.contains("\\\""), "raw quote in d2: {line}");
        }
        assert!(d2.contains("\\\"канон\\\""));
    }

    #[test]
    fn blocks_that_undershoot_the_task_cost_keep_the_difference_visible() {
        let costs: HashMap<String, f64> = [("a".to_string(), 3.0)].into_iter().collect();
        let g = build(&sample(), "273", &[block("a")], &[totals(1.25)], &[vec![]], &costs);
        let a = node(&g, 275);
        assert_eq!(a.task_cost, Some(3.0));
        assert_eq!(a.unattributed_cost, Some(1.75));
        assert!(mermaid_label(a).contains("вне блоков ещё $1.75"));
        // No difference → nothing claimed.
        let exact: HashMap<String, f64> = [("a".to_string(), 1.25)].into_iter().collect();
        let g = build(&sample(), "273", &[block("a")], &[totals(1.25)], &[vec![]], &exact);
        assert!(node(&g, 275).unattributed_cost.is_none());
    }

    #[test]
    fn an_unmeasurable_node_still_reports_the_whole_task_cost_when_known() {
        let costs: HashMap<String, f64> = [("b".to_string(), 0.9)].into_iter().collect();
        let g = build(&sample(), "273", &[block("a")], &[totals(1.25)], &[vec![]], &costs);
        let b = node(&g, 274);
        assert!(b.cost.is_none());
        assert_eq!(b.task_cost, Some(0.9));
        let label = mermaid_label(b);
        assert!(label.contains("стоимость неизвестна"));
        assert!(label.contains("по задаче целиком $0.90"));
    }

    #[test]
    fn agents_are_summed_across_the_blocks_of_a_task() {
        let agent = |id: Option<&str>, cost: f64| GraphAgent {
            agent_id: id.map(String::from),
            agent_type: id.map(|_| "general-purpose".to_string()),
            description: None,
            cost,
            total_tokens: 1000,
            messages: 5,
        };
        let g = build(
            &sample(),
            "273",
            &[block("a"), block("a")],
            &[totals(1.0), totals(0.5)],
            &[
                vec![agent(None, 0.6), agent(Some("ag1"), 0.4)],
                vec![agent(Some("ag1"), 0.5)],
            ],
            &no_costs(),
        );
        let a = node(&g, 275);
        assert_eq!(a.cost, Some(1.5));
        assert_eq!(a.agents.len(), 2);
        let sub = a.agents.iter().find(|x| x.agent_id.is_some()).unwrap();
        assert!((sub.cost - 0.9).abs() < 1e-9);
        assert_eq!(sub.messages, 10);
        assert!(mermaid_label(a).contains("1 субагент"));
    }

    #[test]
    fn a_missing_or_empty_change_yields_an_empty_graph_not_a_panic() {
        for r in ["999", "", "не-задача", "t#42"] {
            let g = build(&sample(), r, &[block("a")], &[totals(1.0)], &[vec![]], &no_costs());
            assert!(g.nodes.is_empty() && g.edges.is_empty() && g.groups.is_empty());
            assert!(g.change.is_none());
            assert!(to_mermaid(&g).starts_with("flowchart TD"));
            assert!(to_d2(&g).starts_with("direction: down"));
        }
        let empty = board(vec![]);
        let g = build(&empty, "1", &[], &[], &[], &no_costs());
        assert!(g.nodes.is_empty());
        assert!(subtree(&empty, "1").is_empty());
    }

    #[test]
    fn short_totals_and_agents_do_not_panic() {
        let g = build(&sample(), "273", &[block("a")], &[], &[], &no_costs());
        let a = node(&g, 275);
        // Missing sums read as a block that measured nothing — unknown, not free.
        assert_eq!(a.measurability, Measurability::EmptyBlocks);
        assert_eq!(a.blocks, 1);
        assert!(a.cost.is_none());
        assert!(a.agents.is_empty());
    }

    /// The t#296 case: a block 0.185s long, opened and closed by two parallel
    /// agents of one session, whose real work sits in the neighbouring block. An
    /// empty block is a failure to measure; a block that HAS messages and rounds
    /// to `$0.00` is an honest zero. The two must not look alike.
    #[test]
    fn an_empty_block_is_unknown_while_a_zero_priced_one_is_an_honest_zero() {
        let empty = BlockTotals {
            cost: 0.0,
            total_tokens: 0,
            messages: 0,
            tool_calls: 0,
            tool_errors: 0,
        };
        let g = build(&sample(), "273", &[block("a")], &[empty], &[vec![]], &no_costs());
        let a = node(&g, 275);
        assert_eq!(a.measurability, Measurability::EmptyBlocks);
        assert_eq!(a.blocks, 1, "the degenerate block stays visible as evidence");
        assert!(a.cost.is_none() && a.messages.is_none() && a.tool_calls.is_none());
        let label = mermaid_label(a);
        assert!(label.contains("стоимость неизвестна"));
        assert!(label.contains("блок вырожден"));
        assert!(!label.contains("$0.00"));
        assert!(to_mermaid(&g).contains("class t275 unknown"));
        assert!(to_d2(&g).contains("style.stroke-dash: 3"));

        let rounded = BlockTotals {
            cost: 0.0,
            total_tokens: 900,
            messages: 3,
            tool_calls: 2,
            tool_errors: 0,
        };
        let g = build(&sample(), "273", &[block("a")], &[rounded], &[vec![]], &no_costs());
        let a = node(&g, 275);
        assert_eq!(a.measurability, Measurability::Measured);
        assert_eq!(a.cost, Some(0.0));
        assert_eq!(a.messages, Some(3));
        let label = mermaid_label(a);
        assert!(label.contains("$0.00"));
        assert!(!label.contains("неизвестна"));
        assert!(!to_mermaid(&g).contains("class t275 unknown"));
    }

    #[test]
    fn the_frame_caption_does_not_repeat_the_root_subject() {
        let g = built(&sample());
        let text = to_mermaid(&g);
        assert!(text.contains("subgraph g273[\"change #35;273\"]"));
        // The full subject lives on the root node inside the frame, once.
        assert_eq!(text.matches("Тема прогона").count(), 1);
        assert_eq!(to_d2(&g).matches("Тема прогона").count(), 1);
    }

    #[test]
    fn render_picks_the_format_and_names_what_it_produced() {
        let mut g = built(&sample());
        render(&mut g, "d2");
        assert_eq!(g.format, "d2");
        assert!(g.text.starts_with("direction: down"));
        assert!(g.text.contains("g273: "));
        assert!(g.text.contains("g273.t275 -> g273.t274"));
        let mut g = built(&sample());
        render(&mut g, "mermaid");
        assert_eq!(g.format, "mermaid");
        assert!(g.text.starts_with("flowchart TD"));
        // An unknown format falls back to Mermaid and says so.
        let mut g = built(&sample());
        render(&mut g, "dot");
        assert_eq!(g.format, "mermaid");
        assert!(g.text.starts_with("flowchart TD"));
    }

    #[test]
    fn a_nested_change_stays_a_node_inside_the_outer_frame() {
        let mut b = sample();
        b.todos[1].change = true; // #275 is a change nested under #273
        let g = built(&b);
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].number, 273);
        assert!(to_mermaid(&g).matches("subgraph").count() == 1);
    }

    #[test]
    fn subtree_walks_the_dependency_closure_from_the_root() {
        let ids = subtree(&sample(), "t#273");
        assert_eq!(ids.len(), 3);
        // Ordered by task number: 273, 274, 275.
        assert_eq!(ids[0], "root");
    }
}
