use log::{debug, warn};
use reqwest::header::{HeaderMap, HeaderValue, COOKIE, CONTENT_TYPE, ACCEPT, USER_AGENT, REFERER};
use serde::{Deserialize, Serialize};

/// Human-readable classification of a reqwest failure. We never log the URL's
/// query or the session key — only the failure mode — so logs are safe to share
/// in a bug report.
fn describe_net_error(e: &reqwest::Error) -> String {
    let mut kinds = Vec::new();
    if e.is_timeout() {
        kinds.push("timeout");
    }
    if e.is_connect() {
        kinds.push("connect");
    }
    if e.is_request() {
        kinds.push("request");
    }
    if e.is_body() {
        kinds.push("body");
    }
    if e.is_decode() {
        kinds.push("decode");
    }
    if kinds.is_empty() {
        kinds.push("other");
    }
    let status = e
        .status()
        .map(|s| format!(", status={}", s))
        .unwrap_or_default();
    format!("{}{}: {}", kinds.join("+"), status, e)
}

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

/// Deserialize a scalar the API may send as an explicit `null`, falling back to
/// `T::default()`. `#[serde(default)]` alone only covers a *missing* key, not a
/// present `null` — and this API sends `null` liberally for inactive fields
/// (e.g. `extra_usage.utilization` is `null` when extra usage is unused).
fn null_default<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(de)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct ApiTier {
    #[serde(default, deserialize_with = "null_default")]
    utilization: f64,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    is_limited: bool,
}

