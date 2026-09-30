use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{json, Value};

use crate::analytics::codex::cost_for;
use crate::analytics::work_tree::{
    brief_input, brief_result, WorkToolCall, WorkToolResult, WorkTree, WorkTreeInterval, WorkTurn,
};

pub fn build_codex_work_tree(path: &Path) -> Result<WorkTree, String> {
    build_codex_work_tree_in_interval(path, &WorkTreeInterval::default())
}

pub fn build_codex_work_tree_in_interval(
    path: &Path,
    interval: &WorkTreeInterval,
) -> Result<WorkTree, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut session_id = None;
    let mut model = "codex-unknown".to_string();
    let mut pending = Vec::new();
    let mut results = HashMap::new();
    let mut turns = Vec::new();
    let mut totals = HashSet::new();

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("{}: {e}", path.display()))?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = record.get("payload").unwrap_or(&Value::Null);
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                session_id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("turn_context") => {
                if let Some(value) = payload.get("model").and_then(Value::as_str) {
                    model = value.to_string();
                }
            }
            Some("response_item") => match payload.get("type").and_then(Value::as_str) {
                Some("custom_tool_call") => {
                    if let Some(call) = call_from_payload(payload) {
                        if in_interval(record.get("timestamp").and_then(Value::as_str), interval) {
                            pending.push(call);
                        }
                    }
                }
                Some("custom_tool_call_output") => {
                    if in_interval(record.get("timestamp").and_then(Value::as_str), interval) {
                        collect_result(&record, payload, &mut results)
                    }
                }
                _ => {}
            },
            Some("event_msg")
                if payload.get("type").and_then(Value::as_str) == Some("token_count") =>
            {
                if in_interval(record.get("timestamp").and_then(Value::as_str), interval) {
                    add_turn(
                        &record,
                        payload,
                        &model,
                        &mut pending,
                        &mut results,
                        &mut totals,
                        &mut turns,
                    );
                }
            }
            _ => {}
        }
    }

    for turn in &mut turns {
        for call in &mut turn.calls {
            if call.result.is_none() {
                call.result = results.get(&call.id).cloned();
            }
        }
    }

    let mut tree = WorkTree {
        session_id,
        transcript_path: path.to_string_lossy().to_string(),
        started_at: turns.first().map(|turn: &WorkTurn| turn.timestamp.clone()),
        ended_at: turns.last().map(|turn: &WorkTurn| turn.timestamp.clone()),
        turns,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost: 0.0,
        agent_type: None,
        fork: false,
        compacted: false,
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

fn in_interval(timestamp: Option<&str>, interval: &WorkTreeInterval) -> bool {
    let Some(timestamp) = timestamp else {
        return false;
    };
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

fn call_from_payload(payload: &Value) -> Option<WorkToolCall> {
    let id = payload.get("call_id")?.as_str()?.to_string();
    let name = payload.get("name")?.as_str()?.to_string();
    let input = payload.get("input").cloned().unwrap_or(Value::Null);
    if name == "exec" {
        if let Some(files) = input.as_str().and_then(patch_files) {
            return Some(WorkToolCall {
                id,
                name: "apply_patch".into(),
                input: brief_input(&Value::String(files)),
                result: None,
                subagent: None,
            });
        }
    }
    Some(WorkToolCall {
        id,
        name: name.clone(),
        input: brief_input(&if name == "exec" {
            exec_input(&input)
        } else {
            input
        }),
        result: None,
        subagent: None,
    })
}

fn collect_result(record: &Value, payload: &Value, results: &mut HashMap<String, WorkToolResult>) {
    let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
        return;
    };
    let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
        return;
    };
    results
        .entry(call_id.to_string())
        .or_insert_with(|| WorkToolResult {
            timestamp: timestamp.to_string(),
            is_error: false,
            content: brief_result(payload.get("output").unwrap_or(&Value::Null)),
        });
}

fn add_turn(
    record: &Value,
    payload: &Value,
    model: &str,
    pending: &mut Vec<WorkToolCall>,
    results: &mut HashMap<String, WorkToolResult>,
    totals: &mut HashSet<String>,
    turns: &mut Vec<WorkTurn>,
) {
    let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
        return;
    };
    let Some(info) = payload.get("info") else {
        return;
    };
    let Some(usage) = info.get("last_token_usage") else {
        return;
    };
    let total_key = info
        .get("total_token_usage")
        .map(token_key)
        .unwrap_or_else(|| format!("at:{timestamp}:{}", token_key(usage)));
    if !totals.insert(total_key.clone()) {
        return;
    }
    let input = token(usage, "input_tokens");
    let output = token(usage, "output_tokens");
    let creation = token(usage, "cache_write_input_tokens");
    let read = token(usage, "cached_input_tokens");
    let mut calls = std::mem::take(pending);
    for call in &mut calls {
        call.result = results.get(&call.id).cloned();
    }
    turns.push(WorkTurn {
        id: format!("codex:{total_key}"),
        parent_uuid: None,
        timestamp: timestamp.to_string(),
        model: model.to_string(),
        input_tokens: (input - read - creation).max(0),
        output_tokens: output,
        cache_creation_tokens: creation,
        cache_read_tokens: read,
        cost: cost_for(model, input, output, creation, read),
        calls,
    });
}

