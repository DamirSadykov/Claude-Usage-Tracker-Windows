//! Read-only reader for per-task PHASE plans authored by the `cc-phases` CLI.
//!
//! Plans live IN THE PROJECT, not the app data dir, as a FOLDER per plan:
//! ```text
//! .claude/phases/
//!   README.md
//!   <Plan-Title>/
//!     README.md            <- plan notes + `CC-task: #N` (the tracker link)
//!     Phase-1.md           <- one file per phase (title, desc, done, subphases)
//!     Phase-2.md
//! ```
//! The tracker only READS these to draw phase checkboxes on the task card
//! (matched by `CC-task: #N`); `scripts/cc-phases.mjs` is the only writer. The
//! grammar below must stay in lockstep with that CLI.
//!
//! Phase file grammar:
//! ```text
//! # Phase 1: <title>
//! <!-- status: done -->        (present only when the phase is done)
//!
//! <optional one-line description>
//!
//! - [ ] 1.1 <subphase title> — <subphase text>
//! - [x] 1.2 <subphase title>
//! ```

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

/// One checklist item under a phase. `num` is the `k` in the `N.k` locator.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Subphase {
    pub num: u32,
    pub title: String,
    pub text: String,
    pub done: bool,
}

/// One ordered phase (one `Phase-N.md` file). `num` comes from the filename.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Phase {
    pub num: u32,
    pub title: String,
    pub desc: String,
    pub done: bool,
    pub subs: Vec<Subphase>,
}

/// A whole plan for one task, tagged with the owning project's basename and the
/// task number (from `CC-task: #N`) so the frontend can match it to a card.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Plan {
    pub task_number: u32,
    pub project: String,
    /// The plan's north star, from the README's `## Vision` section. None when the
    /// section is absent or still the scaffold placeholder.
    pub vision: Option<String>,
    pub phases: Vec<Phase>,
}

const SEP: &str = " — ";

fn split_title(rest: &str) -> (String, String) {
    match rest.find(SEP) {
        Some(i) => (
            rest[..i].trim().to_string(),
            rest[i + SEP.len()..].trim().to_string(),
        ),
        None => (rest.trim().to_string(), String::new()),
    }
}

/// `(done, body)` for a `"- [_] "` task-list line; None if it isn't one.
fn strip_box(line: &str) -> Option<(bool, &str)> {
    if let Some(rest) = line.strip_prefix("- [x] ") {
        Some((true, rest))
    } else if let Some(rest) = line.strip_prefix("- [ ] ") {
        Some((false, rest))
    } else {
        None
    }
}

/// Parse one `Phase-N.md`. `num` is the filename's number (authoritative); the
/// H1's number is ignored, its text is the title. Lines before the first
/// subphase that aren't the heading / done-marker / blank form the description.
pub fn parse_phase(text: &str, num: u32) -> Phase {
    let mut title = String::new();
    let mut done = false;
    let mut desc_lines: Vec<String> = Vec::new();
    let mut subs: Vec<Subphase> = Vec::new();
    for raw in text.lines() {
        if let Some(rest) = raw.strip_prefix("# Phase ") {
            // rest = "N: <title>"
            if let Some(c) = rest.find(": ") {
                title = rest[c + 2..].trim().to_string();
            } else if let Some(c) = rest.find(':') {
                title = rest[c + 1..].trim().to_string();
            }
            continue;
        }
        let t = raw.trim();
        if t.starts_with("<!--") {
            if t.contains("status:") && t.contains("done") {
                done = true;
            }
            continue;
        }
        if let Some((sdone, body)) = strip_box(raw) {
            // body = "N.k <title…>"
            if let Some(sp) = body.find(' ') {
                let mut it = body[..sp].split('.');
                let _p = it.next().and_then(|s| s.parse::<u32>().ok());
                let sn = it.next().and_then(|s| s.parse::<u32>().ok());
                if let (Some(sn), None) = (sn, it.next()) {
                    let (st, stext) = split_title(&body[sp + 1..]);
                    subs.push(Subphase {
                        num: sn,
                        title: st,
                        text: stext,
                        done: sdone,
                    });
                    continue;
                }
            }
        }
        if subs.is_empty() && !t.is_empty() {
            desc_lines.push(t.to_string());
        }
    }
    Phase {
        num,
        title,
        desc: desc_lines.join(" "),
        done,
        subs,
    }
}

