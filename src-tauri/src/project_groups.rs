//! Project association groups (issue #13, "who works with whom"). Unlike merge
//! links (which fold a renamed/absorbed project's stats into a canonical — see
//! stats::project_links), an association is a PEER relationship: the projects stay
//! separate in every aggregate, but are shown as related and can be viewed as a
//! group (read-only combined total in analytics).
//!
//! Stored as a plain `project-groups.json` next to `todos.json` in the app data
//! dir — deliberately NOT in the SQLite stats DB, because the cc-todos CLI (plain
//! Node, no SQLite) must read it too: working in one project, the user/Claude can
//! file a task against a related project. One JSON file is the single source both
//! the app and the CLI read.

use serde::{Deserialize, Serialize};
use std::path::Path;

fn default_version() -> u32 {
    1
}

/// One named association group: a set of projects that work together.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectGroup {
    pub name: String,
    #[serde(default)]
    pub projects: Vec<String>,
}

/// On-disk shape of `project-groups.json`. `version` allows later migration;
/// missing fields default so older or hand-edited files still load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGroupsFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub groups: Vec<ProjectGroup>,
}

impl Default for ProjectGroupsFile {
    fn default() -> Self {
        ProjectGroupsFile {
            version: default_version(),
            groups: Vec::new(),
        }
    }
}

/// Read the store. A missing or malformed file yields an empty set — neither the
/// app nor the CLI should fail over a bad file.
pub fn load(path: &Path) -> ProjectGroupsFile {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => ProjectGroupsFile::default(),
    }
}

/// Persist atomically: write a sibling temp file, then rename over the target
/// (rename replaces the destination on Windows). Drops empty/blank group names and
/// blank project entries, trims, and de-duplicates members so the file the CLI
/// reads stays clean.
pub fn save(path: &Path, file: &ProjectGroupsFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let cleaned = normalize(file);
    let json = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Trim names/projects, drop blank project entries, de-dup members, and drop
/// groups with a blank NAME. A named group with no members is kept — the UI
/// creates a group empty and the user adds projects afterwards, so it must
/// survive the round-trip.
fn normalize(file: &ProjectGroupsFile) -> ProjectGroupsFile {
    let mut groups = Vec::new();
    for g in &file.groups {
        let name = g.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        let projects: Vec<String> = g
            .projects
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty() && seen.insert(p.clone()))
            .collect();
        groups.push(ProjectGroup { name, projects });
    }
    ProjectGroupsFile {
        version: default_version(),
        groups,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        // Unique-enough per test without Date/rand (unavailable): tag + module path.
        env::temp_dir().join(format!("cut-project-groups-{tag}.json"))
    }

    #[test]
    fn missing_file_loads_empty() {
        let p = tmp_path("missing");
        let _ = std::fs::remove_file(&p);
        let f = load(&p);
        assert!(f.groups.is_empty());
        assert_eq!(f.version, 1);
    }

    #[test]
    fn save_normalizes_and_roundtrips() {
        let p = tmp_path("roundtrip");
        let f = ProjectGroupsFile {
            version: 1,
            groups: vec![
                ProjectGroup {
                    name: "  Suite  ".into(),
                    projects: vec!["engine".into(), " advmcp ".into(), "engine".into(), "".into()],
                },
                // dropped: blank name
                ProjectGroup { name: "   ".into(), projects: vec!["x".into()] },
                // KEPT with no members: the UI creates a group empty, then adds to it.
                ProjectGroup { name: "Fresh".into(), projects: vec![" ".into()] },
            ],
        };
        save(&p, &f).unwrap();
        let got = load(&p);
        assert_eq!(got.groups.len(), 2);
        assert_eq!(got.groups[0].name, "Suite");
        assert_eq!(got.groups[0].projects, vec!["engine".to_string(), "advmcp".to_string()]);
        assert_eq!(got.groups[1].name, "Fresh");
        assert!(got.groups[1].projects.is_empty());
        let _ = std::fs::remove_file(&p);
    }
}
