//! Plain read-models shared by analytics consumers.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SessionUsage {
    pub session_id: String,
    pub project: Option<String>,
    pub start: String,
    pub end: String,
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
    #[serde(default)]
    pub cache_create: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BlockTotals {
    pub cost: f64,
    pub total_tokens: i64,
    pub messages: i64,
    pub tool_calls: i64,
    pub tool_errors: i64,
}
