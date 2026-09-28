//! Compact IPC payloads for the task board.

use std::collections::HashSet;

use serde::Serialize;

use super::todos::{Change, Todo, TodoFile};

const DESCRIPTION_LIMIT: usize = 300;

#[derive(Serialize, Clone)]
pub struct TodoRow {
    pub id: String,
    pub number: u32,
    pub subject: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub kind: String,
    pub change: bool,
    pub change_id: Option<String>,
    pub scheduled_for: Option<String>,
    pub project: Option<String>,
    pub from: Option<String>,
    pub links: Vec<String>,
    pub depends_on: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub ref_count: usize,
    pub comment_count: usize,
}

#[derive(Serialize, Clone)]
pub struct BoardPayload {
    pub revision: u64,
    pub todos: Vec<TodoRow>,
    pub changes: Vec<Change>,
    pub state: &'static str,
}

#[derive(Serialize, Clone)]
pub struct MutationPayload {
    pub revision: u64,
    pub row: Option<TodoRow>,
}

pub fn row(todo: &Todo) -> TodoRow {
    TodoRow {
        id: todo.id.clone(), number: todo.number, subject: todo.subject.clone(),
        description: truncate(&todo.description), status: todo.status.clone(),
        priority: todo.priority.clone(), kind: todo.kind.clone(), change: todo.change,
        change_id: todo.change_id.clone(), scheduled_for: todo.scheduled_for.clone(),
        project: todo.project.clone(), from: todo.from.clone(), links: todo.links.clone(),
        depends_on: todo.depends_on.clone(), created_at: todo.created_at.clone(),
        updated_at: todo.updated_at.clone(), ref_count: reference_count(todo),
        comment_count: todo.comments.len(),
    }
}

pub fn board(revision: u64, file: &TodoFile) -> BoardPayload {
    BoardPayload {
        revision,
        todos: file.todos.iter().map(row).collect(),
        changes: file.changes.clone(),
        state: "ok",
    }
}

fn truncate(value: &str) -> String {
    // The ellipsis is part of the advertised 300-character payload limit.
    // Reserve room for it before collecting the visible prefix.
    if value.chars().count() <= DESCRIPTION_LIMIT {
        return value.to_owned();
    }
    let clipped: String = value.chars().take(DESCRIPTION_LIMIT - 1).collect();
    format!("{clipped}…")
}

fn reference_count(todo: &Todo) -> usize {
    let mut refs = HashSet::new();
    for text in std::iter::once(todo.description.as_str()).chain(todo.comments.iter().map(|c| c.body.as_str())) {
        for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '#')) {
            let digits = token.strip_prefix("t#").or_else(|| token.strip_prefix("T#"));
            if let Some(n) = digits.and_then(|n| n.parse::<u32>().ok()) {
                if n != todo.number { refs.insert(n); }
            }
        }
    }
    refs.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn row_omits_heavy_fields_and_counts_references() {
        let todo = Todo { number: 3, description: "see t#2".into(), comments: vec![crate::board::todos::Comment { id: "x".into(), author: "u".into(), body: "t#4 t#2".into(), created_at: String::new() }], ..Default::default() };
        let row = row(&todo);
        assert_eq!(row.ref_count, 2);
        assert_eq!(row.comment_count, 1);
    }

    #[test]
    fn row_description_never_exceeds_limit() {
        let todo = Todo { description: "a".repeat(DESCRIPTION_LIMIT + 1), ..Default::default() };
        let row = row(&todo);
        assert_eq!(row.description.chars().count(), DESCRIPTION_LIMIT);
        assert!(row.description.ends_with('…'));
    }
}
