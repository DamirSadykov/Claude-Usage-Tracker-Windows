use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Deserializer, Serialize};

use super::restart_store::{self, RestartParams};
use crate::analytics::{
    cc, codex_work_tree,
    restart_point::{calculate_restart_point, RestartPoint, RestartProvider},
    work_tree::{self, WorkTree, WorkTreeInterval},
};
use crate::board::task_sessions::TaskBlock;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkTree {
    pub task: String,
    pub sessions: Vec<TaskWorkSession>,
    pub attempts: Vec<TaskWorkAttempt>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkSession {
    pub session: String,
    pub from: String,
    pub to: String,
    pub source: String,
    pub tree: WorkTree,
    pub context: TaskWorkContext,
    pub restart_point: RestartPoint,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkContext {
    pub mode: ContextMode,
    pub role: Option<WorkRole>,
    pub parent_session: Option<String>,
    pub parent_task: Option<u32>,
    pub compacted: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContextMode {
    Fresh,
    Fork,
    Continued,
    Unknown,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkRole {
    Worker,
    Review,
}

#[derive(Clone, Debug, Deserialize)]
struct RunRecord {
    #[serde(default)]
    steps: Vec<RunStep>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RunStep {
    #[serde(default, deserialize_with = "deserialize_task")]
    task: String,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    start_mode: String,
    #[serde(default)]
    parent_session: Option<String>,
    #[serde(default)]
    review: Option<RunReview>,
    #[serde(default)]
    attempt: Option<u32>,
    #[serde(default)]
    result: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReview {
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub counts: Option<ReviewCounts>,
    #[serde(default)]
    pub approved: Option<bool>,
    #[serde(default)]
    pub findings: Option<Vec<serde_json::Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCounts {
    #[serde(default)]
    pub critical: u32,
    #[serde(default)]
    pub high: u32,
    #[serde(default)]
    pub medium: u32,
    #[serde(default)]
    pub low: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkAttempt {
    pub number: u32,
    pub started_at: String,
    pub ended_at: String,
    pub events: Vec<RunEvent>,
    pub review: Option<RunReview>,
    pub result: Option<String>,
    pub sessions: Vec<TaskWorkSession>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    #[serde(default)]
    pub ts: String,
    #[serde(default, deserialize_with = "deserialize_task")]
    pub task: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub counts: Option<ReviewCounts>,
    #[serde(default)]
    pub approved: Option<bool>,
    #[serde(default)]
    pub findings: Option<Vec<serde_json::Value>>,
}

fn deserialize_task<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(task) => task,
        serde_json::Value::Number(task) => task.to_string(),
        _ => String::new(),
    })
}

#[derive(Clone)]
struct CachedTree {
    files: Vec<FileStamp>,
    tree: WorkTree,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    size: u64,
    modified: u128,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedTree>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedTree>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn load_run_events(path: &Path) -> Vec<RunEvent> {
    std::fs::read_to_string(path)
        .map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .filter(|event: &RunEvent| !event.ts.is_empty() && !event.task.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn load_run_steps(path: &Path) -> Vec<RunStep> {
    std::fs::read_to_string(path)
        .map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str::<RunRecord>(line).ok())
                .flat_map(|record| record.steps)
                .collect()
        })
        .unwrap_or_default()
}

pub fn build_task_work_tree(
    task: &str,
    task_number: u32,
    blocks: &[TaskBlock],
    run_events: &[RunEvent],
    run_steps: &[RunStep],
    task_numbers: &HashMap<String, u32>,
    claude_base: Option<&Path>,
    codex_base: Option<&Path>,
    restart_params: &RestartParams,
    restart_points_path: Option<&Path>,
) -> TaskWorkTree {
    let task_blocks: Vec<&TaskBlock> = blocks.iter().filter(|block| block.task == task).collect();
    let events: Vec<RunEvent> = run_events
        .iter()
        .filter(|event| task_matches(event, task_number))
        .cloned()
        .collect();
    let mut sessions = Vec::new();
    let mut attempts: HashMap<u32, TaskWorkAttempt> = HashMap::new();
    let mut session_tasks = HashMap::new();
    for block in blocks {
        session_tasks
            .entry(block.session.clone())
            .or_insert_with(|| block.task.clone());
    }

    for block in task_blocks {
        let Some((tree, transcript, provider)) = tree_for_block(block, claude_base, codex_base)
        else {
            continue;
        };
        let context =
            context_for_block(block, run_steps, task_numbers, &session_tasks, claude_base);
        let restart_point = calculate_restart_point(&tree.turns, provider, &restart_params.params);
        if let (Some(store), Some(stamp)) = (
            restart_points_path,
            restart_store::transcript_stamp(&transcript),
        ) {
            let role = match context.role.as_ref() {
                Some(WorkRole::Worker) => Some("worker"),
                Some(WorkRole::Review) => Some("review"),
                None => None,
            };
            let model = tree
                .turns
                .last()
                .map(|turn| turn.model.as_str())
                .unwrap_or("");
            let provider_name = match provider {
                RestartProvider::OpenAi => "codex",
                RestartProvider::Anthropic => "claude",
            };
            let _ = restart_store::append_if_new(
                store,
                &block.session,
                task,
                task_number,
                provider_name,
                model,
                role,
                &stamp,
                &restart_point,
                restart_params,
            );
        }
        let session = TaskWorkSession {
            session: block.session.clone(),
            from: block.from.clone(),
            to: block.to.clone(),
            source: block.source.clone(),
            tree,
            context,
            restart_point,
        };
        if block.source == "run-step" {
            if let Some(number) = attempt_at(&events, &block.from) {
                let entry = attempts.entry(number).or_insert_with(|| TaskWorkAttempt {
                    number,
                    started_at: block.from.clone(),
                    ended_at: block.to.clone(),
                    events: events
                        .iter()
                        .filter(|event| event.attempt == Some(number))
                        .cloned()
                        .collect(),
                    review: review_for_attempt(run_steps, task_number, number)
                        .or_else(|| review_from_events(&events, number)),
                    result: result_for_attempt(run_steps, task_number, number),
                    sessions: Vec::new(),
                });
                if block.from < entry.started_at {
                    entry.started_at = block.from.clone();
                }
                if block.to > entry.ended_at {
                    entry.ended_at = block.to.clone();
                }
                entry.sessions.push(session);
                continue;
            }
        }
        sessions.push(session);
    }
    for event in events.iter().filter(|event| event.kind == "step_start") {
        let Some(number) = event.attempt else {
            continue;
        };
        attempts.entry(number).or_insert_with(|| TaskWorkAttempt {
            number,
            started_at: event.ts.clone(),
            ended_at: events
                .iter()
                .filter(|candidate| candidate.attempt == Some(number))
                .map(|candidate| candidate.ts.as_str())
                .max()
                .unwrap_or(event.ts.as_str())
                .to_string(),
            events: events
                .iter()
                .filter(|candidate| candidate.attempt == Some(number))
                .cloned()
                .collect(),
            review: review_for_attempt(run_steps, task_number, number)
                .or_else(|| review_from_events(&events, number)),
            result: result_for_attempt(run_steps, task_number, number),
            sessions: Vec::new(),
        });
    }
    let mut attempts: Vec<_> = attempts.into_values().collect();
    attempts.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then(a.number.cmp(&b.number))
    });
    TaskWorkTree {
        task: task.to_string(),
        sessions,
        attempts,
    }
}

fn review_for_attempt(run_steps: &[RunStep], task_number: u32, attempt: u32) -> Option<RunReview> {
    run_steps
        .iter()
        .rev()
        .find(|step| run_step_matches(step, task_number) && step.attempt == Some(attempt))
        .and_then(|step| {
            step.review.clone().map(|mut review| {
                if review.counts.is_none() {
                    review.counts = Some(counts_from_findings(review.findings.as_deref()));
                }
                review
            })
        })
}

fn counts_from_findings(findings: Option<&[serde_json::Value]>) -> ReviewCounts {
    let mut counts = ReviewCounts {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
    };
    for finding in findings.unwrap_or_default() {
        match finding.get("level").and_then(serde_json::Value::as_str) {
            Some("critical") => counts.critical += 1,
            Some("high") => counts.high += 1,
            Some("medium") => counts.medium += 1,
            Some("low") => counts.low += 1,
            _ => {}
        }
    }
    counts
}

fn result_for_attempt(run_steps: &[RunStep], task_number: u32, attempt: u32) -> Option<String> {
    run_steps
        .iter()
        .rev()
        .find(|step| run_step_matches(step, task_number) && step.attempt == Some(attempt))
        .and_then(|step| step.result.clone())
}

fn review_from_events(events: &[RunEvent], attempt: u32) -> Option<RunReview> {
    events
        .iter()
        .rev()
        .find(|event| event.kind == "review" && event.attempt == Some(attempt))
        .map(|event| RunReview {
            session: None,
            counts: event.counts.clone(),
            approved: event.approved,
            findings: event.findings.clone(),
        })
}

fn context_for_block(
    block: &TaskBlock,
    run_steps: &[RunStep],
    task_numbers: &HashMap<String, u32>,
    session_tasks: &HashMap<String, String>,
    claude_base: Option<&Path>,
) -> TaskWorkContext {
    for step in run_steps
        .iter()
        .filter(|step| run_step_matches(step, task_numbers.get(&block.task).copied().unwrap_or(0)))
    {
        if step.session.as_deref() == Some(&block.session) {
            return runner_context(step, Some(WorkRole::Worker), task_numbers, session_tasks);
        }
        if step
            .review
            .as_ref()
            .and_then(|review| review.session.as_deref())
            == Some(&block.session)
        {
            return TaskWorkContext {
                mode: ContextMode::Fresh,
                role: Some(WorkRole::Review),
                parent_session: None,
                parent_task: None,
                compacted: false,
            };
        }
    }
    let Some(path) = claude_base.and_then(|base| cc::transcript_path(base, &block.session, None))
    else {
        return TaskWorkContext {
            mode: ContextMode::Unknown,
            role: None,
            parent_session: None,
            parent_task: None,
            compacted: false,
        };
    };
    let (continued, compacted) = work_tree::session_context_markers(&path, &block.from, &block.to);
    TaskWorkContext {
        mode: if continued {
            ContextMode::Continued
        } else {
            ContextMode::Fresh
        },
        role: None,
        parent_session: None,
        parent_task: None,
        compacted,
    }
}

fn run_step_matches(step: &RunStep, number: u32) -> bool {
    [
        format!("t#{number}"),
        number.to_string(),
        format!("#{number}"),
    ]
    .contains(&step.task)
}

fn runner_context(
    step: &RunStep,
    role: Option<WorkRole>,
    task_numbers: &HashMap<String, u32>,
    session_tasks: &HashMap<String, String>,
) -> TaskWorkContext {
    let mode = match step.start_mode.as_str() {
        "fresh" => ContextMode::Fresh,
        "fork" => ContextMode::Fork,
        _ => ContextMode::Unknown,
    };
    let parent_session = step.parent_session.clone();
    let parent_task = parent_session
        .as_deref()
        .and_then(|parent| session_tasks.get(parent))
        .and_then(|task| task_numbers.get(task))
        .copied();
    TaskWorkContext {
        mode,
        role,
        parent_session,
        parent_task,
        compacted: false,
    }
}

fn task_matches(event: &RunEvent, number: u32) -> bool {
    [
        format!("t#{number}"),
        number.to_string(),
        format!("#{number}"),
    ]
    .contains(&event.task)
}

fn attempt_at(events: &[RunEvent], at: &str) -> Option<u32> {
    events
        .iter()
        .filter(|event| event.kind == "step_start" && event.ts.as_str() <= at)
        .max_by(|a, b| a.ts.cmp(&b.ts))
        .and_then(|event| event.attempt)
}

fn tree_for_block(
    block: &TaskBlock,
    claude_base: Option<&Path>,
    codex_base: Option<&Path>,
) -> Option<(WorkTree, PathBuf, RestartProvider)> {
    let interval = WorkTreeInterval {
        start: Some(block.from.clone()),
        end: Some(block.to.clone()),
    };
    if let Some(path) = claude_base.and_then(|base| cc::transcript_path(base, &block.session, None))
    {
        return cached(&path, work_tree::build_session_work_tree)
            .ok()
            .map(|tree| {
                (
                    slice_tree(tree, &interval),
                    path,
                    RestartProvider::Anthropic,
                )
            });
    }
    let path = codex_base.and_then(|base| codex_transcript_path(base, &block.session))?;
    cached(&path, codex_work_tree::build_codex_work_tree)
        .ok()
        .map(|tree| (slice_tree(tree, &interval), path, RestartProvider::OpenAi))
}

/// Locate the transcript selected by the same provider precedence as a task
/// work tree.  Backfill uses this only for the cheap current-stamp check before
/// it asks `tree_for_block` to parse the transcript.
pub fn transcript_path_for_block(
    block: &TaskBlock,
    claude_base: Option<&Path>,
    codex_base: Option<&Path>,
) -> Option<PathBuf> {
    claude_base
        .and_then(|base| cc::transcript_path(base, &block.session, None))
        .or_else(|| codex_base.and_then(|base| codex_transcript_path(base, &block.session)))
}

fn slice_tree(mut tree: WorkTree, interval: &WorkTreeInterval) -> WorkTree {
    tree.compaction_at
        .retain(|timestamp| in_interval(timestamp, interval));
    tree.compacted = !tree.compaction_at.is_empty();
    tree.turns
        .retain(|turn| in_interval(&turn.timestamp, interval));
    for turn in &mut tree.turns {
        turn.calls.retain_mut(|call| {
            call.result = call
                .result
                .take()
                .filter(|result| in_interval(&result.timestamp, interval));
            if let Some(agent) = call.subagent.take() {
                call.subagent = Some(Box::new(slice_tree(*agent, interval)));
            }
            true
        });
    }
    tree.started_at = tree.turns.first().map(|turn| turn.timestamp.clone());
    tree.ended_at = tree.turns.last().map(|turn| turn.timestamp.clone());
    tree.input_tokens = tree.turns.iter().map(|turn| turn.input_tokens).sum();
    tree.output_tokens = tree.turns.iter().map(|turn| turn.output_tokens).sum();
    tree.cache_creation_tokens = tree
        .turns
        .iter()
        .map(|turn| turn.cache_creation_tokens)
        .sum();
    tree.cache_read_tokens = tree.turns.iter().map(|turn| turn.cache_read_tokens).sum();
    tree.cost = tree.turns.iter().map(|turn| turn.cost).sum();
    tree
}

fn in_interval(timestamp: &str, interval: &WorkTreeInterval) -> bool {
    interval
        .start
        .as_deref()
        .map(|start| timestamp >= start)
        .unwrap_or(true)
        && interval
            .end
            .as_deref()
            .map(|end| timestamp <= end)
            .unwrap_or(true)
}

fn cached<F>(path: &Path, build: F) -> Result<WorkTree, String>
where
    F: FnOnce(&Path) -> Result<WorkTree, String>,
{
    let files = cache_files(path)?;
    let key = path.to_path_buf();
    if let Some(hit) = cache()
        .lock()
        .unwrap()
        .get(&key)
        .filter(|hit| hit.files == files)
    {
        return Ok(hit.tree.clone());
    }
    let tree = build(path)?;
    cache().lock().unwrap().insert(
        key,
        CachedTree {
            files,
            tree: tree.clone(),
        },
    );
    Ok(tree)
}

fn cache_files(path: &Path) -> Result<Vec<FileStamp>, String> {
    let mut files = vec![file_stamp(path)?];
    let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
        return Ok(files);
    };
    let Some(subagents) = path
        .parent()
        .map(|parent| parent.join(stem).join("subagents"))
    else {
        return Ok(files);
    };
    collect_file_stamps(&subagents, &mut files);
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn file_stamp(path: &Path) -> Result<FileStamp, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or(0);
    Ok(FileStamp {
        path: path.to_path_buf(),
        size: meta.len(),
        modified,
    })
}

fn collect_file_stamps(dir: &Path, files: &mut Vec<FileStamp>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_file_stamps(&path, files);
        } else if let Ok(stamp) = file_stamp(&path) {
            files.push(stamp);
        }
    }
}

