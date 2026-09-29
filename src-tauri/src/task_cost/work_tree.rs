use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Deserializer, Serialize};

use crate::analytics::{
    cc, codex_work_tree,
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
}

#[derive(Clone, Debug, Deserialize)]
struct RunReview {
    #[serde(default)]
    session: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkAttempt {
    pub number: u32,
    pub started_at: String,
    pub ended_at: String,
    pub events: Vec<RunEvent>,
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
        let Some(tree) = tree_for_block(block, claude_base, codex_base) else {
            continue;
        };
        let context =
            context_for_block(block, run_steps, task_numbers, &session_tasks, claude_base);
        let session = TaskWorkSession {
            session: block.session.clone(),
            from: block.from.clone(),
            to: block.to.clone(),
            source: block.source.clone(),
            tree,
            context,
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
) -> Option<WorkTree> {
    let interval = WorkTreeInterval {
        start: Some(block.from.clone()),
        end: Some(block.to.clone()),
    };
    if let Some(path) = claude_base.and_then(|base| cc::transcript_path(base, &block.session, None))
    {
        return cached(&path, work_tree::build_session_work_tree)
            .ok()
            .map(|tree| slice_tree(tree, &interval));
    }
    let path = codex_base.and_then(|base| codex_transcript_path(base, &block.session))?;
    cached(&path, codex_work_tree::build_codex_work_tree)
        .ok()
        .map(|tree| slice_tree(tree, &interval))
}

fn slice_tree(mut tree: WorkTree, interval: &WorkTreeInterval) -> WorkTree {
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
    fn runner_context_uses_run_journal_for_worker_and_reviewer() {
        let worker = RunStep {
            task: "42".into(),
            session: Some("worker-session".into()),
            start_mode: "fork".into(),
            parent_session: Some("parent-session".into()),
            review: Some(RunReview {
                session: Some("review-session".into()),
            }),
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
