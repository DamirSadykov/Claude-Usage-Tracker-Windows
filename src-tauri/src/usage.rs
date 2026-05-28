use reqwest::header::{HeaderMap, HeaderValue, COOKIE, CONTENT_TYPE, ACCEPT, USER_AGENT, REFERER};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageData {
    pub five_hour: UsageTier,
    pub seven_day: UsageTier,
    pub seven_day_opus: Option<UsageTier>,
    pub seven_day_sonnet: Option<UsageTier>,
    pub extra_usage: Option<ExtraUsage>,
    pub prepaid_balance: Option<f64>,
    pub prepaid_currency: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageTier {
    pub percent_used: f64,
    pub reset_at: Option<String>,
    pub is_limited: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtraUsage {
    pub used_credits: f64,
    pub monthly_limit: f64,
    pub utilization: f64,
    pub currency: String,
}

// --- API response structs ---

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    five_hour: Option<ApiTier>,
    #[serde(default)]
    seven_day: Option<ApiTier>,
    #[serde(default)]
    seven_day_opus: Option<ApiTier>,
    #[serde(default)]
    seven_day_sonnet: Option<ApiTier>,
    #[serde(default)]
    extra_usage: Option<ApiExtraUsage>,
}

#[derive(Debug, Deserialize)]
struct ApiTier {
    #[serde(default)]
    utilization: f64,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    is_limited: bool,
}

#[derive(Debug, Deserialize)]
struct ApiExtraUsage {
    #[serde(default)]
    is_enabled: bool,
    #[serde(default)]
    monthly_limit: f64,
    #[serde(default)]
    used_credits: f64,
    #[serde(default)]
    utilization: f64,
    #[serde(default)]
    currency: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiPrepaidCredits {
    #[serde(default)]
    amount: f64,
    #[serde(default)]
    currency: Option<String>,
}

// --- Shared helpers ---

fn build_headers(session_key: &str) -> Result<HeaderMap, Box<dyn std::error::Error + Send + Sync>> {
    let mut headers = HeaderMap::new();
    headers.insert(COOKIE, HeaderValue::from_str(&format!("sessionKey={}", session_key))?);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
    headers.insert(REFERER, HeaderValue::from_static("https://claude.ai"));
    headers.insert("Origin", HeaderValue::from_static("https://claude.ai"));
    headers.insert("anthropic-client-sha", HeaderValue::from_static("unknown"));
    headers.insert("anthropic-client-version", HeaderValue::from_static("unknown"));
    Ok(headers)
}

fn map_tier(t: ApiTier) -> UsageTier {
    UsageTier {
        percent_used: t.utilization,
        reset_at: t.resets_at,
        is_limited: t.is_limited,
    }
}

const DEFAULT_TIER: UsageTier = UsageTier {
    percent_used: 0.0,
    reset_at: None,
    is_limited: false,
};

// --- Fetch usage ---

pub async fn fetch_usage(
    session_key: &str,
    org_id: &str,
) -> Result<UsageData, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    let headers = build_headers(session_key)?;

    let usage_url = format!("https://claude.ai/api/organizations/{}/usage", org_id);
    let credits_url = format!("https://claude.ai/api/organizations/{}/prepaid/credits", org_id);

    let (usage_resp, credits_resp) = tokio::join!(
        client.get(&usage_url).headers(headers.clone()).send(),
        client.get(&credits_url).headers(headers).send(),
    );

    let usage_resp = usage_resp?;
    if !usage_resp.status().is_success() {
        return Err(format!("API error: {}", usage_resp.status()).into());
    }
    let api: ApiResponse = usage_resp.json().await?;

    let prepaid: Option<ApiPrepaidCredits> = match credits_resp {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        _ => None,
    };

    Ok(build_usage(api, prepaid))
}

/// Pure mapping from API shapes to `UsageData`. Credit values from the API are
/// in cents, so they're divided by 100; tier utilization is already a percent.
fn build_usage(api: ApiResponse, prepaid: Option<ApiPrepaidCredits>) -> UsageData {
    let extra_usage = api.extra_usage.and_then(|e| {
        if e.is_enabled {
            Some(ExtraUsage {
                used_credits: e.used_credits / 100.0,
                monthly_limit: e.monthly_limit / 100.0,
                utilization: e.utilization,
                currency: e.currency.unwrap_or_else(|| "USD".to_string()),
            })
        } else {
            None
        }
    });

    let (prepaid_balance, prepaid_currency) = match prepaid {
        Some(p) => (
            Some(p.amount / 100.0),
            Some(p.currency.unwrap_or_else(|| "USD".to_string())),
        ),
        None => (None, None),
    };

    UsageData {
        five_hour: api.five_hour.map(map_tier).unwrap_or(DEFAULT_TIER),
        seven_day: api.seven_day.map(map_tier).unwrap_or(DEFAULT_TIER),
        seven_day_opus: api.seven_day_opus.map(map_tier),
        seven_day_sonnet: api.seven_day_sonnet.map(map_tier),
        extra_usage,
        prepaid_balance,
        prepaid_currency,
    }
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

fn gen_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seed = t.as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (seed & 0xFFFFFFFF) as u32,
        ((seed >> 32) & 0xFFFF) as u16,
        ((seed >> 48) & 0x0FFF) as u16,
        (0x8000 | ((seed >> 60) & 0x3FFF)) as u16,
        ((seed >> 74) ^ (seed & 0xFFFFFFFFFFFF)) as u64 & 0xFFFFFFFFFFFF,
    )
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

    let conv_uuid = gen_uuid();

    let conv_url = format!(
        "https://claude.ai/api/organizations/{}/chat_conversations",
        org_id
    );
    let conv_body = serde_json::json!({
        "uuid": conv_uuid,
        "name": "",
        "project_uuid": project_id
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
        "prompt": "Hi",
        "model": "claude-haiku-4-5-20251001",
        "timezone": "UTC"
    });
    let resp = client
        .post(&msg_url)
        .headers(headers.clone())
        .json(&msg_body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Send message error {}: {}", status, text).into());
    }

    let del_url = format!(
        "https://claude.ai/api/organizations/{}/chat_conversations/{}",
        org_id, conv.uuid
    );
    let _ = client
        .delete(&del_url)
        .headers(headers)
        .send()
        .await;

    Ok(SessionStartResult {
        conversation_id: Some(conv.uuid),
        project_id: project_id.to_string(),
        skipped: false,
        reason: "started".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(api_json: &str, credits_json: Option<&str>) -> UsageData {
        let api: ApiResponse = serde_json::from_str(api_json).unwrap();
        let prepaid = credits_json.map(|c| serde_json::from_str(c).unwrap());
        build_usage(api, prepaid)
    }

    #[test]
    fn maps_tiers_and_converts_extra_cents() {
        let json = r#"{
            "five_hour": { "utilization": 19.0, "resets_at": "2026-01-01T00:00:00Z", "is_limited": false },
            "seven_day": { "utilization": 9.0, "resets_at": null, "is_limited": false },
            "seven_day_sonnet": { "utilization": 0.0 },
            "extra_usage": { "is_enabled": true, "monthly_limit": 3000, "used_credits": 888, "utilization": 29.6, "currency": "USD" }
        }"#;
        let credits = r#"{ "amount": 8500, "currency": "USD" }"#;
        let u = parse(json, Some(credits));

        assert_eq!(u.five_hour.percent_used, 19.0);
        assert_eq!(u.five_hour.reset_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(u.seven_day.percent_used, 9.0);
        assert!(u.seven_day_opus.is_none());
        assert_eq!(u.seven_day_sonnet.as_ref().unwrap().percent_used, 0.0);

        let e = u.extra_usage.unwrap();
        assert_eq!(e.used_credits, 8.88); // cents → dollars
        assert_eq!(e.monthly_limit, 30.0);
        assert_eq!(e.utilization, 29.6); // already a percent
        assert_eq!(e.currency, "USD");

        assert_eq!(u.prepaid_balance, Some(85.0)); // 8500 cents
        assert_eq!(u.prepaid_currency.as_deref(), Some("USD"));
    }

    #[test]
    fn missing_tiers_default_and_disabled_extra_is_none() {
        let json = r#"{
            "extra_usage": { "is_enabled": false, "monthly_limit": 3000, "used_credits": 0, "utilization": 0 }
        }"#;
        let u = parse(json, None);

        assert_eq!(u.five_hour.percent_used, 0.0);
        assert!(u.five_hour.reset_at.is_none());
        assert_eq!(u.seven_day.percent_used, 0.0);
        assert!(u.extra_usage.is_none(), "disabled extra usage → None");
        assert!(u.prepaid_balance.is_none());
    }

    #[test]
    fn extra_without_currency_defaults_usd() {
        let json = r#"{
            "five_hour": { "utilization": 5.0 },
            "seven_day": { "utilization": 5.0 },
            "extra_usage": { "is_enabled": true, "monthly_limit": 1000, "used_credits": 100, "utilization": 10.0 }
        }"#;
        let u = parse(json, None);
        assert_eq!(u.extra_usage.unwrap().currency, "USD");
    }
}
