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

use crate::stats::{CcUsageRow, StatsDb};

/// Per-million-token prices (input, output) in USD. Cache-write is input×1.25,
/// cache-read is input×0.1 (Anthropic's published multipliers). Matched by model
/// family substring so new point releases (opus-4-7, opus-4-8…) keep working.
fn price_per_mtok(model: &str) -> Option<(f64, f64)> {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        Some((15.0, 75.0))
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
    })
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

fn parse_file(path: &Path) -> Vec<CcUsageRow> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
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
    let mut rows = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        if let Some(mut row) = parse_line(&line) {
            if from_agent_file {
                row.is_subagent = true;
            }
            rows.push(row);
        }
    }
    rows
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

        let rows = parse_file(&path);
        if !rows.is_empty() {
            inserted += db.cc_upsert(&rows).map_err(|e| e.to_string())?;
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
        assert!((cost_for("claude-opus-4-7", 1_000_000, 1_000_000, 0, 0) - 90.0).abs() < 1e-6);
        assert!((cost_for("claude-sonnet-4-5", 1_000_000, 1_000_000, 0, 0) - 18.0).abs() < 1e-6);
        assert!((cost_for("claude-haiku-4-5", 1_000_000, 1_000_000, 0, 0) - 6.0).abs() < 1e-6);
        // unknown model → 0
        assert_eq!(cost_for("mystery-model", 1_000_000, 0, 0, 0), 0.0);
    }

    #[test]
    fn cache_multipliers() {
        // opus input price 15/MTok: cache_create ×1.25 = 18.75, cache_read ×0.1 = 1.5
        let c = cost_for("claude-opus-4-7", 0, 0, 1_000_000, 1_000_000);
        assert!((c - (18.75 + 1.5)).abs() < 1e-6);
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
}
