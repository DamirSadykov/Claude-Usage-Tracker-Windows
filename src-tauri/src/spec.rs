//! Spec registry for the Tasks window (t#346) — a bridge, not a second reader.
//!
//! The registry itself lives in `scripts/cli/spec.mjs`: it parses
//! `docs/specs/<domain>/spec.md`, resolves `<domain>#<slug>` addresses, and
//! answers "declared but unavailable" for a section whose text sits in another
//! repository. Re-implementing that parse here would give the app a second
//! reader of the same format, and the two would drift the moment the format
//! moved — the app already paid that price on the WRITE side, where a field the
//! Rust struct did not know was dropped on every save (t#339). So the window
//! asks the CLI and renders what it says.
//!
//! What Rust does own is the part the CLI cannot know from inside the app: WHERE
//! each project lives. The board stores a project as a basename (`cc.rs`
//! `project_name`), which is not a path, and the spec root is relative to the
//! project directory. The full `cwd` is recorded in every Claude Code transcript,
//! so it is read back from there — the one authoritative source on this machine.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

/// A project the tracker can point the registry at: its board name, the
/// directory the transcripts say it is worked in, and whether a spec registry
/// is actually there.
///
/// `has_specs` exists because the transcripts know FAR more directories than
/// are interesting — every `src-tauri`, every scratchpad, every `node_modules`
/// a session ever `cd`-ed into. Without it the picker defaults to whatever
/// sorts first, which is how the tab opened on a temp directory and reported
/// "no specs in this project" about a project that has two domains.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectDir {
    pub project: String,
    pub dir: String,
    pub has_specs: bool,
}

/// `specRoot` as the CLI reads it (scripts/cli/settings.mjs) — the same key,
/// the same default, so the app and the hooks never disagree about where a
/// project's specs live.
fn spec_root_setting() -> String {
    let appdata = std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|h| format!("{h}\\AppData\\Roaming")))
        .unwrap_or_default();
    let path = PathBuf::from(appdata)
        .join("com.claude-usage-tracker.app")
        .join("settings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            v.get("specRoot")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "docs/specs".to_string())
}

/// Does `dir` hold a registry — at least one `<domain>/spec.md` under the
/// configured root? A cheap directory probe, not a parse: whether those files
/// are VALID is the registry's answer, not this function's.
fn has_registry(dir: &Path, spec_root: &str) -> bool {
    let root = if Path::new(spec_root).is_absolute() {
        PathBuf::from(spec_root)
    } else {
        dir.join(spec_root)
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().is_dir() && e.path().join("spec.md").exists())
}

/// Head of a file, in bytes — a transcript is megabytes and the `cwd` is on its
/// first records.
fn head(path: &Path, bytes: usize) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; bytes];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// The `cwd` of the first record that carries one.
fn cwd_of_transcript(path: &Path) -> Option<String> {
    for line in head(path, 64 * 1024)?.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
            if !cwd.trim().is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Newest `.jsonl` directly inside `dir`.
fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let m = match entry.metadata().and_then(|m| m.modified()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if best.as_ref().is_none_or(|(bm, _)| m > *bm) {
            best = Some((m, p));
        }
    }
    best.map(|(_, p)| p)
}

/// Every project the transcripts know a live directory for, newest transcript
/// winning when two sessions disagree. A directory that no longer exists is
/// dropped: pointing the registry at it would produce "no domains", which reads
/// as "nothing is written" when the truth is "wrong place".
pub fn project_dirs() -> Vec<ProjectDir> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let base = match crate::cc::claude_dir() {
        Some(d) => d.join("projects"),
        None => return Vec::new(),
    };
    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(jsonl) = newest_jsonl(&entry.path()) else {
            continue;
        };
        let Some(cwd) = cwd_of_transcript(&jsonl) else {
            continue;
        };
        if !Path::new(&cwd).is_dir() {
            continue;
        }
        let name = cwd
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        out.insert(name, cwd);
    }
    let spec_root = spec_root_setting();
    let mut list: Vec<ProjectDir> = out
        .into_iter()
        .map(|(project, dir)| {
            let has_specs = has_registry(Path::new(&dir), &spec_root);
            ProjectDir { project, dir, has_specs }
        })
        .collect();
    // Projects that HAVE a registry first, alphabetical within each half — so
    // the picker's default lands on something the tab can actually show.
    list.sort_by(|a, b| b.has_specs.cmp(&a.has_specs).then(a.project.cmp(&b.project)));
    list
}

