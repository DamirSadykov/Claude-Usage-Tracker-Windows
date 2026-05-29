//! Claude service-status polling. Talks to the public Statuspage v2 API at
//! status.claude.com (no auth). Kept symmetrical with `usage.rs`: a thin async
//! `fetch_status` over reqwest plus a pure `build_status` mapping that the unit
//! tests exercise without the network. The polling loop, caching of the ETag and
//! change-detection live in `lib.rs`.

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ETAG, IF_NONE_MATCH, USER_AGENT};
use serde::{Deserialize, Serialize};

const SUMMARY_URL: &str = "https://status.claude.com/api/v2/summary.json";
pub const STATUS_PAGE_URL: &str = "https://status.claude.com/";

// --- What we push to the frontend ---

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ServiceStatus {
    /// `none` | `minor` | `major` | `critical`.
    pub indicator: String,
    /// Ready-made human-readable summary, e.g. "All Systems Operational".
    pub description: String,
    pub incidents: Vec<Incident>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Incident {
    pub id: String,
    pub name: String,
    /// `investigating` | `identified` | `monitoring` | `resolved`.
    pub status: String,
    /// Impact level, same scale as the overall indicator.
    pub impact: String,
    pub shortlink: Option<String>,
    pub updated_at: Option<String>,
    /// Names of the affected components.
    pub components: Vec<String>,
}

/// Result of a conditional GET: either nothing changed (304) or a fresh payload
/// with the server's new ETag (when present).
pub enum StatusFetch {
    NotModified,
    Modified {
        status: ServiceStatus,
        etag: Option<String>,
    },
}

// --- API response shapes (Statuspage v2 `summary.json`) ---

#[derive(Debug, Deserialize)]
struct ApiSummary {
    status: ApiStatus,
    #[serde(default)]
    incidents: Vec<ApiIncident>,
}

#[derive(Debug, Deserialize)]
struct ApiStatus {
    #[serde(default)]
    indicator: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Deserialize)]
struct ApiIncident {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    impact: String,
    #[serde(default)]
    shortlink: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    components: Vec<ApiComponent>,
}

#[derive(Debug, Deserialize)]
struct ApiComponent {
    #[serde(default)]
    name: String,
}

// --- Fetch ---

pub async fn fetch_status(
    etag: Option<&str>,
) -> Result<StatusFetch, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("ClaudeUsageTracker (status indicator)"),
    );
    if let Some(tag) = etag {
        if let Ok(v) = HeaderValue::from_str(tag) {
            headers.insert(IF_NONE_MATCH, v);
        }
    }

    let resp = client.get(SUMMARY_URL).headers(headers).send().await?;

    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(StatusFetch::NotModified);
    }
    if !resp.status().is_success() {
        return Err(format!("Status API error: {}", resp.status()).into());
    }

    let new_etag = resp
        .headers()
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let api: ApiSummary = resp.json().await?;

    Ok(StatusFetch::Modified {
        status: build_status(api),
        etag: new_etag,
    })
}

/// Pure mapping from the API shape to `ServiceStatus`. Unresolved incidents only
/// — `summary.json` already excludes resolved ones.
fn build_status(api: ApiSummary) -> ServiceStatus {
    let incidents = api
        .incidents
        .into_iter()
        .map(|i| Incident {
            id: i.id,
            name: i.name,
            status: i.status,
            impact: i.impact,
            shortlink: i.shortlink,
            updated_at: i.updated_at,
            components: i.components.into_iter().map(|c| c.name).collect(),
        })
        .collect();

    ServiceStatus {
        indicator: if api.status.indicator.is_empty() {
            "none".to_string()
        } else {
            api.status.indicator
        },
        description: api.status.description,
        incidents,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> ServiceStatus {
        build_status(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn maps_all_systems_operational() {
        let json = r#"{
            "page": { "id": "tymt9n04zgry", "name": "Claude" },
            "status": { "indicator": "none", "description": "All Systems Operational" },
            "components": [],
            "incidents": [],
            "scheduled_maintenances": []
        }"#;
        let s = parse(json);
        assert_eq!(s.indicator, "none");
        assert_eq!(s.description, "All Systems Operational");
        assert!(s.incidents.is_empty());
    }

    #[test]
    fn maps_active_incident_with_components() {
        let json = r#"{
            "status": { "indicator": "major", "description": "Partial Outage" },
            "incidents": [{
                "id": "abc123",
                "name": "Elevated error rates",
                "status": "investigating",
                "impact": "major",
                "shortlink": "https://stspg.io/x",
                "updated_at": "2026-05-29T10:00:00Z",
                "components": [{ "name": "API" }, { "name": "Claude.ai" }]
            }]
        }"#;
        let s = parse(json);
        assert_eq!(s.indicator, "major");
        assert_eq!(s.incidents.len(), 1);
        let inc = &s.incidents[0];
        assert_eq!(inc.id, "abc123");
        assert_eq!(inc.name, "Elevated error rates");
        assert_eq!(inc.status, "investigating");
        assert_eq!(inc.impact, "major");
        assert_eq!(inc.shortlink.as_deref(), Some("https://stspg.io/x"));
        assert_eq!(inc.components, vec!["API", "Claude.ai"]);
    }

    #[test]
    fn empty_indicator_defaults_to_none() {
        let json = r#"{ "status": { "description": "" }, "incidents": [] }"#;
        let s = parse(json);
        assert_eq!(s.indicator, "none");
    }
}
