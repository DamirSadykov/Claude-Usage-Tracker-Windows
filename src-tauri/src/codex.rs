//! OpenAI Codex CLI usage ingest. Codex writes local rollout JSONL files under
//! `~/.codex/sessions` (and `archived_sessions`). We retain only token counts,
//! subscription-limit snapshots, model, timestamp, thread id and cwd basename;
//! prompt/response content and auth data are never stored.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::stats::{CcUsageRow, StatsDb};

#[derive(Default)]
struct RolloutContext {
    session_id: Option<String>,
    project: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLimitWindow {
    pub used_percent: f64,
    pub window_minutes: i64,
    pub resets_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    pub observed_at: String,
    pub limit_id: String,
    pub plan_type: Option<String>,
    pub primary: Option<CodexLimitWindow>,
    pub secondary: Option<CodexLimitWindow>,
    pub credits: Option<CodexCredits>,
    pub rate_limit_reached_type: Option<String>,
}

fn parse_limit_window(value: Option<&Value>) -> Option<CodexLimitWindow> {
    let value = value?;
    Some(CodexLimitWindow {
        used_percent: value.get("used_percent")?.as_f64()?,
        window_minutes: value.get("window_minutes")?.as_i64()?,
        resets_at: value.get("resets_at")?.as_i64()?,
    })
}

fn scalar_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn parse_rate_limits_line(line: &str) -> Option<CodexRateLimits> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let limits = payload.get("rate_limits")?;
    let primary = parse_limit_window(limits.get("primary"));
    let secondary = parse_limit_window(limits.get("secondary"));
    if primary.is_none() && secondary.is_none() {
        return None;
    }
    let credits = limits.get("credits").map(|value| CodexCredits {
        has_credits: value
            .get("has_credits")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        unlimited: value
            .get("unlimited")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        balance: scalar_string(value.get("balance")),
    });
    Some(CodexRateLimits {
        observed_at: value.get("timestamp")?.as_str()?.to_string(),
        limit_id: limits
            .get("limit_id")
            .and_then(Value::as_str)
            .unwrap_or("codex")
            .to_string(),
        plan_type: limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary,
        secondary,
        credits,
        rate_limit_reached_type: limits
            .get("rate_limit_reached_type")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn project_name(cwd: &str) -> Option<String> {
    let name = cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Current OpenAI API list prices per million (input, cached input, output).
/// Unknown models remain visible with zero estimated cost.
pub fn price_per_mtok(model: &str) -> Option<(f64, f64, f64)> {
    let m = model.to_ascii_lowercase();
    if m.contains("gpt-5.6-terra") {
        Some((2.0, 0.2, 12.0))
    } else if m.contains("gpt-5.6-luna") {
        Some((0.2, 0.02, 1.2))
    } else if m == "gpt-5.6" || m.contains("gpt-5.6-sol") {
        Some((4.0, 0.4, 20.0))
    } else if m.contains("gpt-5.3-codex") || m.contains("gpt-5.2-codex") || m == "gpt-5.2" {
        Some((1.75, 0.175, 14.0))
    } else {
        None
    }
}

pub fn cost_for(model: &str, input: i64, output: i64, cache_write: i64, cache_read: i64) -> f64 {
    let Some((pin, pcached, pout)) = price_per_mtok(model) else {
        return 0.0;
    };
    let fresh = (input - cache_read - cache_write).max(0) as f64;
    (fresh * pin
        + cache_read as f64 * pcached
        + cache_write as f64 * pin * 1.25
        + output as f64 * pout)
        / 1_000_000.0
}

fn parse_rollout_line(line: &str, ctx: &mut RolloutContext) -> Option<CcUsageRow> {
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = v.get("type").and_then(Value::as_str)?;
    let payload = v.get("payload").unwrap_or(&Value::Null);
    match kind {
        "session_meta" => {
            ctx.session_id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string);
            ctx.project = payload
                .get("cwd")
                .and_then(Value::as_str)
                .and_then(project_name);
            return None;
        }
        "turn_context" => {
            ctx.model = payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(project) = payload
                .get("cwd")
                .and_then(Value::as_str)
                .and_then(project_name)
            {
                ctx.project = Some(project);
            }
            return None;
        }
        "event_msg" if payload.get("type").and_then(Value::as_str) == Some("token_count") => {}
        _ => return None,
    }

    let info = payload.get("info")?;
    let usage = info.get("last_token_usage")?;
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_read = usage
        .get("cached_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_create = usage
        .get("cache_write_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
        return None;
    }
    let ts = v.get("timestamp")?.as_str()?.to_string();
    let model = ctx.model.clone().unwrap_or_else(|| "codex-unknown".into());
    let session = ctx.session_id.clone();
    // `token_count` may repeat the same last-turn snapshot (for example when
    // only rate-limit information changes). The cumulative counters identify
    // that snapshot stably across repeats and file rescans; older events that
    // lack them fall back to their timestamp plus the mutually exclusive
    // token buckets, without an order-dependent sequence number.
    let event_key = if let Some(total) = info.get("total_token_usage") {
        format!(
            "total:{}:{}:{}:{}",
            total
                .get("input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total
                .get("cached_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total
                .get("cache_write_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total
                .get("output_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        )
    } else {
        format!("at:{ts}:{input}:{cache_read}:{cache_create}:{output}")
    };
    let message_id = format!(
        "codex:{}:{event_key}",
        session.as_deref().unwrap_or("unknown")
    );
    Some(CcUsageRow {
        message_id,
        ts,
        model: model.clone(),
        // Existing analytics expects mutually exclusive input/cache buckets.
        input: (input - cache_read - cache_create).max(0),
        output,
        cache_create,
        cache_read,
        cost: cost_for(&model, input, output, cache_create, cache_read),
        session_id: session,
        project: ctx.project.clone(),
        is_subagent: false,
        agent_name: Some("codex".into()),
        agent_id: None,
        tool_uses: Vec::new(),
        service_tier: None,
        git_commits: 0,
        git_pushes: 0,
    })
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|x| x.to_str()) == Some("jsonl")
            && path
                .file_name()
                .and_then(|x| x.to_str())
                .map(|x| x.starts_with("rollout-"))
                .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

/// Latest subscription-limit snapshot emitted by a locally authenticated Codex
/// session. No ChatGPT bearer token or OpenAI Admin key is read or transmitted.
pub fn latest_limits(base: &Path) -> Option<CodexRateLimits> {
    let mut files = Vec::new();
    collect_jsonl(&base.join("sessions"), &mut files);
    collect_jsonl(&base.join("archived_sessions"), &mut files);
    // File mtimes are not reliable here: Codex can flush several rollout
    // files out of order (and an older file may receive the newest event).
    // Select the newest rate-limit event by its own RFC3339 timestamp.
    let mut newest: Option<(DateTime<Utc>, CodexRateLimits)> = None;
    for path in files {
        let Ok(file) = File::open(path) else {
            continue;
        };
        let latest = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| parse_rate_limits_line(&line))
            .last();
        if let Some(snapshot) = latest {
            let Ok(timestamp) = DateTime::parse_from_rfc3339(&snapshot.observed_at) else {
                continue;
            };
            let timestamp = timestamp.with_timezone(&Utc);
            if newest
                .as_ref()
                .map(|(current, _)| timestamp > *current)
                .unwrap_or(true)
            {
                newest = Some((timestamp, snapshot));
            }
        }
    }
    newest.map(|(_, snapshot)| snapshot)
}

pub fn codex_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CODEX_HOME") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".codex"))
}

pub fn ingest(base: &Path, db: &StatsDb) -> Result<usize, String> {
    let mut files = Vec::new();
    collect_jsonl(&base.join("sessions"), &mut files);
    collect_jsonl(&base.join("archived_sessions"), &mut files);
    let mut inserted = 0;
    for path in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        let key = path.to_string_lossy().to_string();
        if matches!(db.cc_file_state(&key), Ok(Some((s, ref m))) if s == size && *m == mtime) {
            continue;
        }
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let mut ctx = RolloutContext::default();
        let rows: Vec<_> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| parse_rollout_line(&line, &mut ctx))
            .collect();
        if !rows.is_empty() {
            inserted += db.cc_upsert(&rows).map_err(|e| e.to_string())?;
        }
        db.cc_set_file_state(&key, size, &mtime)
            .map_err(|e| e.to_string())?;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_usage_and_separates_cached_input() {
        let mut ctx = RolloutContext::default();
        assert!(parse_rollout_line(
            r#"{"type":"session_meta","payload":{"id":"s1","cwd":"D:\\work\\app"}}"#,
            &mut ctx
        )
        .is_none());
        assert!(parse_rollout_line(
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            &mut ctx
        )
        .is_none());
        let row = parse_rollout_line(r#"{"type":"event_msg","timestamp":"2026-09-03T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":10,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":5}}}}"#, &mut ctx).unwrap();
        assert_eq!(row.session_id.as_deref(), Some("s1"));
        assert_eq!(row.project.as_deref(), Some("app"));
        assert_eq!(
            (row.input, row.cache_read, row.cache_create, row.output),
            (30, 60, 10, 20)
        );
        assert!(row.cost > 0.0);
    }

    #[test]
    fn repeated_last_usage_snapshot_has_one_stable_identity() {
        let mut ctx = RolloutContext::default();
        parse_rollout_line(r#"{"type":"session_meta","payload":{"id":"s1"}}"#, &mut ctx);
        let first = parse_rollout_line(r#"{"type":"event_msg","timestamp":"2026-09-03T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20}}}}"#, &mut ctx).unwrap();
        let repeated = parse_rollout_line(r#"{"type":"event_msg","timestamp":"2026-09-03T10:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20}}}}"#, &mut ctx).unwrap();
        assert_eq!(first.message_id, repeated.message_id);
    }

    #[test]
    fn ignores_cumulative_usage_and_content_events() {
        let mut ctx = RolloutContext::default();
        let line = r#"{"type":"event_msg","timestamp":"t","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":99}}}}"#;
        assert!(parse_rollout_line(line, &mut ctx).is_none());
        assert!(parse_rollout_line(
            r#"{"type":"response_item","payload":{"type":"message","content":"secret"}}"#,
            &mut ctx
        )
        .is_none());
    }

    #[test]
    fn parses_codex_subscription_windows_without_auth_data() {
        let limits = parse_rate_limits_line(
            r#"{"timestamp":"2026-09-04T03:31:43Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":4.0,"window_minutes":300,"resets_at":1788510606},"secondary":{"used_percent":16.0,"window_minutes":10080,"resets_at":1789058710},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus","rate_limit_reached_type":null}}}"#,
        )
        .unwrap();
        assert_eq!(limits.plan_type.as_deref(), Some("plus"));
        assert_eq!(limits.primary.unwrap().window_minutes, 300);
        assert_eq!(limits.secondary.unwrap().used_percent, 16.0);
        assert_eq!(limits.credits.unwrap().balance, "0");
    }
}
