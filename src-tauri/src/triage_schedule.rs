//! In-app scheduler for the nightly task triage (#35).
//!
//! The tracker lives in the tray, so rather than register an OS scheduled task we
//! keep a tiny loop (see `spawn_triage_scheduler` in lib.rs) that, once a day at a
//! user-set local time, runs ONE triage pass. Catch-up is automatic: a run missed
//! while the app was closed fires when the app next opens past the scheduled time
//! (we gate on "last completed run date != today", not on an exact tick).
//!
//! The pass is deterministic on both ends, with the LLM only in the middle:
//!   1. WE export the board (`cli.mjs todos list --json`) to a staging file.
//!   2. A HEADLESS `claude -p` reads that file and WRITES a digest JSON — its only
//!      tools are `Read` and `Write` (no shell, no network), so it cannot touch the
//!      board and cannot stall on an interactive permission prompt.
//!   3. WE publish the digest the agent wrote (`cli.mjs triage publish`).
//! Steps 1 and 3 are plain CLI calls we make ourselves, so a weak/cheap model that
//! reliably reads-a-file-and-writes-a-file is enough — the fragile "remember to run
//! the publish command" step is no longer the model's job. The existing triage
//! watcher surfaces the published `triage-digest.json`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// The triage prompt template, baked into the binary. `<CLI>` and `<STAGING>` are
/// substituted with real absolute paths at run time. Mirrors scripts/triage-prompt.md.
const PROMPT_TEMPLATE: &str = include_str!("../../scripts/triage-prompt.md");

/// Models offered for the nightly run. Haiku is the default — a daily automated
/// job kept cheap. Keep in lockstep with the model `<select>` in TodoWindow.vue.
const MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];

fn default_time() -> String {
    "08:00".to_string()
}
fn default_model() -> String {
    "haiku".to_string()
}

/// User-facing config + last-run bookkeeping, persisted next to the board as
/// `triage-schedule.json`. Forgiving on read so a missing/partial file just yields
/// the defaults (disabled, 08:00, haiku).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_time")]
    pub time: String, // "HH:MM", local wall-clock
    #[serde(default = "default_model")]
    pub model: String,
    /// Local date ("YYYY-MM-DD") of the last completed scheduled run. Drives
    /// once-a-day + catch-up; `None` until the first run.
    #[serde(default)]
    pub last_run: Option<String>,
    /// Outcome of the last run for the UI: `None`/empty on success, else the error.
    #[serde(default)]
    pub last_error: Option<String>,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            time: default_time(),
            model: default_model(),
            last_run: None,
            last_error: None,
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("triage-schedule.json")
}

/// Read the config; a missing or malformed file yields defaults.
pub fn load(data_dir: &Path) -> ScheduleConfig {
    std::fs::read_to_string(config_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write the config atomically (temp + rename), matching the rest of the app.
pub fn save(data_dir: &Path, cfg: &ScheduleConfig) -> Result<(), String> {
    let p = config_path(data_dir);
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Validate/normalize "HH:MM" (also accepts "H:MM") to zero-padded "HH:MM".
/// Returns None on anything out of range, so the caller can reject it.
pub fn normalize_time(t: &str) -> Option<String> {
    let mut it = t.trim().split(':');
    let h: u32 = it.next()?.trim().parse().ok()?;
    let m: u32 = it.next()?.trim().parse().ok()?;
    if it.next().is_some() || h > 23 || m > 59 {
        return None;
    }
    Some(format!("{h:02}:{m:02}"))
}

/// Snap a requested model to a known one, defaulting to haiku.
pub fn normalize_model(m: &str) -> String {
    let m = m.trim().to_lowercase();
    if MODELS.contains(&m.as_str()) {
        m
    } else {
        default_model()
    }
}

/// True once the local wall-clock has reached `time` ("HH:MM") today. Combined
/// with the "already ran today?" check, this fires the run once at/after the set
/// time (and catches up a missed slot the moment the app is past it).
pub fn is_due(now: &chrono::DateTime<chrono::Local>, time: &str) -> bool {
    use chrono::Timelike;
    let mut it = time.split(':');
    let h: u32 = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(8);
    let m: u32 = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    now.hour() * 60 + now.minute() >= h * 60 + m
}

/// Locate the `claude` CLI: prefer the per-user install (`~/.local/bin`), then
/// fall back to PATH via `where`. None if it can't be found.
fn resolve_claude(home: &Path) -> Option<PathBuf> {
    let bin = home.join(".local").join("bin");
    for name in ["claude.exe", "claude.cmd", "claude.bat", "claude"] {
        let p = bin.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    let mut cmd = Command::new("where");
    cmd.arg("claude");
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if out.status.success() {
        if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
            let t = first.trim();
            if !t.is_empty() {
                return Some(PathBuf::from(t));
            }
        }
    }
    None
}

/// CreateProcess can't launch a `.cmd`/`.bat` directly — those need cmd.exe. A
/// real `.exe` (the usual native install) is spawned directly.
fn claude_command(claude: &Path) -> Command {
    let ext = claude
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if matches!(ext.as_deref(), Some("cmd") | Some("bat")) {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(claude);
        c
    } else {
        Command::new(claude)
    }
}

/// Locate `node` to run our own `cli.mjs` calls (board export + publish). Prefer
/// PATH via `where`; fall back to a bare `node` (let the OS resolve it). None only
/// if even that can't be constructed — in practice `node` is always present, since
/// the same `cli.mjs` powers the session hook.
fn resolve_node() -> PathBuf {
    let mut cmd = Command::new("where");
    cmd.arg("node");
    no_window(&mut cmd);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let t = first.trim();
                if !t.is_empty() {
                    return PathBuf::from(t);
                }
            }
        }
    }
    PathBuf::from("node")
}

