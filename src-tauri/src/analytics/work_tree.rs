use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::analytics::cc::cost_for;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkTree {
    pub session_id: Option<String>,
    pub transcript_path: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub turns: Vec<WorkTurn>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkTurn {
    pub id: String,
    pub parent_uuid: Option<String>,
    pub timestamp: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost: f64,
    pub calls: Vec<WorkToolCall>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub result: Option<WorkToolResult>,
    pub subagent: Option<Box<WorkTree>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkToolResult {
    pub timestamp: String,
    pub is_error: bool,
    pub content: Value,
}

#[derive(Debug, Clone, Default)]
pub struct WorkTreeInterval {
    pub start: Option<String>,
    pub end: Option<String>,
}

pub fn build_work_tree(path: &Path, interval: &WorkTreeInterval) -> Result<WorkTree, String> {
    build_work_tree_inner(path, interval, &mut HashSet::new())
}

pub fn build_session_work_tree(path: &Path) -> Result<WorkTree, String> {
    build_work_tree(path, &WorkTreeInterval::default())
}

fn build_work_tree_inner(
    path: &Path,
    interval: &WorkTreeInterval,
    visiting: &mut HashSet<PathBuf>,
) -> Result<WorkTree, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !visiting.insert(canonical.clone()) {
        return Err(format!("recursive subagent transcript: {}", path.display()));
    }
    let result = parse_work_tree(path, interval, visiting);
    visiting.remove(&canonical);
    result
}

fn parse_work_tree(
    path: &Path,
    interval: &WorkTreeInterval,
    visiting: &mut HashSet<PathBuf>,
) -> Result<WorkTree, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut session_id = None;
    let mut turns: Vec<WorkTurn> = Vec::new();
    let mut turn_by_message = HashMap::<String, usize>::new();
    let mut results = HashMap::<String, WorkToolResult>::new();

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("{}: {e}", path.display()))?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if session_id.is_none() {
            session_id = record
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        match record.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                add_assistant_turn(&record, interval, &mut turns, &mut turn_by_message)
            }
            Some("user") => collect_results(&record, &mut results),
            _ => {}
        }
    }

    let agents = agent_manifests(path);
    for turn in &mut turns {
        for call in &mut turn.calls {
            call.result = results.remove(&call.id);
            if let Some(agent_path) = agents.get(&call.id) {
                call.subagent = Some(Box::new(build_work_tree_inner(
                    agent_path, interval, visiting,
                )?));
            }
        }
    }

    let mut tree = WorkTree {
        session_id,
        transcript_path: path.to_string_lossy().to_string(),
        started_at: turns.first().map(|t| t.timestamp.clone()),
        ended_at: turns.last().map(|t| t.timestamp.clone()),
        turns,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost: 0.0,
    };
    for turn in &tree.turns {
        tree.input_tokens += turn.input_tokens;
        tree.output_tokens += turn.output_tokens;
        tree.cache_creation_tokens += turn.cache_creation_tokens;
        tree.cache_read_tokens += turn.cache_read_tokens;
        tree.cost += turn.cost;
    }
    Ok(tree)
}

fn add_assistant_turn(
    record: &Value,
    interval: &WorkTreeInterval,
    turns: &mut Vec<WorkTurn>,
    turn_by_message: &mut HashMap<String, usize>,
) {
    let Some(message) = record.get("message") else {
        return;
    };
    let Some(id) = message.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
        return;
    };
    if !in_interval(timestamp, interval)
        || message.get("model").and_then(Value::as_str) == Some("<synthetic>")
    {
        return;
    }
    if let Some(&index) = turn_by_message.get(id) {
        merge_calls(&mut turns[index].calls, message);
        return;
    }
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let input = usage_token(message, "input_tokens");
    let output = usage_token(message, "output_tokens");
    let creation = usage_token(message, "cache_creation_input_tokens");
    let read = usage_token(message, "cache_read_input_tokens");
    let index = turns.len();
    turns.push(WorkTurn {
        id: id.to_string(),
        parent_uuid: record
            .get("parentUuid")
            .and_then(Value::as_str)
            .map(str::to_string),
        timestamp: timestamp.to_string(),
        model: model.clone(),
        input_tokens: input,
        output_tokens: output,
        cache_creation_tokens: creation,
        cache_read_tokens: read,
        cost: cost_for(&model, input, output, creation, read),
        calls: calls_from_message(message),
    });
    turn_by_message.insert(id.to_string(), index);
}

fn token(usage: &Value, key: &str) -> i64 {
    usage.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn usage_token(message: &Value, key: &str) -> i64 {
    message
        .get("usage")
        .map(|usage| token(usage, key))
        .unwrap_or(0)
}

fn calls_from_message(message: &Value) -> Vec<WorkToolCall> {
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content.iter().filter_map(call_from_block).collect()
}

const INPUT_KEYS: [&str; 9] = [
    "file_path",
    "path",
    "pattern",
    "command",
    "cmd",
    "url",
    "query",
    "description",
    "subject",
];

pub fn brief_input(input: &Value) -> Value {
    let text = match input {
        Value::String(value) => Some(value.as_str()),
        Value::Object(map) => INPUT_KEYS
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str)),
        _ => None,
    };
    text.map(|value| {
        Value::String(clip(
            &value.split_whitespace().collect::<Vec<_>>().join(" "),
            120,
        ))
    })
    .unwrap_or(Value::Null)
}

