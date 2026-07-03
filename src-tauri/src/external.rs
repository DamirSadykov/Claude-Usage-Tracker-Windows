//! Instance-side poll client for the external-integration resolver (plan
//! `External-integration-public-side`, phase 5).
//!
//! This is the readonly mirror: the device polls the resolver, folds the delivered
//! events into a local task cache (`external_tasks.json`), and reports which tasks
//! changed status so the UI can surface them. The resolver stays neutral — it hands
//! back opaque event envelopes and never interprets task content; interpretation
//! (grouping events into tasks, diffing status) happens HERE, on the client.
//!
//! Storage-agnostic and pure like `todos.rs`/`enroll.rs`/`identity.rs` (functions
//! take a `&Path`; signing is injected as a closure), so the fold + change-detection
//! unit-tests without the app, a running resolver, or a real keypair. The HTTP call
//! and DPAPI-backed signing live in `lib.rs`.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// `instance -> resolver` poll body (resolver contract `routes::PollRequest`). The
/// resolver rebuilds the challenge as `"{device_id}|{ts}"` and echoes `ts`
/// verbatim, so we must sign exactly that string with no reformatting.
#[derive(Serialize)]
pub struct PollRequest {
    pub device_id: String,
    /// RFC3339 timestamp, also the freshness proof (`poll_skew_secs` window).
    pub ts: String,
    /// Base64 Ed25519 signature over [`poll_challenge`].
    pub signature: String,
}

/// The exact bytes the resolver verifies the poll signature against. One function
/// so the wire format lives in a single place — the resolver's `poll` handler
/// builds the identical `"{device_id}|{ts}"`.
pub fn poll_challenge(device_id: &str, ts: &str) -> String {
    format!("{device_id}|{ts}")
}

/// One event as delivered by the resolver's `/poll` (mirrors `model::MessageOut`).
/// `payload` is deliberately a raw JSON value: an unexpected/partial payload from a
/// future source must not fail the whole batch, so we parse it per-message into
/// [`TaskPayload`] and skip only the offenders.
#[derive(Deserialize)]
pub struct MessageIn {
    pub id: String,
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: serde_json::Value,
    pub ts: String,
}

/// The task fields carried in an event payload (contract §1.1 `$defs/payload`).
/// `priority`/`assignee` are optional in the schema; the rest are required, but we
/// stay lenient (missing → skip the message) rather than trusting the sender.
#[derive(Clone, Debug, Deserialize)]
pub struct TaskPayload {
    pub title: String,
    /// Source-native status string — the instance never hardcodes the set.
    pub status: String,
    pub url: String,
    pub updated_at: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    /// Sanitised task body. Not in the contract's payload yet — laid in ahead of the
    /// private side sending it (see contract §1.1 note: raw descriptions never leave
    /// the perimeter, so whatever lands here is already stripped). `serde(default)`
    /// keeps today's payloads (no such field) parsing to `None`.
    #[serde(default)]
    pub description: Option<String>,
    /// Project/funnel in the source's terms. Same forward-compat story as
    /// `description`: absent today, carried through the moment the sender adds it.
    #[serde(default)]
    pub project: Option<String>,
}

/// One mirrored external task: the latest known state of a task, folded from its
/// event stream. Identified by `(source, task_id)` where `task_id` is the part of
/// the envelope `id` before the first `:` (contract §"Дедупликация":
/// `id = {taskId}:{discriminator}`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExternalTask {
    pub task_id: String,
    pub source: String,
    pub title: String,
    pub status: String,
    pub url: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Sanitised task body, when the source provides it (see [`TaskPayload::description`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Project/funnel the task belongs to, when the source provides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// `ts` of the most recent event applied to this task — used to ignore
    /// out-of-order/duplicate events (a stale event never overwrites a fresh state).
    pub last_event_ts: String,
    /// `type` of that most recent event, for the UI (e.g. badge a fresh comment).
    pub last_event_kind: String,
}

/// The persisted readonly mirror, a sibling of `todos.json`. Kept as a flat list
/// (a team's open tasks are tens, not thousands — a linear scan on apply is
/// cheaper than a map's JSON noise) and sorted by `updated_at` desc on save so the
/// on-disk order is stable and UI-ready.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExternalTasksCache {
    #[serde(default)]
    pub tasks: Vec<ExternalTask>,
    /// When this device last completed a poll (RFC3339). Purely informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_poll_at: Option<String>,
}

