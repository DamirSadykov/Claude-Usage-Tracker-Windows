//! Claude Code usage ingest. Reads the local CLI transcripts under
//! `~/.claude/projects/**/*.jsonl`, extracts per-assistant-message token usage
//! and model, computes a cost estimate, and dedup-stores it in the stats DB.
//!
//! Privacy: this only ever READS the local transcript files and only keeps token
//! counts / model / timestamp. No transcript content is stored or sent anywhere.
//! Ingestion is opt-in (off by default) and gated by the caller.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::stats::{CcUsageRow, StatsDb, ToolResultRow, TurnRow};

/// A whole transcript file parsed into its three concerns: per-message usage
/// rows (assistant lines), tool-result outcomes (user lines) and turn-duration
/// rows (system lines). All three are produced in a single pass over the lines.
#[derive(Default)]
pub struct ParsedFile {
    pub usage: Vec<CcUsageRow>,
    pub tool_results: Vec<ToolResultRow>,
    pub turns: Vec<TurnRow>,
}

/// Per-million-token prices (input, output) in USD. Cache-write is input×1.25,
/// cache-read is input×0.1 (Anthropic's published multipliers). Matched by model
/// family substring so new point releases (opus-4-7, opus-4-8…) keep working.
/// Opus is the current 4.5–4.8 rate ($5/$25); the legacy Opus 4/4.1 $15/$75 is
/// not modelled separately since those are deprecated and rare in transcripts.
/// `pub` so analytics can price cache savings per model family from one source
/// of truth (the input rate `.0`).
pub fn price_per_mtok(model: &str) -> Option<(f64, f64)> {
    let m = model.to_ascii_lowercase();
    if m.contains("fable") {
        Some((10.0, 50.0))
    } else if m.contains("opus") {
        Some((5.0, 25.0))
    } else if m.contains("sonnet") {
        Some((3.0, 15.0))
    } else if m.contains("haiku") {
        Some((1.0, 5.0))
    } else {
        None
    }
}

/// USD cost for one message's token usage. Unknown models cost 0 (tokens still counted).
pub fn cost_for(
    model: &str,
    input: i64,
    output: i64,
    cache_create: i64,
    cache_read: i64,
) -> f64 {
    let (pin, pout) = match price_per_mtok(model) {
        Some(p) => p,
        None => return 0.0,
    };
    let input = input as f64;
    let output = output as f64;
    let cc = cache_create as f64;
    let cr = cache_read as f64;
    (input * pin + cc * pin * 1.25 + cr * pin * 0.1 + output * pout) / 1_000_000.0
}

/// Parse one transcript line into a usage row. Returns None for non-assistant
/// lines, synthetic messages, or anything lacking real token usage.
pub fn parse_line(line: &str) -> Option<CcUsageRow> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let msg = v.get("message")?;
    let model = msg.get("model")?.as_str()?;
    if model == "<synthetic>" {
        return None;
    }
    let message_id = msg.get("id")?.as_str()?.to_string();
    let usage = msg.get("usage")?;
    let input = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
    let output = usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
    let cache_create = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    // Service tier the API billed this message at ("standard" / "priority" /
    // "batch"); a low standard-share is an indirect throttling signal. Absent on
    // older transcripts / keep-alive lines → None ("unknown").
    let service_tier = usage
        .get("service_tier")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Drop rows with no tokens at all (keep-alives / empty turns).
    if input == 0 && output == 0 && cache_create == 0 && cache_read == 0 {
        return None;
    }

    let ts = v.get("timestamp")?.as_str()?.to_string();
    let session_id = v
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let project = v.get("cwd").and_then(Value::as_str).and_then(project_name);
    // Subagent attribution: `isSidechain=true` marks Task() child turns; the
    // transcript may also carry `agentName` / `attributionAgent`. The caller
    // augments this from the file name (agent-*.jsonl) for older transcripts
    // that lacked the flag.
    let is_subagent = v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false)
        || v.get("agentName").is_some()
        || v.get("agentId").is_some();
    let agent_name = v
        .get("agentName")
        .and_then(Value::as_str)
        .or_else(|| v.get("attributionAgent").and_then(Value::as_str))
        .map(str::to_string);
    let cost = cost_for(model, input, output, cache_create, cache_read);
    let tool_uses = extract_tool_uses(msg);
    let (git_commits, git_pushes) = extract_git_ops(msg);

    Some(CcUsageRow {
        message_id,
        ts,
        model: model.to_string(),
        input,
        output,
        cache_create,
        cache_read,
        cost,
        session_id,
        project,
        is_subagent,
        agent_name,
        tool_uses,
        service_tier,
        git_commits,
        git_pushes,
    })
}