/// The tracker task number from a plan README's `CC-task: #N` line. None when
/// absent (e.g. `CC-task: #(none)`), which means the plan isn't shown on a card.
fn read_task(readme: &str) -> Option<u32> {
    for line in readme.lines() {
        if let Some(idx) = line.find("CC-task:") {
            let digits: String = line[idx + "CC-task:".len()..]
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

/// Scaffold placeholder for the README's `## Vision` section — treated as "no
/// vision". Must match `VISION_PLACEHOLDER` in scripts/cli/phases.mjs.
const VISION_PLACEHOLDER: &str =
    "_(the goal and the intended flow — fill this before decomposing into phases)_";

/// A line that opens a Markdown section: 1–6 leading `#` then whitespace.
fn is_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|&b| b == b'#').count();
    (1..=6).contains(&hashes) && line[hashes..].starts_with(char::is_whitespace)
}

/// A `## Vision` / `## Видение` heading: the section text is exactly the word
/// (not a prefix like "Visionary"), case-insensitive. Mirrors the negative
/// letter-lookahead in the CLI's `extractVision`.
fn is_vision_heading(line: &str) -> bool {
    if !is_heading(line) {
        return false;
    }
    let hashes = line.bytes().take_while(|&b| b == b'#').count();
    let rest = line[hashes..].trim_start().to_lowercase();
    for kw in ["vision", "видение"] {
        if let Some(after) = rest.strip_prefix(kw) {
            if !after.chars().next().is_some_and(char::is_alphabetic) {
                return true;
            }
        }
    }
    false
}

/// Remove every `<!-- … -->` block (the scaffold's guidance comment), spanning
/// lines. An unterminated comment drops the rest, matching the CLI's regex strip.
fn strip_html_comments(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The ATX heading level (count of leading `#`) of a heading line, or 0 when the
/// line is not a heading. Lets a section end only at a heading of the SAME or a
/// HIGHER level, so deeper sub-headings stay inside the section body.
fn heading_level(line: &str) -> usize {
    if is_heading(line) {
        line.bytes().take_while(|&b| b == b'#').count()
    } else {
        0
    }
}

/// The plan's Vision — north-star prose from the README's `## Vision` section
/// (heading "Vision" or "Видение"), body up to the next heading of the SAME or a
/// HIGHER level (or EOF), with the guidance comment stripped. None when absent or
/// still the scaffold placeholder. A DEEPER sub-heading (e.g. `### Flow`) stays in
/// the body so a structured multi-line vision isn't silently truncated (issue #58).
/// Mirrors `extractVision` in scripts/cli/phases.mjs.
fn extract_vision(readme: &str) -> Option<String> {
    let lines: Vec<&str> = readme.lines().collect();
    let head = lines.iter().position(|l| is_vision_heading(l))?;
    let vis_level = heading_level(lines[head]);
    let mut body = String::new();
    for line in &lines[head + 1..] {
        let lvl = heading_level(line);
        if lvl != 0 && lvl <= vis_level {
            break;
        }
        body.push_str(line);
        body.push('\n');
    }
    let body = strip_html_comments(&body);
    let body = body.trim();
    if body.is_empty() || body == VISION_PLACEHOLDER {
        None
    } else {
        Some(body.to_string())
    }
}

/// Every `Phase-<n>.md` in a plan folder, parsed and sorted by number.
fn read_phase_files(plan_dir: &Path) -> Vec<Phase> {
    let entries = match std::fs::read_dir(plan_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut phases = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(num) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("Phase-"))
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue; // README.md and anything not Phase-<n>.md
        };
        if let Ok(text) = std::fs::read_to_string(&path) {
            phases.push(parse_phase(&text, num));
        }
    }
    phases.sort_by_key(|p| p.num);
    phases
}

/// Read every plan in a project's `.claude/phases/` dir. Each plan is a folder;
/// only those whose README carries a `CC-task: #N` link become a [`Plan`] (the
/// tracker matches a card by task number).
pub fn read_plans(project_basename: &str, project_path: &Path) -> Vec<Plan> {
    let dir = project_path.join(".claude").join("phases");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue; // skip the root README.md
        }
        let readme = std::fs::read_to_string(path.join("README.md")).unwrap_or_default();
        let Some(task_number) = read_task(&readme) else {
            continue; // plan not linked to a tracker task → nothing to show on a card
        };
        out.push(Plan {
            task_number,
            project: project_basename.to_string(),
            vision: extract_vision(&readme),
            phases: read_phase_files(&path),
        });
    }
    out.sort_by_key(|p| p.task_number);
    out
}

/// Map a project basename → its filesystem path, discovered from Claude's
/// transcript dirs under `<claude>/projects/*`. The real `cwd` is read out of the
/// jsonl content (the dir name's separator-encoding is lossy). On a basename
/// collision the most-recently-active project wins.
pub fn project_paths(claude_dir: &Path) -> HashMap<String, PathBuf> {
    let projects = claude_dir.join("projects");
    let entries = match std::fs::read_dir(&projects) {
        Ok(e) => e,
        Err(_) => return HashMap::new(),
    };
    let mut best: HashMap<String, (PathBuf, SystemTime)> = HashMap::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(cwd) = read_cwd(&dir) else { continue };
        let Some(base) = crate::cc::project_name(&cwd.to_string_lossy()) else {
            continue;
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match best.get(&base) {
            Some((_, t)) if *t >= mtime => {}
            _ => {
                best.insert(base, (cwd, mtime));
            }
        }
    }
    best.into_iter().map(|(k, (p, _))| (k, p)).collect()
}