#[derive(Debug, Deserialize)]
struct ApiExtraUsage {
    #[serde(default, deserialize_with = "null_default")]
    is_enabled: bool,
    #[serde(default, deserialize_with = "null_default")]
    monthly_limit: f64,
    #[serde(default, deserialize_with = "null_default")]
    used_credits: f64,
    // `null` when extra usage is enabled but unused — kept as None and derived
    // from used/limit in `build_usage` rather than defaulted blindly to 0.
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    currency: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiPrepaidCredits {
    #[serde(default, deserialize_with = "null_default")]
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
    // Diagnostics for the common "data won't fetch on another PC" report: we
    // log whether the inputs are present and their lengths — never the values.
    debug!(
        "fetch_usage: org_id_len={}, session_key_len={}",
        org_id.len(),
        session_key.len()
    );
    if session_key.is_empty() || org_id.is_empty() {
        warn!("fetch_usage: empty session_key or org_id");
    }

    let client = reqwest::Client::new();
    let headers = match build_headers(session_key) {
        Ok(h) => h,
        Err(e) => {
            // Most likely a session key with characters that aren't valid in an
            // HTTP header value (stray whitespace / non-ASCII from a bad paste).
            warn!("fetch_usage: invalid request headers (check the session key): {}", e);
            return Err(format!("Некорректный ключ сессии (заголовок запроса): {}", e).into());
        }
    };

    let usage_url = format!("https://claude.ai/api/organizations/{}/usage", org_id);
    let credits_url = format!("https://claude.ai/api/organizations/{}/prepaid/credits", org_id);

    let (usage_resp, credits_resp) = tokio::join!(
        client.get(&usage_url).headers(headers.clone()).send(),
        client.get(&credits_url).headers(headers).send(),
    );

    let usage_resp = match usage_resp {
        Ok(r) => r,
        Err(e) => {
            warn!("fetch_usage: usage request failed ({})", describe_net_error(&e));
            return Err(format!("Сетевая ошибка запроса usage: {}", describe_net_error(&e)).into());
        }
    };

    let status = usage_resp.status();
    if !status.is_success() {
        let body = usage_resp.text().await.unwrap_or_default();
        warn!(
            "fetch_usage: usage API returned {} (body {} bytes): {}",
            status,
            body.len(),
            snippet(&body)
        );
        let hint = match status.as_u16() {
            401 | 403 => " — ключ сессии недействителен или истёк",
            404 => " — проверьте Organization ID",
            _ => "",
        };
        return Err(format!("API вернул {}{}", status, hint).into());
    }

    // Read as text first so a non-JSON response (e.g. an HTML login page when the
    // session cookie is rejected) shows up as a readable snippet in the log
    // instead of an opaque "decode error".
    let body = usage_resp
        .text()
        .await
        .map_err(|e| format!("Не удалось прочитать тело ответа usage: {}", describe_net_error(&e)))?;
    let api: ApiResponse = serde_json::from_str(&body).map_err(|e| {
        warn!(
            "fetch_usage: usage body is not the expected JSON ({} bytes): {}",
            body.len(),
            snippet(&body)
        );
        format!("Ответ usage — не ожидаемый JSON: {}", e)
    })?;
    debug!("fetch_usage: usage parsed OK ({} bytes)", body.len());

    let prepaid: Option<ApiPrepaidCredits> = match credits_resp {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        Ok(r) => {
            debug!("fetch_usage: credits API returned {} (ignored)", r.status());
            None
        }
        Err(e) => {
            debug!("fetch_usage: credits request failed, ignored ({})", describe_net_error(&e));
            None
        }
    };

    Ok(build_usage(api, prepaid))
}

/// First ~200 chars of a response body, single-lined, for safe logging.
fn snippet(s: &str) -> String {
    let one_line: String = s.chars().take(200).collect::<String>().replace('\n', " ");
    if s.len() > 200 {
        format!("{}…", one_line)
    } else {
        one_line
    }
}

/// Pure mapping from API shapes to `UsageData`. Credit values from the API are
/// in cents, so they're divided by 100; tier utilization is already a percent.
fn build_usage(api: ApiResponse, prepaid: Option<ApiPrepaidCredits>) -> UsageData {
    let extra_usage = api.extra_usage.and_then(|e| {
        if e.is_enabled {
            // The API may omit/null `utilization` (enabled but unused); derive it
            // from used/limit so a 0-balance account reads as 0%, not a crash.
            let utilization = e.utilization.unwrap_or_else(|| {
                if e.monthly_limit > 0.0 {
                    e.used_credits / e.monthly_limit * 100.0
                } else {
                    0.0
                }
            });
            Some(ExtraUsage {
                used_credits: e.used_credits / 100.0,
                monthly_limit: e.monthly_limit / 100.0,
                utilization,
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
    fn parses_real_response_with_null_extra_utilization_and_unknown_tiers() {
        // Verbatim payload from a user whose fetch crashed at the
        // `extra_usage.utilization: null` field (#473). Also exercises unknown
        // tier keys the API added (oauth_apps/cowork/omelette/tangelo/…) which
        // must be ignored, and a 0-balance enabled extra-usage account.
        let json = r#"{
            "five_hour": {"utilization":73.0,"resets_at":"2026-05-29T13:30:00.550752+00:00"},
            "seven_day": {"utilization":14.0,"resets_at":"2026-06-01T03:00:00.550774+00:00"},
            "seven_day_oauth_apps": null,
            "seven_day_opus": null,
            "seven_day_sonnet": {"utilization":0.0,"resets_at":null},
            "seven_day_cowork": null,
            "seven_day_omelette": null,
            "tangelo": null,
            "iguana_necktie": null,
            "omelette_promotional": null,
            "extra_usage": {"is_enabled":true,"monthly_limit":2000,"used_credits":0.0,"utilization":null,"currency":"USD","disabled_reason":null}
        }"#;
        let u = parse(json, None);

        assert_eq!(u.five_hour.percent_used, 73.0);
        assert_eq!(u.seven_day.percent_used, 14.0);
        assert!(u.seven_day_opus.is_none());
        assert_eq!(u.seven_day_sonnet.as_ref().unwrap().percent_used, 0.0);

        // Enabled but unused: null utilization derived from used/limit → 0%.
        let e = u.extra_usage.expect("enabled extra usage is present");
        assert_eq!(e.used_credits, 0.0);
        assert_eq!(e.monthly_limit, 20.0); // 2000 cents → dollars
        assert_eq!(e.utilization, 0.0);
        assert_eq!(e.currency, "USD");
    }

    #[test]
    fn null_scalars_throughout_do_not_crash() {
        // "Everything null" disabled-extra shape: every scalar arrives as null.
        let json = r#"{
            "five_hour": {"utilization":null,"resets_at":null,"is_limited":null},
            "seven_day": {"utilization":null,"resets_at":null,"is_limited":null},
            "extra_usage": {"is_enabled":null,"monthly_limit":null,"used_credits":null,"utilization":null,"currency":null}
        }"#;
        let u = parse(json, Some(r#"{ "amount": null, "currency": null }"#));
        assert_eq!(u.five_hour.percent_used, 0.0);
        assert!(!u.five_hour.is_limited);
        assert!(u.extra_usage.is_none(), "is_enabled null → disabled → None");
        assert_eq!(u.prepaid_balance, Some(0.0));
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