/// A detected transition, surfaced to the UI after a poll. `from == None` means the
/// task is newly mirrored (first sighting); `from == Some(prev)` is a real status
/// change of an already-known task. Comment-only or metadata-only events that leave
/// the status untouched produce NO entry — this is the "детект смены статуса"
/// signal, not a generic event log.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StatusChange {
    pub task_id: String,
    pub source: String,
    pub title: String,
    pub from: Option<String>,
    pub to: String,
    pub url: String,
    /// `ts` of the event that produced the final status.
    pub ts: String,
}

impl ExternalTasksCache {
    /// Load the mirror; an absent file means "nothing mirrored yet".
    pub fn load(path: &Path) -> Result<ExternalTasksCache, String> {
        if !path.exists() {
            return Ok(ExternalTasksCache::default());
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    /// Atomic write (temp + rename), same discipline as `todos::save`.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Fold a batch of polled events into the mirror and return the status changes.
    ///
    /// The core of phase 5.3. Events are applied oldest-first (by `ts`), so folding
    /// A→B then B→C leaves the task at C. Change detection compares each touched
    /// task's status *before this batch* against its status *after*: one entry per
    /// task whose net status changed (or that is newly seen), never per event — a
    /// task flipped twice in one poll yields a single `from→to`, and a comment that
    /// didn't move the status yields nothing.
    ///
    /// An event is ignored (not an error) when: its payload is malformed, its
    /// `id` has no `task_id` part, or it is older than the last event already
    /// applied to that task (stale/duplicate delivery).
    pub fn apply(&mut self, mut messages: Vec<MessageIn>) -> Vec<StatusChange> {
        // Oldest-first so the final fold reflects the true event order, regardless
        // of the order the resolver happened to return them in.
        messages.sort_by(|a, b| ts_key(&a.ts).cmp(&ts_key(&b.ts)));

        // Snapshot pre-batch statuses so we diff against the cache as it was,
        // collapsing intra-batch churn (A→B→C) to one net change.
        use std::collections::HashMap;
        let mut before: HashMap<(String, String), Option<String>> = HashMap::new();

        for msg in &messages {
            let Some(task_id) = task_id_of(&msg.id) else {
                continue;
            };
            let payload: TaskPayload = match serde_json::from_value(msg.payload.clone()) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let key = (msg.source.clone(), task_id.clone());

            // Record the pre-batch status the first time we touch this task.
            before
                .entry(key.clone())
                .or_insert_with(|| self.find(&msg.source, &task_id).map(|t| t.status.clone()));

            match self.find_idx(&msg.source, &task_id) {
                Some(i) => {
                    // Ignore an event no newer than what we've already folded in —
                    // out-of-order or a redelivered duplicate must not regress state.
                    if ts_key(&msg.ts) < ts_key(&self.tasks[i].last_event_ts) {
                        continue;
                    }
                    let t = &mut self.tasks[i];
                    t.title = payload.title;
                    t.status = payload.status;
                    t.url = payload.url;
                    t.updated_at = payload.updated_at;
                    t.priority = payload.priority;
                    t.assignee = payload.assignee;
                    t.description = payload.description;
                    t.project = payload.project;
                    t.last_event_ts = msg.ts.clone();
                    t.last_event_kind = msg.kind.clone();
                }
                None => self.tasks.push(ExternalTask {
                    task_id: task_id.clone(),
                    source: msg.source.clone(),
                    title: payload.title,
                    status: payload.status,
                    url: payload.url,
                    updated_at: payload.updated_at,
                    priority: payload.priority,
                    assignee: payload.assignee,
                    description: payload.description,
                    project: payload.project,
                    last_event_ts: msg.ts.clone(),
                    last_event_kind: msg.kind.clone(),
                }),
            }
        }

        // Diff after vs before for every task the batch touched.
        let mut changes = Vec::new();
        for (key, prev) in before {
            let Some(task) = self.find(&key.0, &key.1) else {
                continue;
            };
            let changed = match &prev {
                Some(p) => p != &task.status,
                None => true, // newly mirrored task
            };
            if changed {
                changes.push(StatusChange {
                    task_id: task.task_id.clone(),
                    source: task.source.clone(),
                    title: task.title.clone(),
                    from: prev,
                    to: task.status.clone(),
                    url: task.url.clone(),
                    ts: task.last_event_ts.clone(),
                });
            }
        }

        // Stable, UI-ready order: freshest task first.
        self.tasks
            .sort_by(|a, b| ts_key(&b.updated_at).cmp(&ts_key(&a.updated_at)));
        changes
    }

    fn find(&self, source: &str, task_id: &str) -> Option<&ExternalTask> {
        self.tasks
            .iter()
            .find(|t| t.source == source && t.task_id == task_id)
    }

    fn find_idx(&self, source: &str, task_id: &str) -> Option<usize> {
        self.tasks
            .iter()
            .position(|t| t.source == source && t.task_id == task_id)
    }
}

/// Extract the `task_id` from an envelope `id` (`{taskId}:{discriminator}`). The
/// part before the first `:`; `None` if that part is empty. A `task_id` with no
/// discriminator (no `:`) is taken whole.
fn task_id_of(id: &str) -> Option<String> {
    let head = id.split(':').next().unwrap_or("");
    if head.is_empty() {
        None
    } else {
        Some(head.to_string())
    }
}

/// Sort key for an RFC3339 timestamp. Parsing normalises timezone offsets so two
/// instants compare correctly even if written with different offsets; an
/// unparseable `ts` sorts oldest (so a malformed event never masquerades as fresh
/// and clobbers good state).
fn ts_key(ts: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|d| d.timestamp_micros())
        .unwrap_or(i64::MIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, source: &str, kind: &str, ts: &str, status: &str) -> MessageIn {
        MessageIn {
            id: id.to_string(),
            source: source.to_string(),
            kind: kind.to_string(),
            ts: ts.to_string(),
            payload: serde_json::json!({
                "title": "Fix login",
                "status": status,
                "url": "https://corp/task/1",
                "updated_at": ts,
            }),
        }
    }

    #[test]
    fn task_id_is_the_head_of_the_envelope_id() {
        assert_eq!(task_id_of("42:status:9001").as_deref(), Some("42"));
        assert_eq!(task_id_of("42").as_deref(), Some("42"));
        assert_eq!(task_id_of(":status").as_deref(), None);
        assert_eq!(task_id_of("").as_deref(), None);
    }

    #[test]
    fn first_sighting_is_a_change_with_no_from() {
        let mut cache = ExternalTasksCache::default();
        let changes = cache.apply(vec![msg(
            "1:created",
            "svc",
            "task_created",
            "2026-07-02T10:00:00Z",
            "open",
        )]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from, None);
        assert_eq!(changes[0].to, "open");
        assert_eq!(cache.tasks.len(), 1);
    }

    #[test]
    fn status_transition_of_known_task_is_reported() {
        let mut cache = ExternalTasksCache::default();
        cache.apply(vec![msg(
            "1:created",
            "svc",
            "task_created",
            "2026-07-02T10:00:00Z",
            "open",
        )]);
        let changes = cache.apply(vec![msg(
            "1:status:200",
            "svc",
            "task_status_changed",
            "2026-07-02T11:00:00Z",
            "done",
        )]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from.as_deref(), Some("open"));
        assert_eq!(changes[0].to, "done");
    }

    #[test]
    fn comment_that_keeps_status_yields_no_change() {
        let mut cache = ExternalTasksCache::default();
        cache.apply(vec![msg(
            "1:created",
            "svc",
            "task_created",
            "2026-07-02T10:00:00Z",
            "open",
        )]);
        let changes = cache.apply(vec![msg(
            "1:comment:5",
            "svc",
            "task_comment_added",
            "2026-07-02T11:00:00Z",
            "open",
        )]);
        assert!(changes.is_empty());
        // But the task still records the fresh event.
        assert_eq!(cache.tasks[0].last_event_kind, "task_comment_added");
    }

    #[test]
    fn intra_batch_double_flip_collapses_to_one_net_change() {
        let mut cache = ExternalTasksCache::default();
        cache.apply(vec![msg(
            "1:created",
            "svc",
            "task_created",
            "2026-07-02T09:00:00Z",
            "open",
        )]);
        // Two transitions in one poll, delivered out of order.
        let changes = cache.apply(vec![
            msg("1:status:b", "svc", "task_status_changed", "2026-07-02T12:00:00Z", "done"),
            msg("1:status:a", "svc", "task_status_changed", "2026-07-02T11:00:00Z", "in_progress"),
        ]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from.as_deref(), Some("open"));
        assert_eq!(changes[0].to, "done");
        assert_eq!(cache.tasks[0].status, "done");
    }

    #[test]
    fn stale_event_does_not_regress_state() {
        let mut cache = ExternalTasksCache::default();
        cache.apply(vec![msg(
            "1:status:new",
            "svc",
            "task_status_changed",
            "2026-07-02T12:00:00Z",
            "done",
        )]);
        // A late-arriving older event must not overwrite the newer "done".
        let changes = cache.apply(vec![msg(
            "1:status:old",
            "svc",
            "task_status_changed",
            "2026-07-02T10:00:00Z",
            "open",
        )]);
        assert!(changes.is_empty());
        assert_eq!(cache.tasks[0].status, "done");
    }

    #[test]
    fn same_task_id_across_sources_stays_distinct() {
        let mut cache = ExternalTasksCache::default();
        let changes = cache.apply(vec![
            msg("1:created", "svc-a", "task_created", "2026-07-02T10:00:00Z", "open"),
            msg("1:created", "svc-b", "task_created", "2026-07-02T10:00:00Z", "open"),
        ]);
        assert_eq!(changes.len(), 2);
        assert_eq!(cache.tasks.len(), 2);
    }

    #[test]
    fn malformed_payload_is_skipped_not_fatal() {
        let mut cache = ExternalTasksCache::default();
        let bad = MessageIn {
            id: "1:created".into(),
            source: "svc".into(),
            kind: "task_created".into(),
            ts: "2026-07-02T10:00:00Z".into(),
            payload: serde_json::json!({ "title": "no status field" }),
        };
        let good = msg("2:created", "svc", "task_created", "2026-07-02T10:01:00Z", "open");
        let changes = cache.apply(vec![bad, good]);
        assert_eq!(changes.len(), 1);
        assert_eq!(cache.tasks.len(), 1);
        assert_eq!(cache.tasks[0].task_id, "2");
    }

    #[test]
    fn description_and_project_are_carried_when_present() {
        // Forward-compat DTO: today's payloads omit these (→ None), but the moment
        // the sender adds them they must land on the mirrored task.
        let mut cache = ExternalTasksCache::default();
        let with_extras = MessageIn {
            id: "1:created".into(),
            source: "svc".into(),
            kind: "task_created".into(),
            ts: "2026-07-02T10:00:00Z".into(),
            payload: serde_json::json!({
                "title": "Fix login",
                "status": "open",
                "url": "https://corp/task/1",
                "updated_at": "2026-07-02T10:00:00Z",
                "description": "Users can't sign in",
                "project": "Website",
            }),
        };
        cache.apply(vec![with_extras]);
        assert_eq!(cache.tasks[0].description.as_deref(), Some("Users can't sign in"));
        assert_eq!(cache.tasks[0].project.as_deref(), Some("Website"));

        // A later payload without them clears back to None (mirror reflects source).
        cache.apply(vec![msg(
            "1:status:2",
            "svc",
            "task_status_changed",
            "2026-07-02T11:00:00Z",
            "done",
        )]);
        assert_eq!(cache.tasks[0].description, None);
        assert_eq!(cache.tasks[0].project, None);
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("external_tasks.json");
        let _ = std::fs::remove_file(&path);

        let mut cache = ExternalTasksCache::default();
        cache.apply(vec![msg(
            "1:created",
            "svc",
            "task_created",
            "2026-07-02T10:00:00Z",
            "open",
        )]);
        cache.last_poll_at = Some("2026-07-02T10:00:01Z".into());
        cache.save(&path).unwrap();

        let back = ExternalTasksCache::load(&path).unwrap();
        assert_eq!(back.tasks.len(), 1);
        assert_eq!(back.tasks[0].status, "open");
        assert_eq!(back.last_poll_at.as_deref(), Some("2026-07-02T10:00:01Z"));
    }

    #[test]
    fn poll_challenge_matches_resolver_format() {
        assert_eq!(poll_challenge("dev1", "2026-07-02T10:00:00Z"), "dev1|2026-07-02T10:00:00Z");
    }
}