/// First non-empty `cwd` found among a transcript dir's `.jsonl` files.
fn read_cwd(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = File::open(&path) else { continue };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok).take(200) {
            if !line.contains("\"cwd\"") {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
                    if !cwd.is_empty() {
                        return Some(PathBuf::from(cwd));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // One literal (no `\`-continuations — those would strip the leading content).
    const PHASE1: &str = concat!(
        "# Phase 1: Данные и формат\n",
        "<!-- status: done -->\n",
        "\n",
        "схема .claude/phases\n",
        "\n",
        "- [x] 1.1 ридер в Rust\n",
        "- [ ] 1.2 round-trip — самое хрупкое\n",
    );

    #[test]
    fn parses_phase_file() {
        let p = parse_phase(PHASE1, 1);
        assert_eq!(p.num, 1);
        assert_eq!(p.title, "Данные и формат");
        assert_eq!(p.desc, "схема .claude/phases");
        assert!(p.done);
        assert_eq!(p.subs.len(), 2);
        assert_eq!(p.subs[0].title, "ридер в Rust");
        assert!(p.subs[0].done);
        assert_eq!(p.subs[1].num, 2);
        assert_eq!(p.subs[1].text, "самое хрупкое");
        assert!(!p.subs[1].done);
    }

    #[test]
    fn not_done_when_no_status_marker() {
        let p = parse_phase("# Phase 2: CLI\n\n- [ ] 2.1 grammar\n", 2);
        assert!(!p.done);
        assert_eq!(p.title, "CLI");
        assert_eq!(p.desc, "");
        assert_eq!(p.subs.len(), 1);
    }

    #[test]
    fn title_may_contain_a_colon() {
        let p = parse_phase("# Phase 1: Build: the thing\n", 1);
        assert_eq!(p.title, "Build: the thing");
    }

    #[test]
    fn multi_digit_subphase() {
        let p = parse_phase("# Phase 1: x\n- [x] 1.34 deep\n", 1);
        assert_eq!(p.subs[0].num, 34);
        assert!(p.subs[0].done);
    }

    #[test]
    fn cc_task_link_is_read_and_plan_matched_by_it() {
        // Build a plan folder in a temp dir and read it end-to-end.
        let root = std::env::temp_dir().join("cut_phases_test_plan");
        let _ = std::fs::remove_dir_all(&root);
        let plan = root.join(".claude").join("phases").join("My-Plan");
        std::fs::create_dir_all(&plan).unwrap();
        std::fs::write(
            plan.join("README.md"),
            "# My Plan\n\nCC-task: #16\n\n> notes\n",
        )
        .unwrap();
        std::fs::write(plan.join("Phase-1.md"), "# Phase 1: A\n\n- [x] 1.1 sub\n").unwrap();
        std::fs::write(plan.join("Phase-2.md"), "# Phase 2: B\n").unwrap();

        let plans = read_plans("proj", &root);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].task_number, 16);
        assert_eq!(plans[0].project, "proj");
        assert_eq!(plans[0].phases.len(), 2);
        assert_eq!(plans[0].phases[0].num, 1);
        assert!(plans[0].phases[0].subs[0].done);
        assert_eq!(plans[0].vision, None); // README has no `## Vision` section
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_vision_section() {
        // filled; section ends at the next heading
        let md = "# T\n\nCC-task: #1\n\n## Vision\nцель и flow\n\n## Notes\nx\n";
        assert_eq!(extract_vision(md).as_deref(), Some("цель и flow"));
        // Cyrillic heading must match (the CLI had an ASCII-\b bug here)
        assert_eq!(
            extract_vision("# T\n\n## Видение\nкраулим\n").as_deref(),
            Some("краулим"),
        );
        // still the scaffold placeholder → no vision
        let ph = format!("# T\n\n## Vision\n{VISION_PLACEHOLDER}\n");
        assert_eq!(extract_vision(&ph), None);
        // "Visionary" is a prefix, not the Vision heading
        assert_eq!(extract_vision("# T\n\n## Visionary outlook\nno\n"), None);
        // runs to EOF; the guidance comment is stripped
        assert_eq!(
            extract_vision("# T\n\n## Vision\n<!-- guide -->\nlast to eof\n").as_deref(),
            Some("last to eof"),
        );
        // no section at all
        assert_eq!(extract_vision("# T\n\n## Notes\nnothing\n"), None);
        // a DEEPER sub-heading stays in the body (issue #58); a same-level `## …`
        // still ends the section — so the `### Flow` block is kept but `## Notes` is not
        assert_eq!(
            extract_vision("# T\n\n## Vision\nintro\n\n### Flow\nstep one\n\n## Notes\nx\n")
                .as_deref(),
            Some("intro\n\n### Flow\nstep one"),
        );
    }

    #[test]
    fn plan_without_cc_task_is_skipped() {
        let root = std::env::temp_dir().join("cut_phases_test_notask");
        let _ = std::fs::remove_dir_all(&root);
        let plan = root.join(".claude").join("phases").join("No-Link");
        std::fs::create_dir_all(&plan).unwrap();
        std::fs::write(plan.join("README.md"), "# No Link\n\nCC-task: #(none)\n").unwrap();
        std::fs::write(plan.join("Phase-1.md"), "# Phase 1: A\n").unwrap();

        assert!(read_plans("proj", &root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
