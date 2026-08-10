use std::collections::{HashMap, HashSet};

use claude_usage_tracker_lib::stats::StatsDb;
use claude_usage_tracker_lib::{graph, task_cost, task_sessions, todos};

fn app_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("CUT_APP_DIR") {
        return std::path::PathBuf::from(d);
    }
    std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.claude-usage-tracker.app")
}

/// The preview instance has its own board but no database of its own until it
/// runs; point the dump at the live one to check a board before launching.
fn db_path() -> std::path::PathBuf {
    match std::env::var("CUT_DB") {
        Ok(d) => std::path::PathBuf::from(d),
        Err(_) => app_dir().join("usage_stats.db"),
    }
}

fn main() {
    let dir = app_dir();
    let theme = std::env::args().nth(1).unwrap_or_else(|| "294".to_string());
    let format = std::env::args().nth(2).unwrap_or_else(|| "mermaid".to_string());

    let board = todos::load(&dir.join("todos.json"));
    let events = task_sessions::load(&dir.join("task-sessions.jsonl"));
    let stats = StatsDb::open(&db_path()).unwrap();
    let usage = stats.sessions_all().unwrap();
    let ends: HashMap<String, String> = usage
        .iter()
        .map(|s| (s.session_id.clone(), s.end.clone()))
        .collect();
    let all = task_sessions::blocks(&events, &ends);
    let attr = task_cost::load(&dir.join("task-attribution.json")).unwrap_or_default();
    let costs: HashMap<String, f64> = task_cost::compute(&attr, &board, &usage, &all)
        .tasks
        .into_iter()
        .map(|t| (t.id, t.cost))
        .collect();
    let ids: HashSet<String> = graph::subtree(&board, &theme).into_iter().collect();
    let blocks: Vec<task_sessions::TaskBlock> =
        all.into_iter().filter(|b| ids.contains(&b.task)).collect();
    let spans: Vec<(String, String, String)> = blocks
        .iter()
        .map(|b| (b.session.clone(), b.from.clone(), b.to.clone()))
        .collect();
    let totals = stats.block_totals_many(&spans).unwrap();
    let mut agents: Vec<Vec<graph::GraphAgent>> = Vec::new();
    for (session, from, to) in &spans {
        agents.push(
            stats
                .block_agents(session, from, to)
                .unwrap()
                .into_iter()
                .map(|a| graph::GraphAgent {
                    agent_id: a.agent_id,
                    agent_type: a.agent_type,
                    description: a.description,
                    cost: a.cost,
                    total_tokens: a.total_tokens,
                    messages: a.messages,
                })
                .collect(),
        );
    }
    let mut out = graph::build(&board, &theme, &blocks, &totals, &agents, &costs);
    if format == "json" {
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
        return;
    }
    graph::render(&mut out, &format);

    eprintln!(
        "СВЕРКА: узлов {}, рёбер {} (из них membership {}), групп {}",
        out.nodes.len(),
        out.edges.len(),
        out.edges.iter().filter(|e| e.membership).count(),
        out.groups.len()
    );
    for n in &out.nodes {
        eprintln!(
            "  #{} {:?} cost={:?} dur={:?} calendar={} gate={} change={} blocks={} agents={}",
            n.number,
            n.measurability,
            n.cost,
            n.duration_minutes,
            n.duration_calendar,
            n.gate,
            n.change,
            n.blocks,
            n.agents.len()
        );
        eprintln!(
            "        task_cost={:?} unattributed={:?} messages={:?} tool_calls={:?}",
            n.task_cost, n.unattributed_cost, n.messages, n.tool_calls
        );
    }
    println!("{}", out.text);
}