fn codex_transcript_path(base: &Path, session: &str) -> Option<PathBuf> {
    static PATHS: OnceLock<Mutex<HashMap<(PathBuf, String), PathBuf>>> = OnceLock::new();
    let paths = PATHS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (base.to_path_buf(), session.to_string());
    if let Some(path) = paths
        .lock()
        .unwrap()
        .get(&key)
        .filter(|path| path.is_file())
    {
        return Some(path.clone());
    }
    let mut files = Vec::new();
    collect_rollouts(&base.join("sessions"), &mut files);
    collect_rollouts(&base.join("archived_sessions"), &mut files);
    let path = files
        .into_iter()
        .find(|path| rollout_session_id(path).as_deref() == Some(session))?;
    paths.lock().unwrap().insert(key, path.clone());
    Some(path)
}

fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, out);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-"))
        {
            out.push(path);
        }
    }
}

fn rollout_session_id(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let record: serde_json::Value = serde_json::from_str(&line).ok()?;
        if record.get("type").and_then(serde_json::Value::as_str) == Some("session_meta") {
            return record
                .get("payload")?
                .get("id")?
                .as_str()
                .map(str::to_string);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_runner_events_for_the_requested_task_number() {
        let events = vec![RunEvent {
            ts: "2026-01-01T00:00:01Z".into(),
            task: "t#5".into(),
            kind: "step_start".into(),
            attempt: Some(2),
            limit: Some(3),
            route: None,
            counts: None,
            approved: None,
            findings: None,
        }];
        assert!(task_matches(&events[0], 5));
        assert_eq!(attempt_at(&events, "2026-01-01T00:00:02Z"), Some(2));
    }

    #[test]
    fn loads_numeric_runner_task_ids() {
        let path = std::env::temp_dir().join("task-work-tree-numeric-run-event.jsonl");
        std::fs::write(
            &path,
            r#"{"ts":"2026-01-01T00:00:01Z","task":805,"kind":"step_start","attempt":1}"#,
        )
        .unwrap();
        let events = load_run_events(&path);
        assert_eq!(events.len(), 1);
        assert!(task_matches(&events[0], 805));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn carries_event_review_outcome_to_an_attempt_without_a_transcript() {
        let events = vec![
            RunEvent {
                ts: "2026-01-01T00:00:01Z".into(),
                task: "t#5".into(),
                kind: "step_start".into(),
                attempt: Some(2),
                limit: Some(3),
                route: None,
                counts: None,
                approved: None,
                findings: None,
            },
            RunEvent {
                ts: "2026-01-01T00:00:02Z".into(),
                task: "t#5".into(),
                kind: "review".into(),
                attempt: Some(2),
                limit: Some(3),
                route: None,
                counts: Some(ReviewCounts {
                    critical: 0,
                    high: 0,
                    medium: 2,
                    low: 0,
                }),
                approved: Some(true),
                findings: Some(vec![serde_json::json!({"level": "medium"})]),
            },
        ];
        let tree = build_task_work_tree(
            "task",
            5,
            &[],
            &events,
            &[],
            &HashMap::new(),
            None,
            None,
            &RestartParams {
                params: Default::default(),
                rho_source: "default",
            },
            None,
        );
        let review = tree.attempts[0].review.as_ref().unwrap();
        assert_eq!(review.approved, Some(true));
        assert_eq!(review.counts.as_ref().unwrap().medium, 2);
        assert_eq!(review.findings.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn runner_context_uses_run_journal_for_worker_and_reviewer() {
        let worker = RunStep {
            task: "42".into(),
            session: Some("worker-session".into()),
            start_mode: "fork".into(),
            parent_session: Some("parent-session".into()),
            review: Some(RunReview {
                session: Some("review-session".into()),
                counts: None,
                approved: None,
                findings: None,
            }),
            attempt: None,
            result: None,
        };
        let task_numbers =
            HashMap::from([("task".to_string(), 42), ("parent-task".to_string(), 17)]);
        let session_tasks =
            HashMap::from([("parent-session".to_string(), "parent-task".to_string())]);
        let block = TaskBlock {
            task: "task".into(),
            session: "worker-session".into(),
            from: "2026-01-01T00:00:00Z".into(),
            to: "2026-01-01T00:01:00Z".into(),
            explicit: true,
            source: "run-step".into(),
            project: None,
        };
        assert_eq!(
            context_for_block(
                &block,
                &[worker.clone()],
                &task_numbers,
                &session_tasks,
                None,
            ),
            TaskWorkContext {
                mode: ContextMode::Fork,
                role: Some(WorkRole::Worker),
                parent_session: Some("parent-session".into()),
                parent_task: Some(17),
                compacted: false,
            }
        );
        let review = TaskBlock {
            session: "review-session".into(),
            ..block
        };
        assert_eq!(
            context_for_block(&review, &[worker], &task_numbers, &session_tasks, None,),
            TaskWorkContext {
                mode: ContextMode::Fresh,
                role: Some(WorkRole::Review),
                parent_session: None,
                parent_task: None,
                compacted: false,
            }
        );
    }

    #[test]
    fn loads_run_steps_tolerantly() {
        let path = std::env::temp_dir().join("task-work-tree-runs.jsonl");
        std::fs::write(
            &path,
            concat!(
                "not json\n",
                r#"{"steps":[{"task":42,"session":"worker","start_mode":"fresh"}]}"#,
                "\n"
            ),
        )
        .unwrap();
        let steps = load_run_steps(&path);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].task, "42");
        assert_eq!(steps[0].start_mode, "fresh");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn derives_review_counts_and_result_from_a_run_step() {
        let steps = vec![RunStep {
            task: "5".into(),
            session: None,
            start_mode: String::new(),
            parent_session: None,
            review: Some(RunReview {
                session: None,
                counts: None,
                approved: Some(false),
                findings: Some(vec![
                    serde_json::json!({"level": "high"}),
                    serde_json::json!({"level": "medium"}),
                ]),
            }),
            attempt: Some(1),
            result: Some("done".into()),
        }];
        let review = review_for_attempt(&steps, 5, 1).unwrap();
        assert_eq!(
            review.counts,
            Some(ReviewCounts {
                critical: 0,
                high: 1,
                medium: 1,
                low: 0
            })
        );
        assert_eq!(result_for_attempt(&steps, 5, 1).as_deref(), Some("done"));
        assert_eq!(review.approved, Some(false));
    }

    #[test]
    fn keeps_tool_result_error_flag_when_slicing_a_task_tree() {
        let path = std::env::temp_dir().join("task-work-tree-tool-error.jsonl");
        std::fs::write(&path, concat!(
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"id":"turn","model":"claude-sonnet","usage":{},"content":[{"type":"tool_use","id":"tool","name":"Bash","input":{}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool","is_error":true,"content":"failed"}]}}"#,
        )).unwrap();
        let tree = work_tree::build_work_tree(&path, &WorkTreeInterval::default()).unwrap();
        let sliced = slice_tree(
            tree,
            &WorkTreeInterval {
                start: Some("2026-01-01T00:00:00Z".into()),
                end: Some("2026-01-01T00:01:00Z".into()),
            },
        );
        assert!(sliced.turns[0].calls[0].result.as_ref().unwrap().is_error);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cache_fingerprint_includes_subagent_transcripts() {
        let dir = std::env::temp_dir().join("task-work-tree-cache-subagent");
        let root = dir.join("session.jsonl");
        let child = dir.join("session/subagents/agent-child.jsonl");
        std::fs::create_dir_all(child.parent().unwrap()).unwrap();
        std::fs::write(&root, "root").unwrap();
        std::fs::write(&child, "child").unwrap();
        let before = cache_files(&root).unwrap();
        std::fs::write(&child, "changed child").unwrap();
        assert_ne!(before, cache_files(&root).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
