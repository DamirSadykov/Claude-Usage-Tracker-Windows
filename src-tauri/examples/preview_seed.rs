//! Fills a PREVIEW instance's database with made-up messages so the run layer
//! (t#307) can be looked at without waiting for a real ingest:
//!
//!   cargo run --example preview_seed
//!   CUT_APP_DIR=<dir> cargo run --example preview_seed
//!
//! Blocks are read from that instance's own `task-sessions.jsonl`, so the rows
//! always land inside the spans the board records — no second copy of the demo
//! layout to keep in sync. A degenerate block (under a second) is left alone: it
//! is what shows the `empty_blocks` state on the demo board.
//!
//! It refuses to write anywhere without `preview` in the path, so a mistyped
//! variable can't seed the live instance.

use std::collections::HashMap;

use claude_usage_tracker_lib::stats::{CcAgentRow, CcUsageRow, StatsDb};
use claude_usage_tracker_lib::{task_sessions, todos};

/// Per task number: how many messages the block gets and which agents split it.
const SHAPE: &[(u32, i64, &[(&str, &str, &str, i64)])] = &[
    (901, 7, &[]),
    (
        902,
        60,
        &[
            ("demo-a1", "general-purpose", "экспортер: модель и запись", 22),
            ("demo-a2", "general-purpose", "правка по замечаниям ревью", 15),
        ],
    ),
    (
        903,
        34,
        &[("demo-a3", "Explore", "поиск места под кнопку выгрузки", 12)],
    ),
    (
        904,
        17,
        &[("demo-a4", "code-reviewer", "чек-лист экспортера", 6)],
    ),
];
const COST_PER_MSG: f64 = 0.17;

fn app_dir() -> std::path::PathBuf {
    match std::env::var("CUT_APP_DIR") {
        Ok(d) => std::path::PathBuf::from(d),
        Err(_) => std::path::PathBuf::from(std::env::var("APPDATA").unwrap())
            .join("com.claude-usage-tracker.preview"),
    }
}

fn main() {
    let dir = app_dir();
    assert!(
        dir.to_string_lossy().contains("preview"),
        "отказываюсь писать выдуманные строки вне preview-инстанса: {}",
        dir.display()
    );
    let board = todos::load(&dir.join("todos.json"));
    let numbers: HashMap<String, u32> = board.todos.iter().map(|x| (x.id.clone(), x.number)).collect();
    let events = task_sessions::load(&dir.join("task-sessions.jsonl"));
    let blocks = task_sessions::blocks(&events, &HashMap::new());
    let db = dir.join("usage_stats.db");
    // Re-seeding replaces the previous demo rows instead of piling onto them:
    // ids are stable, so INSERT OR IGNORE alone would silently keep the old
    // spans after the board is regenerated.
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        let usage = conn
            .execute("DELETE FROM cc_usage WHERE message_id LIKE 'demo-%'", [])
            .unwrap_or(0);
        let agents = conn
            .execute("DELETE FROM cc_agent WHERE agent_id LIKE 'demo-%'", [])
            .unwrap_or(0);
        if usage + agents > 0 {
            println!("прежних демо-строк убрано: {usage} сообщений, {agents} агентов");
        }
    }
    let stats = StatsDb::open(&db).unwrap();

    let mut rows: Vec<CcUsageRow> = Vec::new();
    let mut agents: Vec<CcAgentRow> = Vec::new();
    let mut skipped: Vec<u32> = Vec::new();
    for b in &blocks {
        let number = numbers.get(&b.task).copied().unwrap_or(0);
        let Some((_, messages, shape)) = SHAPE.iter().find(|(n, _, _)| *n == number) else {
            skipped.push(number);
            continue;
        };
        let from = chrono::DateTime::parse_from_rfc3339(&b.from).expect("bad block start");
        let to = chrono::DateTime::parse_from_rfc3339(&b.to).expect("bad block end");
        let span = (to - from).num_seconds().max(1) as f64;
        let sub_total: i64 = shape.iter().map(|a| a.3).sum();
        let mut i = 0i64;
        let mut push = |i: &mut i64, agent: Option<(&str, &str)>, count: i64| {
            for k in 0..count {
                let ts = from + chrono::Duration::seconds((span * *i as f64 / *messages as f64) as i64);
                rows.push(CcUsageRow {
                    message_id: match agent {
                        Some((a, _)) => format!("demo-{number}-{a}-{k}"),
                        None => format!("demo-{number}-main-{k}"),
                    },
                    ts: ts.to_rfc3339(),
                    model: "claude-opus-5".into(),
                    input: 900,
                    output: 700,
                    cache_create: 24_000,
                    cache_read: 280_000,
                    cost: COST_PER_MSG,
                    session_id: Some(b.session.clone()),
                    project: Some("dsl-demo".into()),
                    is_subagent: agent.is_some(),
                    agent_name: agent.map(|(_, t)| t.to_string()),
                    agent_id: agent.map(|(a, _)| a.to_string()),
                    tool_uses: vec![("Edit".into(), 1), ("Bash".into(), 1)],
                    service_tier: Some("standard".into()),
                    git_commits: 0,
                    git_pushes: 0,
                });
                *i += 1;
            }
        };
        push(&mut i, None, (messages - sub_total).max(1));
        for (id, kind, what, count) in shape.iter() {
            push(&mut i, Some((id, kind)), *count);
            agents.push(CcAgentRow {
                agent_id: (*id).to_string(),
                session_id: Some(b.session.clone()),
                agent_type: Some((*kind).to_string()),
                description: Some((*what).to_string()),
                tool_use_id: None,
                spawn_depth: Some(1),
            });
        }
    }

    let n = stats.cc_upsert(&rows).unwrap();
    let a = stats.cc_agent_upsert(&agents).unwrap();
    println!("инстанс: {}", dir.display());
    println!("блоков в журнале: {}, засеяно сообщений: {n} из {}, агентов: {a}", blocks.len(), rows.len());
    if !skipped.is_empty() {
        println!("без сообщений (так и задумано): {skipped:?}");
    }
}