pub fn brief_result(content: &Value) -> Value {
    let text = match content {
        Value::String(value) => Some(value.clone()),
        Value::Array(items) => items.iter().find_map(|item| {
            item.as_str()
                .map(str::to_string)
                .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
        }),
        Value::Object(map) => map.get("text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    };
    text.and_then(|value| {
        value
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| Value::String(clip(line, 200)))
    })
    .unwrap_or(Value::Null)
}

fn clip(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out: String = value.chars().take(limit - 1).collect();
    out.push('…');
    out
}

fn call_from_block(block: &Value) -> Option<WorkToolCall> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    Some(WorkToolCall {
        id: block.get("id")?.as_str()?.to_string(),
        name: block.get("name")?.as_str()?.to_string(),
        input: brief_input(block.get("input").unwrap_or(&Value::Null)),
        result: None,
        subagent: None,
    })
}

fn merge_calls(calls: &mut Vec<WorkToolCall>, message: &Value) {
    for call in calls_from_message(message) {
        if !calls.iter().any(|known| known.id == call.id) {
            calls.push(call);
        }
    }
}

fn collect_results(record: &Value, results: &mut HashMap<String, WorkToolResult>) {
    let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
        return;
    };
    let Some(content) = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        results
            .entry(id.to_string())
            .or_insert_with(|| WorkToolResult {
                timestamp: timestamp.to_string(),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                content: brief_result(block.get("content").unwrap_or(&Value::Null)),
            });
    }
}

fn agent_manifests(path: &Path) -> HashMap<String, PathBuf> {
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return HashMap::new();
    };
    let Some(dir) = path.parent().map(|p| p.join(stem).join("subagents")) else {
        return HashMap::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return HashMap::new();
    };
    let mut manifests = HashMap::new();
    for entry in entries.flatten() {
        let meta_path = entry.path();
        let Some(name) = meta_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stem) = name
            .strip_suffix(".meta.json")
            .and_then(|s| s.strip_prefix("agent-"))
        else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&meta_path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(tool_use_id) = meta.get("toolUseId").and_then(Value::as_str) else {
            continue;
        };
        let transcript = meta_path.with_file_name(format!("agent-{stem}.jsonl"));
        if transcript.is_file() {
            manifests
                .entry(tool_use_id.to_string())
                .or_insert(transcript);
        }
    }
    manifests
}

fn in_interval(timestamp: &str, interval: &WorkTreeInterval) -> bool {
    interval
        .start
        .as_deref()
        .map(|start| timestamp >= start)
        .unwrap_or(true)
        && interval
            .end
            .as_deref()
            .map(|end| timestamp <= end)
            .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    #[test]
    fn briefs_keep_only_a_short_argument_and_the_first_result_line() {
        let long = "x".repeat(300);
        assert_eq!(
            brief_input(&serde_json::json!({"file_path": "src/a.rs", "content": long})),
            serde_json::json!("src/a.rs")
        );
        assert_eq!(
            brief_input(&serde_json::json!({"command": format!("echo {long}")}))
                .as_str()
                .unwrap()
                .chars()
                .count(),
            120
        );
        assert_eq!(
            brief_input(&serde_json::json!({"content": "secret"})),
            Value::Null
        );
        assert_eq!(
            brief_result(&serde_json::json!([{"type": "text", "text": "
  first
second"}])),
            serde_json::json!("first")
        );
    }

    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("claude-work-tree-{unique}"));
        std::fs::create_dir_all(path.join("session/subagents")).unwrap();
        path
    }

    #[test]
    fn deduplicates_messages_pairs_only_matching_results_and_links_agent_by_manifest_id() {
        let dir = temp_dir();
        let parent = dir.join("session.jsonl");
        std::fs::write(&parent, concat!(
            r#"{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:01Z","parentUuid":"u","message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"call-good","name":"Agent","input":{"description":"right"}},{"type":"tool_use","id":"call-no-result","name":"Read","input":{"file_path":"a"}}]}}"#, "\n",
            r#"{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:01Z","message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"call-good","name":"Agent","input":{"description":"right"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"wrong-call","is_error":true,"content":"wrong"},{"type":"tool_result","tool_use_id":"call-good","content":"ok"}]}}"#
        )).unwrap();
        std::fs::write(
            dir.join("session/subagents/agent-child.meta.json"),
            r#"{"toolUseId":"call-good"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("session/subagents/agent-child.jsonl"), r#"{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:03Z","message":{"id":"child-m","model":"claude-haiku","usage":{"input_tokens":3,"output_tokens":2},"content":[]}}"#).unwrap();

        let tree = build_session_work_tree(&parent).unwrap();
        assert_eq!(tree.turns.len(), 1);
        assert_eq!(tree.input_tokens, 10);
        assert_eq!(tree.output_tokens, 5);
        assert_eq!(tree.turns[0].calls.len(), 2);
        assert_eq!(
            tree.turns[0].calls[0].result.as_ref().unwrap().is_error,
            false
        );
        assert!(tree.turns[0].calls[1].result.is_none());
        assert_eq!(
            tree.turns[0].calls[0]
                .subagent
                .as_ref()
                .unwrap()
                .turns
                .len(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interval_excludes_turns_outside_requested_session_window() {
        let dir = temp_dir();
        let transcript = dir.join("session.jsonl");
        std::fs::write(&transcript, concat!(
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"id":"old","model":"claude-haiku","usage":{"input_tokens":1},"content":[]}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"id":"kept","model":"claude-haiku","usage":{"input_tokens":2},"content":[]}}"#
        )).unwrap();
        let tree = build_work_tree(
            &transcript,
            &WorkTreeInterval {
                start: Some("2026-01-01T00:00:02Z".into()),
                end: None,
            },
        )
        .unwrap();
        assert_eq!(tree.turns.len(), 1);
        assert_eq!(tree.turns[0].id, "kept");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