/// Tool-result outcomes carried by one transcript line. Returns empty for
/// non-`user` lines or lines without `tool_result` blocks. Keeps ONLY the
/// is_error flag + ids/ts — never the tool output content (privacy contract,
/// see module header). One user line can batch several tool_result blocks
/// (parallel tool calls), hence a `Vec`.
pub fn parse_tool_results(line: &str) -> Vec<ToolResultRow> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return Vec::new();
    }
    let ts = match v.get("timestamp").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => return Vec::new(),
    };
    let session_id = v
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(content) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        // Plain-text user message (`content` is a string) → no tool results.
        return Vec::new();
    };

    let mut out = Vec::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        // `is_error` may be absent (success) or a bool.
        let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        out.push(ToolResultRow {
            tool_use_id: id.to_string(),
            session_id: session_id.clone(),
            ts: ts.clone(),
            is_error,
        });
    }
    out
}

/// One `turn_duration` system line: the real wall-clock active time of a turn.
/// None for anything that isn't a `type:"system", subtype:"turn_duration"` line
/// or that lacks a uuid / positive duration. Active time is a main-thread
/// quantity — subagents don't emit turn_duration, so `is_subagent` is virtually
/// always false here, but we keep the flag for consistency with cc_usage.
pub fn parse_turn_line(line: &str) -> Option<TurnRow> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "system" {
        return None;
    }
    if v.get("subtype")?.as_str()? != "turn_duration" {
        return None;
    }
    let uuid = v.get("uuid")?.as_str()?.to_string();
    let duration_ms = v.get("durationMs").and_then(Value::as_i64).unwrap_or(0);
    if duration_ms <= 0 {
        return None; // keep-alive / malformed
    }
    let ts = v.get("timestamp")?.as_str()?.to_string();
    let session_id = v
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let message_count = v.get("messageCount").and_then(Value::as_i64).unwrap_or(0);
    let is_subagent = v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);
    let project = v.get("cwd").and_then(Value::as_str).and_then(project_name);
    Some(TurnRow {
        uuid,
        session_id,
        ts,
        duration_ms,
        message_count,
        is_subagent,
        project,
    })
}

/// Count `git commit` / `git push` invocations in an assistant message's Bash
/// tool_use blocks. Reads `block.input.command` ONLY to classify — the command
/// text is never stored, only these two counters (privacy contract). A single
/// Bash call may chain `git add && git commit && git push`, so each is counted
/// independently.
fn extract_git_ops(msg: &Value) -> (i64, i64) {
    let Some(content) = msg.get("content").and_then(Value::as_array) else {
        return (0, 0);
    };
    let (mut commits, mut pushes) = (0i64, 0i64);
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        if block.get("name").and_then(Value::as_str) != Some("Bash") {
            continue;
        }
        let Some(cmd) = block
            .get("input")
            .and_then(|i| i.get("command"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if is_git_op(cmd, "commit") {
            commits += 1;
        }
        if is_git_op(cmd, "push") {
            pushes += 1;
        }
    }
    (commits, pushes)
}

/// True when `cmd` runs `git <op>` (e.g. `git commit`, `&& git commit`).
/// Deliberately conservative: substring `"git <op>"` after normalising
/// whitespace. We never keep `cmd` itself — only the resulting count.
fn is_git_op(cmd: &str, op: &str) -> bool {
    let norm = cmd.split_whitespace().collect::<Vec<_>>().join(" ");
    norm.contains(&format!("git {op}"))
}

/// Tool-use blocks in an assistant message, grouped by tool name (preserving
/// occurrence order — first-seen wins for tie-breaking). Empty when the
/// message had no `tool_use` blocks (text-only reply).
fn extract_tool_uses(msg: &Value) -> Vec<(String, i64)> {
    let Some(content) = msg.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    // Small vec is fine — a single assistant turn rarely emits more than a
    // handful of distinct tool kinds. Linear scan keeps insertion order.
    let mut out: Vec<(String, i64)> = Vec::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(name) = block.get("name").and_then(Value::as_str) else {
            continue;
        };
        if let Some(entry) = out.iter_mut().find(|(n, _)| n == name) {
            entry.1 += 1;
        } else {
            out.push((name.to_string(), 1));
        }
    }
    out
}

