//! In-app scheduler for the nightly task triage (#35).
//!
//! The tracker lives in the tray, so rather than register an OS scheduled task we
//! keep a tiny loop (see `spawn_triage_scheduler` in lib.rs) that, once a day at a
//! user-set local time, runs ONE triage pass. Catch-up is automatic: a run missed
//! while the app was closed fires when the app next opens past the scheduled time
//! (we gate on "last completed run date != today", not on an exact tick).
//!
//! The pass is deterministic on both ends, with the LLM only in the middle:
//!   1. WE export compact, ready-fact extracts into a staging directory.
//!   2. A HEADLESS `claude -p` reads each worthwhile part and writes its part digest;
//!      its only tools are `Read` and `Write` (no shell, no network), so it cannot
//!      touch the board or stall on an interactive permission prompt.
//!   3. WE publish the directory (`cli.mjs triage publish --dir`), assembling facts
//!      and every successfully written part digest.
//! Steps 1 and 3 are plain CLI calls we make ourselves, so a weak/cheap model that
//! reliably reads-a-file-and-writes-a-file is enough — the fragile "remember to run
//! the publish command" step is no longer the model's job. The existing triage
//! watcher surfaces the published `triage-digest.json`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// The triage prompt template, baked into the binary. Its part-specific placeholders
/// are substituted with absolute paths and unit details at run time.
const PROMPT_TEMPLATE: &str = include_str!("../../../scripts/triage-prompt.md");

/// Models offered for the nightly run. Haiku is the default — a daily automated
/// job kept cheap. Explicit ids, as in the agent profiles. Keep in lockstep with
/// the model `<select>` in SettingsPanel.vue.
const MODELS: [&str; 3] = [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
];

