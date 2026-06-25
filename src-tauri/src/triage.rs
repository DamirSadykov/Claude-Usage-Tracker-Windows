//! Read side of the nightly-triage DIGEST (task #35).
//!
//! A scheduled Claude session reads the todo board read-only, reasons about it,
//! and writes its findings to `triage-digest.json` (via `cli.mjs triage publish`).
//! The tracker only ever READS that file — to raise a desktop notification and
//! show an in-app summary — so this module is load-only; there is no save here.
//! The writer (the CLI) owns the schema and the atomic temp+rename write, exactly
//! as the cc-todos CLI owns writes to todos.json.
//!
//! JSON is snake_case to match the rest of the app's wire format. The shape
//! mirrors scripts/cli/triage.mjs; keep [`KINDS`] in lockstep with its `KINDS`.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Finding kinds a digest item can carry. `stale` / `overdue` / `no_priority`
/// are facts the triage agent surfaced about the board; `suggestion` is an
/// advisory move it proposed (the agent never applies it — the board is the
/// user's). Mirrors triage.mjs::KINDS.
pub const KINDS: [&str; 4] = ["stale", "overdue", "no_priority", "suggestion"];

/// One line in the digest: a finding or a suggestion, loosely tied back to a
/// todo by `number`/`id` (either may be absent for a board-wide note).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestItem {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub note: String,
}

fn default_version() -> u32 {
    1
}

/// The on-disk shape of `triage-digest.json`. `version` lets the format migrate
/// later; every field defaults so an older or partial file still loads. `project`
/// records which board the run covered; `headline` is the short notification
/// line, `summary` the prose for the in-app card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriageDigest {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default)]
    pub headline: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub items: Vec<DigestItem>,
}

/// Read the digest. A missing or malformed file yields `None` (no digest to
/// surface) rather than an error — the tracker must stay usable whether or not a
/// triage run has happened, and a half-written/garbage file should be ignored,
/// not crash a background loop. Mirrors the forgiving read in triage.mjs.
pub fn load(path: &Path) -> Option<TriageDigest> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_is_none() {
        assert!(load(Path::new("does-not-exist-triage-98765.json")).is_none());
    }

    #[test]
    fn load_malformed_is_none() {
        let path = std::env::temp_dir().join("cut_triage_bad.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_parses_full_digest() {
        let path = std::env::temp_dir().join("cut_triage_full.json");
        let raw = r#"{
            "version": 1,
            "generated_at": "2026-06-24T05:00:00.000Z",
            "project": "claude-usage-tracker-windows",
            "headline": "3 stale, 1 overdue",
            "summary": "Board needs attention.",
            "items": [
                {"kind": "stale", "number": 11, "id": "abc", "subject": "old task", "note": "18d idle"},
                {"kind": "suggestion", "subject": "raise #44", "note": "blocker"}
            ]
        }"#;
        std::fs::write(&path, raw).unwrap();

        let d = load(&path).expect("should parse");
        assert_eq!(d.version, 1);
        assert_eq!(d.project.as_deref(), Some("claude-usage-tracker-windows"));
        assert_eq!(d.items.len(), 2);
        assert_eq!(d.items[0].kind, "stale");
        assert_eq!(d.items[0].number, Some(11));
        assert_eq!(d.items[1].number, None);
        assert!(KINDS.contains(&d.items[1].kind.as_str()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_tolerates_missing_optional_fields() {
        // A minimal digest (just items) must still load, defaulting the rest.
        let path = std::env::temp_dir().join("cut_triage_min.json");
        std::fs::write(&path, br#"{"items":[]}"#).unwrap();
        let d = load(&path).expect("should parse");
        assert_eq!(d.version, 1);
        assert_eq!(d.generated_at, "");
        assert!(d.project.is_none());
        assert!(d.items.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