/// Project label from a working directory: the last path component of a `cwd`
/// like `D:\projects\app` or `/home/u/app` → `app`. None if empty.
fn project_name(cwd: &str) -> Option<String> {
    let name = cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Resolve the Claude config directory: `CLAUDE_CONFIG_DIR` if set, else
/// `~/.claude` (via USERPROFILE on Windows, HOME elsewhere).
pub fn claude_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".claude"))
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Parse one transcript file into its three concerns in a single pass: assistant
/// lines → `CcUsageRow`, user lines → `ToolResultRow`(s), system turn_duration
/// lines → `TurnRow`. Each line is JSON-parsed once via the typed dispatch
/// (parse_line / parse_tool_results / parse_turn_line short-circuit on `type`).
fn parse_file(path: &Path) -> ParsedFile {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return ParsedFile::default(),
    };
    // Files named `agent-<uuid>.jsonl` only hold subagent turns. Use that as a
    // fallback when individual lines lack the `isSidechain` / `agentName` flags
    // (older Claude Code transcripts).
    let from_agent_file = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("agent-"))
        .unwrap_or(false);
    let reader = BufReader::new(file);
    let mut parsed = ParsedFile::default();
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        if let Some(mut row) = parse_line(&line) {
            if from_agent_file {
                row.is_subagent = true;
            }
            parsed.usage.push(row);
            continue; // an assistant line can't also be a user / system line
        }
        if let Some(mut turn) = parse_turn_line(&line) {
            if from_agent_file {
                turn.is_subagent = true;
            }
            parsed.turns.push(turn);
            continue;
        }
        // Non-assistant, non-turn line — may be a user line carrying tool_results.
        let results = parse_tool_results(&line);
        if !results.is_empty() {
            parsed.tool_results.extend(results);
        }
    }
    parsed
}