/// Run `node <cli_path> <args…>` to completion, capturing output. Used for the two
/// deterministic CLI steps (export the board, publish the digest) that bracket the
/// headless agent run.
fn run_node(node: &Path, cli_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(node);
    cmd.arg(cli_path).args(args);
    no_window(&mut cmd);
    cmd.output().map_err(|e| format!("failed to run node {cli_path}: {e}"))
}

/// Don't flash a console window when spawning the headless run.
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

fn append_log(log: &Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// Run ONE triage pass, blocking until done (call from a worker thread). Three
/// deterministic steps bracket the LLM (see the module doc): WE export the board,
/// a headless `claude -p` (tools: Read+Write only) reads it and writes a digest to
/// a staging file, then WE publish that digest. `cli_path` is the absolute cc
/// `cli.mjs`. Every run is appended to `triage-runs.log` beside the board.
pub fn run_triage(home: &Path, data_dir: &Path, cli_path: &str, model: &str) -> Result<(), String> {
    let claude = resolve_claude(home)
        .ok_or_else(|| "claude CLI not found (looked in ~/.local/bin and PATH)".to_string())?;
    let node = resolve_node();

    // Staging dir isolated from the board, so a stray Write can't reach todos.json.
    // The agent's whole world is these two files: it READS `board.json` and WRITES
    // `triage-staging.json`.
    let staging_dir = data_dir.join("triage-tmp");
    std::fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;
    let board = staging_dir.join("board.json");
    let staging = staging_dir.join("triage-staging.json");
    let board_s = board.to_string_lossy().replace('\\', "/");
    let staging_s = staging.to_string_lossy().replace('\\', "/");
    let staging_dir_s = staging_dir.to_string_lossy().replace('\\', "/");

    let log = data_dir.join("triage-runs.log");
    let now = chrono::Local::now();
    let stamp = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let today = now.format("%Y-%m-%d").to_string();
    append_log(&log, &format!("\n===== triage run {stamp} (model={model}) ====="));

    // Step 1 — export the board for the agent to read. Deterministic; if this fails
    // there's nothing to triage, so bail before spending a model call.
    let board_out = run_node(&node, cli_path, &["todos", "list", "--json"])?;
    if !board_out.status.success() {
        let err = String::from_utf8_lossy(&board_out.stderr);
        append_log(&log, &format!("[board export failed] {err}"));
        return Err(format!("failed to export board (todos list): {}", err.trim()));
    }
    std::fs::write(&board, &board_out.stdout)
        .map_err(|e| format!("failed to write board.json: {e}"))?;
    // Old digest from a previous run must not be mistaken for this run's output.
    let _ = std::fs::remove_file(&staging);

    // Step 2 — the headless agent: Read board.json, Write the digest. Read+Write are
    // its ONLY tools, so it can't mutate the board and never hits an interactive
    // permission prompt (the failure mode of giving it a shell command to run).
    let prompt = PROMPT_TEMPLATE
        .replace("<BOARD>", &board_s)
        .replace("<STAGING>", &staging_s)
        .replace("<TODAY>", &today);

    let mut cmd = claude_command(&claude);
    cmd.args([
        "-p",
        "--model",
        model,
        "--add-dir",
        &staging_dir_s,
        "--allowedTools",
        "Read",
        "Write",
    ])
    // Neutral cwd: the prompt uses absolute paths, and running outside any repo
    // avoids a project SessionStart hook injecting unrelated phase context.
    .current_dir(data_dir)
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch claude: {e}"))?;
    // The prompt (~a few KB) fits the OS pipe buffer, so write-then-wait can't
    // deadlock. Dropping stdin closes it so `claude -p` starts.
    if let Some(mut sin) = child.stdin.take() {
        use std::io::Write;
        let _ = sin.write_all(prompt.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    append_log(&log, &String::from_utf8_lossy(&out.stdout));
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.trim().is_empty() {
        append_log(&log, &format!("[stderr] {stderr}"));
    }
    let code = out.status.code().unwrap_or(-1);
    append_log(&log, &format!("----- agent exit {code} -----"));
    if !out.status.success() {
        return Err(format!("claude exited with code {code} (see triage-runs.log)"));
    }
    if !staging.exists() {
        return Err("agent produced no digest (triage-staging.json missing)".to_string());
    }

    // Step 3 — publish the digest the agent wrote. `triage publish` validates the
    // shape and atomically swaps it into triage-digest.json; the watcher takes it
    // from there. A bad/empty digest fails here with a clear message.
    let pub_out = run_node(&node, cli_path, &["triage", "publish", "--file", &staging_s])?;
    append_log(&log, &String::from_utf8_lossy(&pub_out.stdout));
    let pub_err = String::from_utf8_lossy(&pub_out.stderr);
    if !pub_err.trim().is_empty() {
        append_log(&log, &format!("[publish stderr] {pub_err}"));
    }
    if pub_out.status.success() {
        append_log(&log, "----- published -----");
        Ok(())
    } else {
        Err(format!("triage publish failed: {}", pub_err.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_time_pads_and_validates() {
        assert_eq!(normalize_time("8:00").as_deref(), Some("08:00"));
        assert_eq!(normalize_time("08:5").as_deref(), Some("08:05"));
        assert_eq!(normalize_time("23:59").as_deref(), Some("23:59"));
        assert_eq!(normalize_time("24:00"), None);
        assert_eq!(normalize_time("8:60"), None);
        assert_eq!(normalize_time("8"), None);
        assert_eq!(normalize_time("8:00:00"), None);
    }

    #[test]
    fn normalize_model_snaps_to_known() {
        assert_eq!(normalize_model("Sonnet"), "sonnet");
        assert_eq!(normalize_model("opus"), "opus");
        assert_eq!(normalize_model("gpt"), "haiku");
        assert_eq!(normalize_model(""), "haiku");
    }

    #[test]
    fn is_due_after_time() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 6, 24, 9, 30, 0).unwrap();
        assert!(is_due(&now, "08:00"));
        assert!(is_due(&now, "09:30"));
        assert!(!is_due(&now, "09:31"));
        assert!(!is_due(&now, "10:00"));
    }

    #[test]
    fn config_roundtrips() {
        let dir = std::env::temp_dir().join("cut_triage_sched_test");
        let _ = std::fs::create_dir_all(&dir);
        let cfg = ScheduleConfig {
            enabled: true,
            time: "07:15".into(),
            model: "sonnet".into(),
            last_run: Some("2026-06-24".into()),
            last_error: None,
        };
        save(&dir, &cfg).unwrap();
        let back = load(&dir);
        assert!(back.enabled);
        assert_eq!(back.time, "07:15");
        assert_eq!(back.model, "sonnet");
        assert_eq!(back.last_run.as_deref(), Some("2026-06-24"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_is_default() {
        let dir = std::env::temp_dir().join("cut_triage_sched_missing");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = load(&dir);
        assert!(!cfg.enabled);
        assert_eq!(cfg.time, "08:00");
        assert_eq!(cfg.model, "haiku");
    }
}