fn token(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn token_key(value: &Value) -> String {
    format!(
        "{}:{}:{}:{}",
        token(value, "input_tokens"),
        token(value, "cached_input_tokens"),
        token(value, "cache_write_input_tokens"),
        token(value, "output_tokens")
    )
}

fn patch_files(script: &str) -> Option<String> {
    if !script.contains("*** Begin Patch") {
        return None;
    }
    let mut files = Vec::new();
    for marker in ["*** Add File: ", "*** Update File: ", "*** Delete File: "] {
        for (at, _) in script.match_indices(marker) {
            let mut path = String::new();
            let mut chars = script[at + marker.len()..].chars();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => match chars.next() {
                        Some('n' | 'r') | None => break,
                        Some(next) => path.push(next),
                    },
                    '"' | '\n' | '\r' => break,
                    _ => path.push(c),
                }
            }
            let path = path.trim();
            let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
            if !name.is_empty() {
                files.push((at, name.to_string()));
            }
        }
    }
    files.sort();
    let names: Vec<String> = files.into_iter().map(|(_, name)| name).collect();
    (!names.is_empty()).then(|| names.join(", "))
}

fn exec_input(input: &Value) -> Value {
    let Some(script) = input.as_str() else {
        return input.clone();
    };
    let Some(start) = script.find("tools.exec_command(") else {
        return input.clone();
    };
    let rest = &script[start + "tools.exec_command(".len()..];
    let Some(object) = json_object(rest) else {
        return input.clone();
    };
    serde_json::from_str::<Value>(object)
        .ok()
        .and_then(|value| value.get("cmd").cloned().map(|cmd| json!({ "cmd": cmd })))
        .unwrap_or_else(|| input.clone())
}

fn json_object(input: &str) -> Option<&str> {
    let start = input.find('{')?;
    let bytes = input.as_bytes();
    let mut depth = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&input[start..=start + offset]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn joins_call_output_extracts_exec_command_and_deduplicates_totals() {
        let path = std::env::temp_dir().join(format!(
            "codex-work-tree-{}.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, concat!(
            r#"{"type":"session_meta","payload":{"id":"thread-1"}}"#, "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-terra"}}"#, "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"const r = await tools.exec_command({\"cmd\":\"rg -n \\\"hi\\\" src\",\"workdir\":\"D:\\\\work\"});"}}"#, "\n",
            r#"{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":[{"type":"input_text","text":"ok"}]}}"#, "\n",
            r#"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2},"last_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}}}"#, "\n",
            r#"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2},"last_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}}}"#
        )).unwrap();
        let tree = build_codex_work_tree(&path).unwrap();
        assert_eq!(tree.session_id.as_deref(), Some("thread-1"));
        assert_eq!(tree.turns.len(), 1);
        assert_eq!(tree.input_tokens, 6);
        assert_eq!(tree.turns[0].calls[0].input, json!("rg -n \"hi\" src"));
        assert_eq!(
            tree.turns[0].calls[0].result.as_ref().unwrap().content,
            "ok"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_patch_script_becomes_an_apply_patch_call_with_file_names() {
        let script = r#"const patch = "*** Begin Patch\n*** Update File: D:\\new\\src\\a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch";"#;
        let call = call_from_payload(&json!({"call_id":"c","name":"exec","input":script})).unwrap();
        assert_eq!(call.name, "apply_patch");
        assert_eq!(call.input, json!("a.ts, b.ts"));
    }

    #[test]
    fn joins_output_that_arrives_after_the_turn_token_count() {
        let path = std::env::temp_dir().join(format!(
            "codex-work-tree-delayed-output-{}.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, concat!(
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"tools.exec_command({\"cmd\":\"dir\"})"}}"#, "\n",
            r#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1}}}}"#, "\n",
            r#"{"timestamp":"2026-01-01T00:00:03Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"done"}}"#
        )).unwrap();

        let tree = build_codex_work_tree(&path).unwrap();
        assert_eq!(tree.turns.len(), 1);
        assert_eq!(
            tree.turns[0].calls[0].result.as_ref().unwrap().content,
            json!("done")
        );
        std::fs::remove_file(path).unwrap();
    }
}
