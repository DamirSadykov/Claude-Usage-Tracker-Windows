//! Append-only restart-point observations.  This is intentionally tolerant: a
//! failed dataset write must never make the work-tree command fail.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::analytics::restart_point::{RestartPoint, RestartPointParams};

#[derive(Debug, Deserialize)]
struct Calibration {
    rhos: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct RestartParams {
    pub params: RestartPointParams,
    pub rho_source: &'static str,
}

pub fn load_params(path: &Path) -> RestartParams {
    let rhos = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Calibration>(&raw).ok())
        .map(|calibration| calibration.rhos)
        .filter(|rhos| {
            !rhos.is_empty()
                && rhos
                    .iter()
                    .all(|rho| rho.is_finite() && (0.0..=1.0).contains(rho))
        });
    match rhos {
        Some(rhos) => RestartParams {
            params: RestartPointParams {
                rhos,
                ..Default::default()
            },
            rho_source: "calibration",
        },
        None => RestartParams {
            params: RestartPointParams::default(),
            rho_source: "default",
        },
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptStamp {
    pub size: u64,
    pub mtime_ns: u128,
}

#[derive(Serialize)]
struct RestartRecord<'a> {
    v: u8,
    session: &'a str,
    task: &'a str,
    task_number: u32,
    provider: &'a str,
    model: &'a str,
    role: Option<&'a str>,
    stamp: &'a TranscriptStamp,
    computed_at: String,
    observed: &'a crate::analytics::restart_point::RestartObserved,
    scenarios: &'a [crate::analytics::restart_point::RestartScenario],
    params: RecordParams<'a>,
    model_version: u32,
}

#[derive(Serialize)]
struct RecordParams<'a> {
    h: i64,
    #[serde(rename = "R")]
    r: i64,
    rhos: &'a [f64],
    rho_source: &'a str,
}

#[derive(Deserialize)]
struct ExistingRecord {
    session: String,
    task: String,
    stamp: TranscriptStamp,
}

impl<'de> Deserialize<'de> for TranscriptStamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            size: u64,
            mtime_ns: u128,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            size: wire.size,
            mtime_ns: wire.mtime_ns,
        })
    }
}

fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn transcript_stamp(path: &Path) -> Option<TranscriptStamp> {
    let metadata = fs::metadata(path).ok()?;
    let mtime_ns = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(TranscriptStamp {
        size: metadata.len(),
        mtime_ns,
    })
}

/// True when this exact transcript version was already recorded for the task.
/// Kept separate from `append_if_new` so the background backfill can avoid
/// parsing a transcript merely to discover that its observation is current.
pub fn has_current_record(path: &Path, session: &str, task: &str, stamp: &TranscriptStamp) -> bool {
    fs::read_to_string(path).ok().is_some_and(|raw| {
        raw.lines()
            .filter_map(|line| serde_json::from_str::<ExistingRecord>(line).ok())
            .any(|old| {
                old.session == session
                    && old.task == task
                    && old.stamp.size == stamp.size
                    && old.stamp.mtime_ns == stamp.mtime_ns
            })
    })
}

#[allow(clippy::too_many_arguments)]
pub fn append_if_new(
    path: &Path,
    session: &str,
    task: &str,
    task_number: u32,
    provider: &str,
    model: &str,
    role: Option<&str>,
    stamp: &TranscriptStamp,
    point: &RestartPoint,
    params: &RestartParams,
) -> Result<(), String> {
    let _guard = write_lock()
        .lock()
        .map_err(|_| "restart store lock poisoned".to_string())?;
    if has_current_record(path, session, task, stamp) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let record = RestartRecord {
        v: 1,
        session,
        task,
        task_number,
        provider,
        model,
        role,
        stamp,
        computed_at: Utc::now().to_rfc3339(),
        observed: &point.observed,
        scenarios: &point.scenarios,
        params: RecordParams {
            h: params.params.h,
            r: params.params.r,
            rhos: &params.params.rhos,
            rho_source: params.rho_source,
        },
        model_version: point.model_version,
    };
    let mut line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_calibration_uses_documented_defaults() {
        let params = load_params(Path::new("does-not-exist-restart-calibration.json"));
        assert_eq!(params.params.rhos, vec![0.25, 0.38, 0.64]);
        assert_eq!(params.rho_source, "default");
    }
}
