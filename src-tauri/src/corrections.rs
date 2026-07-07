//! Read side of the user-corrections outcome metric (task t#101).
//!
//! `cli.mjs corrections publish` mines the Claude Code transcripts, computes the
//! two ratios (corrections-per-session, rework-after-done) plus a likely-LLM vs
//! ambiguous split, and writes `corrections-metrics.json`. The tracker only ever
//! READS that file to show a card — so this module is load-only; the CLI owns the
//! schema and the atomic temp+rename write, exactly as it owns todos.json and the
//! triage digest.
//!
//! JSON is snake_case to match the app's wire format. The shape mirrors
//! scripts/cli/corrections.mjs::cmdPublish and docs/corrections-contract.md.
//! Classifying a candidate further (correction vs refinement/…) is out of scope
//! for this metric — these numbers are heuristic candidate upper bounds.

use std::path::Path;

use serde::{Deserialize, Serialize};

fn default_version() -> u32 {
    1
}

/// The aggregate ratios + counts over the published scope. Ratios are `Option`
/// because a zero denominator (no assistant turns / no done-claims) must read as
/// "n/a", never as a perfect 0. Counts are plain so the card can render "x / y".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Totals {
    #[serde(default)]
    pub sessions: u32,
    #[serde(default)]
    pub assistant_turns: u32,
    #[serde(default)]
    pub user_turns: u32,
    #[serde(default)]
    pub candidate_corrections: u32,
    #[serde(default)]
    pub done_claims: u32,
    #[serde(default)]
    pub rework_after_done: u32,
    /// Candidates with a structural signal (post-reject/interrupt) — ≈ LLM-fault.
    #[serde(default)]
    pub likely_llm: u32,
    /// Candidates with only a lexical signal — could be user change-of-direction.
    #[serde(default)]
    pub ambiguous: u32,
    #[serde(default)]
    pub corrections_per_session: Option<f64>,
    #[serde(default)]
    pub rework_after_done_rate: Option<f64>,
}

/// Per-session stats — the drill-down rows under the totals. Fields we don't need
/// in the card (candidates' text/evidence) are intentionally omitted; serde
/// ignores unknown JSON keys, so the file can carry more than the card reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStat {
    #[serde(default)]
    pub assistant_turns: u32,
    #[serde(default)]
    pub user_turns: u32,
    #[serde(default)]
    pub candidate_corrections: u32,
    #[serde(default)]
    pub done_claims: u32,
    #[serde(default)]
    pub rework_after_done: u32,
    #[serde(default)]
    pub corrections_per_session: Option<f64>,
    #[serde(default)]
    pub rework_after_done_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    #[serde(default)]
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    pub stats: SessionStat,
    #[serde(default)]
    pub likely_llm: u32,
    #[serde(default)]
    pub ambiguous: u32,
}

/// The on-disk shape of `corrections-metrics.json`. Every field defaults so an
/// older or partial file still loads. `version` is the file schema; the writer's
/// `contract_version` is carried through for consumers that pin it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrectionsMetrics {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub contract_version: u32,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub totals: Totals,
    #[serde(default)]
    pub sessions: Vec<SessionRow>,
}

/// Read the metrics file. A missing or malformed file yields `None` (nothing to
/// surface) rather than an error — the card must stay usable whether or not a
/// `publish` has run, and a half-written file should be ignored, not crash.
/// Mirrors the forgiving read in triage.rs.
pub fn load(path: &Path) -> Option<CorrectionsMetrics> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_is_none() {
        assert!(load(Path::new("does-not-exist-corrections-98765.json")).is_none());
    }

    #[test]
    fn load_malformed_is_none() {
        let path = std::env::temp_dir().join("cut_corrections_bad.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_parses_full_metrics() {
        let path = std::env::temp_dir().join("cut_corrections_full.json");
        let raw = r#"{
            "version": 1,
            "contract_version": 1,
            "generated_at": "2026-07-06T09:58:34.815Z",
            "scope": "project",
            "project": "claude-usage-tracker-windows",
            "totals": {
                "sessions": 2, "assistant_turns": 100, "user_turns": 20,
                "candidate_corrections": 3, "done_claims": 10, "rework_after_done": 1,
                "likely_llm": 2, "ambiguous": 1,
                "corrections_per_session": 0.03, "rework_after_done_rate": 0.1
            },
            "sessions": [
                {"session": "a", "project_dir": "D--x", "modified_at": "2026-07-06T00:00:00Z",
                 "stats": {"assistant_turns": 56, "user_turns": 13, "candidate_corrections": 2,
                           "done_claims": 6, "rework_after_done": 0,
                           "corrections_per_session": 0.0357, "rework_after_done_rate": 0.0},
                 "likely_llm": 2, "ambiguous": 0}
            ]
        }"#;
        std::fs::write(&path, raw).unwrap();

        let m = load(&path).expect("should parse");
        assert_eq!(m.version, 1);
        assert_eq!(m.project.as_deref(), Some("claude-usage-tracker-windows"));
        assert_eq!(m.totals.candidate_corrections, 3);
        assert_eq!(m.totals.likely_llm, 2);
        assert_eq!(m.totals.corrections_per_session, Some(0.03));
        assert_eq!(m.sessions.len(), 1);
        assert_eq!(m.sessions[0].session, "a");
        assert_eq!(m.sessions[0].stats.user_turns, 13);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_tolerates_missing_optional_fields() {
        // Minimal file (just totals) must still load, defaulting the rest.
        let path = std::env::temp_dir().join("cut_corrections_min.json");
        std::fs::write(&path, br#"{"totals":{}}"#).unwrap();
        let m = load(&path).expect("should parse");
        assert_eq!(m.version, 1);
        assert_eq!(m.generated_at, "");
        assert!(m.project.is_none());
        assert_eq!(m.totals.candidate_corrections, 0);
        assert!(m.totals.corrections_per_session.is_none());
        assert!(m.sessions.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