/// Incrementally ingest all transcripts under `base/projects`. Files whose size
/// and mtime are unchanged since last ingest are skipped; changed files are
/// re-parsed and dedup-inserted by message id. Returns rows newly inserted.
pub fn ingest(base: &Path, db: &StatsDb) -> Result<usize, String> {
    let projects = base.join("projects");
    if !projects.exists() {
        return Ok(0);
    }
    let mut files = Vec::new();
    collect_jsonl(&projects, &mut files);

    let mut inserted = 0usize;
    for path in files {
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len() as i64;
        let mtime: String = meta
            .modified()
            .ok()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        let path_str = path.to_string_lossy().to_string();

        if let Ok(Some((prev_size, prev_mtime))) = db.cc_file_state(&path_str) {
            if prev_size == size && prev_mtime == mtime {
                continue; // unchanged since last ingest
            }
        }

        let parsed = parse_file(&path);
        // `inserted` reports only newly-inserted usage rows (what the UI shows as
        // "ingested"); tool-results and turns are stored but not counted there.
        if !parsed.usage.is_empty() {
            inserted += db.cc_upsert(&parsed.usage).map_err(|e| e.to_string())?;
        }
        if !parsed.tool_results.is_empty() {
            db.cc_tool_result_upsert(&parsed.tool_results)
                .map_err(|e| e.to_string())?;
        }
        if !parsed.turns.is_empty() {
            db.cc_turn_upsert(&parsed.turns).map_err(|e| e.to_string())?;
        }
        db.cc_set_file_state(&path_str, size, &mtime)
            .map_err(|e| e.to_string())?;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pricing_by_family() {
        // 1M input + 1M output, no cache.
        assert!((cost_for("claude-fable-5", 1_000_000, 1_000_000, 0, 0) - 60.0).abs() < 1e-6);
        assert!((cost_for("claude-opus-4-7", 1_000_000, 1_000_000, 0, 0) - 30.0).abs() < 1e-6);
        assert!((cost_for("claude-sonnet-4-5", 1_000_000, 1_000_000, 0, 0) - 18.0).abs() < 1e-6);
        assert!((cost_for("claude-haiku-4-5", 1_000_000, 1_000_000, 0, 0) - 6.0).abs() < 1e-6);
        // unknown model → 0
        assert_eq!(cost_for("mystery-model", 1_000_000, 0, 0, 0), 0.0);
    }

    #[test]
    fn cache_multipliers() {
        // opus input price 5/MTok: cache_create ×1.25 = 6.25, cache_read ×0.1 = 0.5
        let c = cost_for("claude-opus-4-7", 0, 0, 1_000_000, 1_000_000);
        assert!((c - (6.25 + 0.5)).abs() < 1e-6);
    }

    #[test]
    fn parse_valid_assistant_line() {
        let line = r#"{"type":"assistant","timestamp":"2026-05-27T13:57:29.299Z","sessionId":"sess-1","message":{"id":"msg-1","model":"claude-opus-4-7","usage":{"input_tokens":6,"output_tokens":659,"cache_creation_input_tokens":13008,"cache_read_input_tokens":21759}}}"#;
        let row = parse_line(line).expect("should parse");
        assert_eq!(row.message_id, "msg-1");
        assert_eq!(row.model, "claude-opus-4-7");
        assert_eq!(row.input, 6);
        assert_eq!(row.output, 659);
        assert_eq!(row.cache_create, 13008);
        assert_eq!(row.cache_read, 21759);
        assert_eq!(row.session_id.as_deref(), Some("sess-1"));
        assert!(row.cost > 0.0);
    }

    #[test]
    fn skips_synthetic_and_non_assistant() {
        let synthetic = r#"{"type":"assistant","timestamp":"t","message":{"id":"x","model":"<synthetic>","usage":{"input_tokens":1,"output_tokens":1}}}"#;
        assert!(parse_line(synthetic).is_none());

        let user = r#"{"type":"user","timestamp":"t","message":{"role":"user"}}"#;
        assert!(parse_line(user).is_none());

        let no_usage = r#"{"type":"assistant","timestamp":"t","message":{"id":"x","model":"claude-opus-4-7"}}"#;
        assert!(parse_line(no_usage).is_none());

        let empty_tokens = r#"{"type":"assistant","timestamp":"t","message":{"id":"x","model":"claude-opus-4-7","usage":{"input_tokens":0,"output_tokens":0}}}"#;
        assert!(parse_line(empty_tokens).is_none());
    }

    #[test]
    fn missing_cache_fields_default_zero() {
        let line = r#"{"type":"assistant","timestamp":"t","message":{"id":"m","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":200}}}"#;
        let row = parse_line(line).unwrap();
        assert_eq!(row.cache_create, 0);
        assert_eq!(row.cache_read, 0);
        assert_eq!(row.input, 100);
    }

    // --- service_tier ---

    #[test]
    fn parse_line_extracts_service_tier() {
        let line = r#"{"type":"assistant","timestamp":"t","sessionId":"s1","message":{"id":"m","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5,"service_tier":"standard"}}}"#;
        let row = parse_line(line).unwrap();
        assert_eq!(row.service_tier.as_deref(), Some("standard"));
    }

    #[test]
    fn parse_line_service_tier_absent_is_none() {
        let line = r#"{"type":"assistant","timestamp":"t","message":{"id":"m","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        assert!(parse_line(line).unwrap().service_tier.is_none());
    }

    // --- tool_result parsing ---

    #[test]
    fn parse_tool_results_reads_is_error_flag() {
        let line = r#"{"type":"user","timestamp":"t","sessionId":"s1","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"tu_ok","is_error":false,"content":"ok"},
            {"type":"tool_result","tool_use_id":"tu_err","is_error":true,"content":"boom"}
        ]}}"#;
        let rows = parse_tool_results(line);
        assert_eq!(rows.len(), 2);
        let err = rows.iter().find(|r| r.tool_use_id == "tu_err").unwrap();
        assert!(err.is_error);
        let ok = rows.iter().find(|r| r.tool_use_id == "tu_ok").unwrap();
        assert!(!ok.is_error);
        assert_eq!(ok.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn parse_tool_results_missing_is_error_defaults_false() {
        let line = r#"{"type":"user","timestamp":"t","message":{"content":[
            {"type":"tool_result","tool_use_id":"tu1","content":"ok"}
        ]}}"#;
        let rows = parse_tool_results(line);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].is_error);
    }

    #[test]
    fn parse_tool_results_ignores_non_user_and_string_content() {
        // assistant line → empty
        assert!(parse_tool_results(r#"{"type":"assistant","timestamp":"t","message":{"id":"m","model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1}}}"#).is_empty());
        // user line with plain string content (no tool_result) → empty, no panic
        assert!(parse_tool_results(r#"{"type":"user","timestamp":"t","message":{"content":"hello"}}"#).is_empty());
    }

    // --- turn_duration parsing ---

    #[test]
    fn parse_turn_line_extracts_fields() {
        let line = r#"{"type":"system","subtype":"turn_duration","durationMs":365504,"messageCount":350,"timestamp":"2026-06-10T09:16:35.916Z","uuid":"u-1","isSidechain":false,"cwd":"C:\\Users\\x\\my-proj","sessionId":"s-1"}"#;
        let turn = parse_turn_line(line).unwrap();
        assert_eq!(turn.uuid, "u-1");
        assert_eq!(turn.duration_ms, 365504);
        assert_eq!(turn.message_count, 350);
        assert_eq!(turn.session_id.as_deref(), Some("s-1"));
        assert!(!turn.is_subagent);
        assert_eq!(turn.project.as_deref(), Some("my-proj"));
    }

    #[test]
    fn parse_turn_line_rejects_zero_duration_and_non_system() {
        let zero = r#"{"type":"system","subtype":"turn_duration","durationMs":0,"uuid":"u","timestamp":"t"}"#;
        assert!(parse_turn_line(zero).is_none());
        let other = r#"{"type":"assistant","message":{"id":"m"}}"#;
        assert!(parse_turn_line(other).is_none());
        let wrong_subtype = r#"{"type":"system","subtype":"other","durationMs":5,"uuid":"u","timestamp":"t"}"#;
        assert!(parse_turn_line(wrong_subtype).is_none());
    }

    #[test]
    fn parse_turn_line_subagent_flag() {
        let line = r#"{"type":"system","subtype":"turn_duration","durationMs":100,"uuid":"u","timestamp":"t","isSidechain":true}"#;
        assert!(parse_turn_line(line).unwrap().is_subagent);
    }

    // --- git op detection ---

    #[test]
    fn extract_git_ops_counts_commit_and_push() {
        let chained = serde_json::json!({
            "content": [
                {"type":"tool_use","name":"Bash","input":{"command":"git add -A && git commit -m x && git push"}}
            ]
        });
        assert_eq!(extract_git_ops(&chained), (1, 1));

        let amend = serde_json::json!({
            "content": [
                {"type":"tool_use","name":"Bash","input":{"command":"git commit --amend"}}
            ]
        });
        assert_eq!(extract_git_ops(&amend), (1, 0));

        let no_bash = serde_json::json!({
            "content": [
                {"type":"tool_use","name":"Edit","input":{"file_path":"a.rs"}}
            ]
        });
        assert_eq!(extract_git_ops(&no_bash), (0, 0));

        let non_git_bash = serde_json::json!({
            "content": [
                {"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}
            ]
        });
        assert_eq!(extract_git_ops(&non_git_bash), (0, 0));
    }

    #[test]
    fn parse_line_fills_git_counters() {
        let line = r#"{"type":"assistant","timestamp":"t","message":{"id":"m","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[
            {"type":"tool_use","name":"Bash","input":{"command":"git commit -m 'wip' && git push origin main"}}
        ]}}"#;
        let row = parse_line(line).unwrap();
        assert_eq!(row.git_commits, 1);
        assert_eq!(row.git_pushes, 1);
    }
}