/// Run `node <cli.mjs> spec <args…> --json` in `dir` and parse what comes back.
///
/// Failures are returned as messages, never swallowed: a tab that shows an
/// empty list because node is missing would be indistinguishable from a project
/// that has written no specs, and telling those two apart is the whole reason
/// the registry answers in three shapes rather than two (README §4).
fn run_spec(cli: &str, dir: &str, args: &[&str]) -> Result<Value, String> {
    let mut cmd = Command::new("node");
    cmd.arg(cli).arg("spec").args(args).arg("--json").current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("не удалось запустить node: {e} (реестр спек читает scripts/cli/spec.mjs)"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("cli spec {} ничего не вернул", args.join(" "))
        } else {
            stderr.trim().to_string()
        });
    }
    serde_json::from_str(&stdout).map_err(|e| format!("ответ реестра не разобрался: {e}"))
}

#[tauri::command]
pub fn spec_projects() -> Vec<ProjectDir> {
    project_dirs()
}

#[tauri::command]
pub fn spec_domains(app: tauri::AppHandle, dir: String) -> Result<Value, String> {
    let cli = crate::cc_hook_script_path(&app)?;
    run_spec(&cli, &dir, &["domains"])
}

#[tauri::command]
pub fn spec_section(app: tauri::AppHandle, dir: String, address: String) -> Result<Value, String> {
    let cli = crate::cc_hook_script_path(&app)?;
    run_spec(&cli, &dir, &["show", &address])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cut-spec-rs-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn cwd_comes_off_the_first_record_that_has_one() {
        let d = tmp();
        let f = d.join("s.jsonl");
        let mut fh = std::fs::File::create(&f).unwrap();
        writeln!(fh, "{{\"type\":\"summary\"}}").unwrap();
        writeln!(fh, "not json at all").unwrap();
        writeln!(fh, "{{\"type\":\"user\",\"cwd\":\"D:\\\\projects\\\\app\"}}").unwrap();
        assert_eq!(cwd_of_transcript(&f).as_deref(), Some("D:\\projects\\app"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_transcript_with_no_cwd_yields_none_rather_than_an_empty_path() {
        let d = tmp();
        let f = d.join("s.jsonl");
        std::fs::write(&f, "{\"type\":\"summary\"}\n{\"cwd\":\"  \"}\n").unwrap();
        assert!(cwd_of_transcript(&f).is_none());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_registry_is_at_least_one_domain_dir_holding_a_spec_md() {
        let d = tmp();
        assert!(!has_registry(&d, "docs/specs"));
        std::fs::create_dir_all(d.join("docs/specs/loose")).unwrap();
        // A directory under the root with no spec.md is not a domain.
        assert!(!has_registry(&d, "docs/specs"));
        std::fs::write(d.join("docs/specs/loose/spec.md"), "---\nid: loose\n---\n").unwrap();
        assert!(has_registry(&d, "docs/specs"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_flat_spec_file_in_the_root_is_not_a_registry() {
        // The pre-SDD layout (docs/specs/tasks.md) is exactly the case where an
        // empty answer must not read as "this project has specs".
        let d = tmp();
        std::fs::create_dir_all(d.join("docs/specs")).unwrap();
        std::fs::write(d.join("docs/specs/tasks.md"), "# tasks\n").unwrap();
        assert!(!has_registry(&d, "docs/specs"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn the_newest_transcript_wins() {
        let d = tmp();
        std::fs::write(d.join("old.jsonl"), "{}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(d.join("new.jsonl"), "{}\n").unwrap();
        std::fs::write(d.join("notes.md"), "x").unwrap();
        assert_eq!(
            newest_jsonl(&d).unwrap().file_name().unwrap().to_str(),
            Some("new.jsonl")
        );
        std::fs::remove_dir_all(&d).ok();
    }
}