fn default_time() -> String {
    "08:00".to_string()
}
fn default_model() -> String {
    MODELS[0].to_string()
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

/// The effective audit prompt and whether it's a user override, for the settings
/// editor. `text` is what a run would actually use (custom file or baked default).
#[derive(Debug, Clone, Serialize)]
pub struct PromptInfo {
    pub text: String,
    pub is_custom: bool,
}

/// Path to the user's custom prompt override, beside the board. When present and
/// non-empty it replaces the baked-in template for every run.
fn prompt_path(data_dir: &Path) -> PathBuf {
    data_dir.join("triage-prompt.md")
}

/// Effective prompt + whether it's a user override. A missing, empty, or unreadable
/// override falls back to the baked default, so a bad edit can never wedge a run.
pub fn load_prompt(data_dir: &Path) -> (String, bool) {
    if let Ok(s) = std::fs::read_to_string(prompt_path(data_dir)) {
        if !s.trim().is_empty() {
            return (s, true);
        }
    }
    (PROMPT_TEMPLATE.to_string(), false)
}

/// Write a custom prompt override atomically (temp + rename).
pub fn save_prompt(data_dir: &Path, text: &str) -> Result<(), String> {
    let p = prompt_path(data_dir);
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Drop the override, reverting to the baked default. Idempotent (missing = ok).
pub fn reset_prompt(data_dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(prompt_path(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read the config; a missing or malformed file yields defaults.
pub fn load(data_dir: &Path) -> ScheduleConfig {
    let mut cfg: ScheduleConfig = std::fs::read_to_string(config_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    cfg.model = normalize_model(&cfg.model);
    cfg
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

/// Snap a requested model to a known id; the old `haiku/sonnet/opus` aliases map
/// to their ids, anything else falls back to the default.
pub fn normalize_model(m: &str) -> String {
    let m = m.trim().to_lowercase();
    match m.as_str() {
        "haiku" => MODELS[0].to_string(),
        "sonnet" => MODELS[1].to_string(),
        "opus" => MODELS[2].to_string(),
        _ if MODELS.contains(&m.as_str()) => m,
        _ => default_model(),
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

/// Locate `node` to run our own `cli.mjs` calls (extract export + publish). Prefer
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
/// deterministic CLI steps (export the extract, publish the digest) that bracket the
/// headless agent run.
fn run_node(node: &Path, cli_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(node);
    cmd.arg(cli_path).args(args);
    no_window(&mut cmd);
    cmd.output()
        .map_err(|e| format!("failed to run node {cli_path}: {e}"))
}

/// Recompute the user-corrections metric (task t#101) across all projects and
/// write `corrections-metrics.json` — deterministic, LLM-free, just
/// `node cli.mjs corrections publish --all`. `--all` because `run_node` sets no
/// cwd, so a bare `publish` would scope to the app process's working dir instead
/// of a project. Used by the in-app "refresh" button on the outcome card.
pub fn run_corrections_publish(cli_path: &str) -> Result<(), String> {
    let node = resolve_node();
    let out = run_node(&node, cli_path, &["corrections", "publish", "--all"])?;
    if !out.status.success() {
        return Err(format!(
            "corrections publish failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Recompute the session→task attribution (t#87) across all projects and write
/// `task-attribution.json` — deterministic, LLM-free, just
/// `node cli.mjs task-cost publish --all`. Same shape as the corrections publish
/// above; the app joins the file with per-session token totals (task_cost.rs).
pub fn run_task_cost_publish(cli_path: &str) -> Result<(), String> {
    let node = resolve_node();
    let out = run_node(&node, cli_path, &["task-cost", "publish", "--all"])?;
    if !out.status.success() {
        return Err(format!(
            "task-cost publish failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
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

/// The small, stable portion of `units.json` the scheduler needs.  Keeping this
/// deliberately narrower than the CLI's export format means adding diagnostics
/// to the index cannot make an installed scheduler reject an otherwise valid run.
#[derive(Debug, Deserialize)]
struct TriageUnitsIndex {
    units: Vec<TriageUnit>,
}

#[derive(Debug, Deserialize)]
struct TriageUnit {
    name: String,
    #[serde(default)]
    projects: Vec<String>,
    file: String,
    digest: String,
    agent: bool,
}

fn read_units_index(path: &Path) -> Result<TriageUnitsIndex, String> {
    let body = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&body).map_err(|e| format!("cannot parse {}: {e}", path.display()))
}

/// Run ONE triage pass, blocking until done (call from a worker thread). The CLI
/// first exports parts, then one agent reviews each worthwhile part, and finally
/// the CLI assembles every available part digest. `cli_path` is the absolute cc
/// `cli.mjs`. Every run is appended to `triage-runs.log` beside the board.
pub fn run_triage(home: &Path, data_dir: &Path, cli_path: &str, model: &str) -> Result<(), String> {
    let node = resolve_node();

    // Staging dir isolated from the board. Each agent gets exactly one exported
    // part to read and one adjacent digest file to write.
    let staging_dir = data_dir.join("triage-tmp");
    std::fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;
    let staging_dir_s = staging_dir.to_string_lossy().replace('\\', "/");

    let log = data_dir.join("triage-runs.log");
    let now = chrono::Local::now();
    let stamp = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let today = now.format("%Y-%m-%d").to_string();
    append_log(
        &log,
        &format!("\n===== triage run {stamp} (model={model}) ====="),
    );

    // Step 1 — export compact, manually grouped parts. `--today` pins the
    // deterministic facts; without this index there is nothing to review.
    let board_out = run_node(
        &node,
        cli_path,
        &[
            "triage",
            "export",
            "--today",
            &today,
            "--out-dir",
            &staging_dir_s,
        ],
    )?;
    if !board_out.status.success() {
        let err = String::from_utf8_lossy(&board_out.stderr);
        append_log(&log, &format!("[board export failed] {err}"));
        return Err(format!(
            "failed to export board (triage export): {}",
            err.trim()
        ));
    }
    append_log(&log, &String::from_utf8_lossy(&board_out.stdout));

    let index = read_units_index(&staging_dir.join("units.json"))?;
    // Do this ourselves as well as relying on export's cleanup: a stale digest
    // must never be publishable if export's cleanup changes in a future CLI.
    for entry in std::fs::read_dir(&staging_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .ends_with(".digest.json")
        {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }

    let (template, _is_custom) = load_prompt(data_dir);
    let agent_total = index.units.iter().filter(|u| u.agent).count();
    let claude = if agent_total > 0 {
        resolve_claude(home)
    } else {
        None
    };
    let mut agent_successes = 0;
    let mut undiscarded = Vec::new();
    for unit in index.units.into_iter().filter(|u| u.agent) {
        let Some(claude) = claude.as_deref() else {
            append_log(
                &log,
                &format!(
                    "[unit {} failed] claude CLI not found (looked in ~/.local/bin and PATH)",
                    unit.name
                ),
            );
            continue;
        };
        let board = staging_dir.join(&unit.file);
        let digest = staging_dir.join(&unit.digest);
        let board_s = board.to_string_lossy().replace('\\', "/");
        let digest_s = digest.to_string_lossy().replace('\\', "/");
        let unit_label = if unit.projects.is_empty() {
            unit.name.clone()
        } else {
            format!("{} (проекты: {})", unit.name, unit.projects.join(", "))
        };
        let prompt = template
            .replace("<BOARD>", &board_s)
            .replace("<STAGING>", &digest_s)
            .replace("<TODAY>", &today)
            .replace("<UNIT>", &unit_label);

        let mut cmd = claude_command(claude);
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
        .current_dir(data_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        no_window(&mut cmd);

        let outcome = (|| -> Result<(), String> {
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("failed to launch claude: {e}"))?;
            if let Some(mut sin) = child.stdin.take() {
                use std::io::Write;
                sin.write_all(prompt.as_bytes())
                    .map_err(|e| e.to_string())?;
            }
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            append_log(&log, &String::from_utf8_lossy(&out.stdout));
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.trim().is_empty() {
                append_log(&log, &format!("[{} stderr] {stderr}", unit.name));
            }
            if !out.status.success() {
                return Err(format!(
                    "claude exited with code {}",
                    out.status.code().unwrap_or(-1)
                ));
            }
            if !digest.is_file() {
                return Err(format!("agent produced no digest ({})", unit.digest));
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                agent_successes += 1;
                append_log(
                    &log,
                    &format!("----- {} published for assembly -----", unit.name),
                );
            }
            Err(err) => {
                if digest.is_file() {
                    if let Err(remove_err) = std::fs::remove_file(&digest) {
                        undiscarded.push(unit.name.clone());
                        append_log(
                            &log,
                            &format!(
                                "[unit {} failed] could not discard {}: {remove_err}",
                                unit.name,
                                digest.display()
                            ),
                        );
                    }
                }
                append_log(&log, &format!("[unit {} failed] {err}", unit.name));
            }
        }
    }

    if !undiscarded.is_empty() {
        return Err(format!(
            "failed parts left digests that could not be removed ({}); not publishing",
            undiscarded.join(", ")
        ));
    }

    // Step 3 — assemble facts plus all part digests that made it through step 2.
    let pub_out = run_node(
        &node,
        cli_path,
        &["triage", "publish", "--dir", &staging_dir_s],
    )?;
    append_log(&log, &String::from_utf8_lossy(&pub_out.stdout));
    let pub_err = String::from_utf8_lossy(&pub_out.stderr);
    if !pub_err.trim().is_empty() {
        append_log(&log, &format!("[publish stderr] {pub_err}"));
    }
    if pub_out.status.success() {
        append_log(&log, "----- published -----");
        if agent_total > 0 && agent_successes == 0 {
            Err("all triage agent parts failed (see triage-runs.log)".to_string())
        } else {
            Ok(())
        }
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
        assert_eq!(normalize_model("claude-opus-5-5"), "claude-opus-5-5");
        assert_eq!(normalize_model("gpt"), "claude-haiku-4-5-20251001");
        assert_eq!(normalize_model(""), "claude-haiku-4-5-20251001");
    }

    #[test]
    fn normalize_model_translates_old_aliases() {
        assert_eq!(normalize_model("haiku"), "claude-haiku-4-5-20251001");
        assert_eq!(normalize_model("Sonnet"), "claude-sonnet-5-5");
        assert_eq!(normalize_model("opus"), "claude-opus-5-5");
    }

    #[test]
    fn is_due_after_time() {
        use chrono::TimeZone;
        let now = chrono::Local
            .with_ymd_and_hms(2026, 6, 24, 9, 30, 0)
            .unwrap();
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
            model: "claude-sonnet-5-5".into(),
            last_run: Some("2026-06-24".into()),
            last_error: None,
        };
        save(&dir, &cfg).unwrap();
        let back = load(&dir);
        assert!(back.enabled);
        assert_eq!(back.time, "07:15");
        assert_eq!(back.model, "claude-sonnet-5-5");
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
        assert_eq!(cfg.model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn units_index_reads_only_scheduler_fields() {
        let dir = std::env::temp_dir().join("cut_triage_units_index_test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("units.json");
        std::fs::write(
            &path,
            r#"{
                "today": "2026-10-01",
                "units": [{
                    "name": "Core",
                    "projects": ["tracker", "cli"],
                    "file": "unit-1.json",
                    "digest": "unit-1.digest.json",
                    "agent": true,
                    "tasks": 3,
                    "facts": 1
                }]
            }"#,
        )
        .unwrap();

        let index = read_units_index(&path).unwrap();
        assert_eq!(index.units.len(), 1);
        let unit = &index.units[0];
        assert_eq!(unit.name, "Core");
        assert_eq!(unit.projects, ["tracker", "cli"]);
        assert_eq!(unit.file, "unit-1.json");
        assert_eq!(unit.digest, "unit-1.digest.json");
        assert!(unit.agent);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
