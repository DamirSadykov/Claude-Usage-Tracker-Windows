use reqwest::header::{HeaderMap, HeaderValue, COOKIE, CONTENT_TYPE, ACCEPT};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageData {
    pub five_hour: UsageTier,
    pub seven_day: UsageTier,
    pub seven_day_opus: Option<UsageTier>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageTier {
    pub percent_used: f64,
    pub reset_at: Option<String>,
    pub is_limited: bool,
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    five_hour: Option<ApiFiveHour>,
    #[serde(default)]
    seven_day: Option<ApiSevenDay>,
    #[serde(default)]
    seven_day_opus: Option<ApiSevenDay>,
}

#[derive(Debug, Deserialize)]
struct ApiFiveHour {
    #[serde(default)]
    utilization: f64,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    is_limited: bool,
}

#[derive(Debug, Deserialize)]
struct ApiSevenDay {
    #[serde(default)]
    utilization: f64,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    is_limited: bool,
}

pub async fn fetch_usage(
    session_key: &str,
    org_id: &str,
) -> Result<UsageData, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("https://claude.ai/api/organizations/{}/usage", org_id);

    let mut headers = HeaderMap::new();
    headers.insert(
        COOKIE,
        HeaderValue::from_str(&format!("sessionKey={}", session_key))?,
    );
    headers.insert("anthropic-client-sha", HeaderValue::from_static("unknown"));
    headers.insert(
        "anthropic-client-version",
        HeaderValue::from_static("unknown"),
    );

    let client = reqwest::Client::new();
    let resp = client.get(&url).headers(headers).send().await?;

    if !resp.status().is_success() {
        return Err(format!("API error: {}", resp.status()).into());
    }

    let api: ApiResponse = resp.json().await?;

    let five_hour = api
        .five_hour
        .map(|f| UsageTier {
            percent_used: f.utilization,
            reset_at: f.resets_at,
            is_limited: f.is_limited,
        })
        .unwrap_or(UsageTier {
            percent_used: 0.0,
            reset_at: None,
            is_limited: false,
        });

    let seven_day = api
        .seven_day
        .map(|s| UsageTier {
            percent_used: s.utilization,
            reset_at: s.resets_at,
            is_limited: s.is_limited,
        })
        .unwrap_or(UsageTier {
            percent_used: 0.0,
            reset_at: None,
            is_limited: false,
        });

    let seven_day_opus = api.seven_day_opus.map(|s| UsageTier {
        percent_used: s.utilization,
        reset_at: s.resets_at,
        is_limited: s.is_limited,
    });

    Ok(UsageData {
        five_hour,
        seven_day,
        seven_day_opus,
    })
}

// --- Project & session auto-start ---

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub uuid: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct ProjectListItem {
    uuid: String,
    name: String,
}

fn build_headers(session_key: &str) -> Result<HeaderMap, Box<dyn std::error::Error + Send + Sync>> {
    let mut headers = HeaderMap::new();
    headers.insert(COOKIE, HeaderValue::from_str(&format!("sessionKey={}", session_key))?);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert("anthropic-client-sha", HeaderValue::from_static("unknown"));
    headers.insert("anthropic-client-version", HeaderValue::from_static("unknown"));
    Ok(headers)
}

const TRACKER_PROJECT_NAME: &str = "Usage Tracker - Auto Session";

pub async fn ensure_project(
    session_key: &str,
    org_id: &str,
) -> Result<ProjectInfo, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    let headers = build_headers(session_key)?;

    let list_url = format!(
        "https://claude.ai/api/organizations/{}/projects",
        org_id
    );
    let resp = client.get(&list_url).headers(headers.clone()).send().await?;
    if !resp.status().is_success() {
        return Err(format!("List projects error: {}", resp.status()).into());
    }
    let projects: Vec<ProjectListItem> = resp.json().await?;

    if let Some(existing) = projects.iter().find(|p| p.name == TRACKER_PROJECT_NAME) {
        return Ok(ProjectInfo {
            uuid: existing.uuid.clone(),
            name: existing.name.clone(),
        });
    }

    let create_url = format!(
        "https://claude.ai/api/organizations/{}/projects",
        org_id
    );
    let body = serde_json::json!({
        "name": TRACKER_PROJECT_NAME,
        "description": "Auto-created by Claude Usage Tracker. Sessions here keep the 5-hour window active.",
        "is_private": true
    });
    let resp = client
        .post(&create_url)
        .headers(headers)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Create project error {}: {}", status, text).into());
    }
    let created: ProjectListItem = resp.json().await?;
    Ok(ProjectInfo {
        uuid: created.uuid,
        name: created.name,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionStartResult {
    pub conversation_id: Option<String>,
    pub project_id: String,
    pub skipped: bool,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct ConversationCreated {
    uuid: String,
}

pub async fn start_session(
    session_key: &str,
    org_id: &str,
    project_id: &str,
) -> Result<SessionStartResult, Box<dyn std::error::Error + Send + Sync>> {
    let usage = fetch_usage(session_key, org_id).await?;
    if usage.five_hour.percent_used > 0.0 || usage.five_hour.reset_at.is_some() {
        return Ok(SessionStartResult {
            conversation_id: None,
            project_id: project_id.to_string(),
            skipped: true,
            reason: "skipped_active".to_string(),
        });
    }

    let client = reqwest::Client::new();
    let headers = build_headers(session_key)?;

    let conv_url = format!(
        "https://claude.ai/api/organizations/{}/chat_conversations",
        org_id
    );
    let conv_body = serde_json::json!({
        "name": "",
        "project_uuid": project_id,
        "model": "claude-sonnet-4-20250514"
    });
    let resp = client
        .post(&conv_url)
        .headers(headers.clone())
        .json(&conv_body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Create conversation error {}: {}", status, text).into());
    }
    let conv: ConversationCreated = resp.json().await?;

    let msg_url = format!(
        "https://claude.ai/api/organizations/{}/chat_conversations/{}/completion",
        org_id, conv.uuid
    );
    let msg_body = serde_json::json!({
        "prompt": "ping",
        "timezone": "Europe/Moscow",
        "model": "claude-sonnet-4-20250514",
        "attachments": [],
        "files": []
    });
    let _resp = client
        .post(&msg_url)
        .headers(headers)
        .json(&msg_body)
        .send()
        .await?;

    Ok(SessionStartResult {
        conversation_id: Some(conv.uuid),
        project_id: project_id.to_string(),
        skipped: false,
        reason: "started".to_string(),
    })
}
