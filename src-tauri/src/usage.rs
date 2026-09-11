use std::sync::{Arc, LazyLock};
use std::time::Duration;

use log::{debug, info, warn};
use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, REFERER, SERVER, SET_COOKIE, USER_AGENT};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Один shared `reqwest::Client` на всё приложение: переиспользует
/// connection pool и HTTP/2 stream, не плодит TCP/TLS handshake на каждый
/// запрос — иначе claude.ai/Cloudflare видят «N разных клиентов с одной
/// cookie» и отвечают 429.
/// `cookie_store` — Cloudflare выдаёт `__cf_bm` в ответе и ждёт её обратно;
/// без хранилища каждый запрос выглядит как первый визит и рано или поздно
/// ловит страницу проверки вместо данных.
static COOKIE_JAR: LazyLock<Arc<Jar>> = LazyLock::new(|| Arc::new(Jar::default()));

static CLAUDE_URL: LazyLock<Url> = LazyLock::new(|| Url::parse("https://claude.ai/").unwrap());

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .cookie_provider(COOKIE_JAR.clone())
        .build()
        .expect("failed to build shared reqwest::Client")
});

/// Сериализует исходящие запросы к claude.ai, чтобы auto-start не
/// конкурировал во времени с polling fetch_usage (одновременные запросы
/// с одной cookie ловят CF burst-limit).
static CLAUDE_API_LOCK: Mutex<()> = Mutex::const_new(());

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
    // Per-model weekly limits, as the API now reports them in `limits[]` with
    // `kind: "weekly_scoped"` and a `scope.model.display_name` (e.g. "Fable").
    // The old flat `seven_day_opus/sonnet` fields are kept above for backward
    // compat, but the API has started sending them as `null` and moving the
    // active scoped limit into `limits[]` — so the model shown here is dynamic,
    // not a fixed Opus/Sonnet pair.
    pub scoped_weekly: Vec<ScopedTier>,
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

/// A weekly limit scoped to a single model, carried over from the API's
/// `limits[]` array. `model` is the human label (`scope.model.display_name`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScopedTier {
    pub model: String,
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
    limits: Vec<ApiLimit>,
    #[serde(default)]
    extra_usage: Option<ApiExtraUsage>,
}

/// One entry of the API's `limits[]`. We only consume `weekly_scoped` ones (a
/// per-model weekly cap); `session` / `weekly_all` duplicate the flat tiers we
/// already read. `percent` is an integer-ish percent; `severity` gates the
/// "limit reached" badge.
#[derive(Debug, Deserialize)]
struct ApiLimit {
    #[serde(default)]
    kind: String,
    #[serde(default, deserialize_with = "null_default")]
    percent: f64,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    scope: Option<ApiScope>,
}

#[derive(Debug, Deserialize)]
struct ApiScope {
    #[serde(default)]
    model: Option<ApiScopeModel>,
}

#[derive(Debug, Deserialize)]
struct ApiScopeModel {
    #[serde(default)]
    display_name: Option<String>,
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

/// Держать в согласии с версией Chrome, которую заявляет встроенный webview:
/// Cloudflare привязывает `cf_clearance` к паре IP + User-Agent, поэтому
/// разъехавшиеся строки обесценят cookie, добытую входом через webview.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/// Заголовки как у macOS-оригинала: `Accept`, браузерный `User-Agent`,
/// `Referer` и `Origin` — и ничего сверх того. `Content-Type` на GET и
/// `anthropic-client-*` со значением `unknown` отсюда убраны: браузер их не
/// шлёт, а для POST `Content-Type` проставит сам `RequestBuilder::json`.
fn build_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_UA));
    headers.insert(REFERER, HeaderValue::from_static("https://claude.ai"));
    headers.insert("Origin", HeaderValue::from_static("https://claude.ai"));
    headers
}

fn session_key_is_cookie_safe(session_key: &str) -> bool {
    !session_key.is_empty()
        && session_key
            .chars()
            .all(|c| c.is_ascii_graphic() && c != ';' && c != ',' && c != '"' && c != '\\')
}

fn install_session_cookie(session_key: &str) -> Result<(), FetchError> {
    if !session_key_is_cookie_safe(session_key) {
        warn!(
            "prepare_request: verdict={} blame={} session_key_len={} (символы вне ASCII, пробелы или `;`)",
            Verdict::BadSessionKey.code(),
            Verdict::BadSessionKey.blame(),
            session_key.len()
        );
        return Err(FetchError::new(
            Verdict::BadSessionKey,
            message_for(Verdict::BadSessionKey, StatusCode::OK, "недопустимые символы (пробел, `;`, не-ASCII)"),
        ));
    }
    COOKIE_JAR.add_cookie_str(
        &format!("sessionKey={}; Path=/; Secure; HttpOnly", session_key),
        &CLAUDE_URL,
    );
    let names = cookie_names_for(&CLAUDE_URL);
    if !names.iter().any(|n| n == "sessionKey") {
        warn!(
            "prepare_request: verdict={} blame={} cookie store rejected sessionKey (cookies=[{}])",
            Verdict::BadSessionKey.code(),
            Verdict::BadSessionKey.blame(),
            names.join(",")
        );
        return Err(FetchError::new(
            Verdict::BadSessionKey,
            message_for(Verdict::BadSessionKey, StatusCode::OK, "хранилище cookie его не приняло"),
        ));
    }
    Ok(())
}

fn prepare_request(session_key: &str) -> Result<HeaderMap, FetchError> {
    install_session_cookie(session_key)?;
    Ok(build_headers())
}

fn cookie_names_for(url: &Url) -> Vec<String> {
    COOKIE_JAR
        .cookies(url)
        .and_then(|v| v.to_str().map(str::to_string).ok())
        .map(|s| {
            s.split(';')
                .filter_map(|pair| pair.trim().split('=').next().map(str::to_string))
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn set_cookie_names(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|s| s.split('=').next().map(|n| n.trim().to_string()))
        .collect()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("-")
}

struct ResponseFacts {
    status: StatusCode,
    final_url: Url,
    cf_ray: String,
    cf_mitigated: bool,
    server: String,
    content_type: String,
    set_cookie: Vec<String>,
    cookies_sent: Vec<String>,
}

impl ResponseFacts {
    fn capture(resp: &reqwest::Response, cookies_sent: Vec<String>) -> Self {
        let h = resp.headers();
        Self {
            status: resp.status(),
            final_url: resp.url().clone(),
            cf_ray: header_str(h, "cf-ray").to_string(),
            cf_mitigated: h.contains_key("cf-mitigated"),
            server: header_str(h, SERVER.as_str()).to_string(),
            content_type: header_str(h, CONTENT_TYPE.as_str()).to_string(),
            set_cookie: set_cookie_names(h),
            cookies_sent,
        }
    }

    fn describe(&self, body: &str) -> String {
        format!(
            "status={} cf_ray={} cf_mitigated={} server={} content_type={} body={}B html={} cookies_sent=[{}] set_cookie=[{}] final_url={}",
            self.status,
            self.cf_ray,
            self.cf_mitigated,
            self.server,
            self.content_type,
            body.len(),
            body.trim_start().starts_with('<'),
            self.cookies_sent.join(","),
            self.set_cookie.join(","),
            self.final_url
        )
    }
}

fn log_verdict(verdict: Verdict, facts: &ResponseFacts, body: &str) {
    let line = format!(
        "fetch_usage: verdict={} blame={} {}",
        verdict.code(),
        verdict.blame(),
        facts.describe(body)
    );
    if verdict == Verdict::Ok {
        info!("{}", line);
    } else {
        warn!("{} snippet: {}", line, snippet(body));
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    CloudflareChallenge,
    SessionRejected,
    LoginRedirect,
    BadSessionKey,
    OrgNotFound,
    ClaudeOutage,
    HttpOther,
    Network,
    BadJson,
}

impl Verdict {
    pub fn code(self) -> &'static str {
        match self {
            Verdict::Ok => "ok",
            Verdict::CloudflareChallenge => "cloudflare_challenge",
            Verdict::SessionRejected => "session_rejected",
            Verdict::LoginRedirect => "login_redirect",
            Verdict::BadSessionKey => "bad_session_key",
            Verdict::OrgNotFound => "org_not_found",
            Verdict::ClaudeOutage => "claude_outage",
            Verdict::HttpOther => "http_error",
            Verdict::Network => "network",
            Verdict::BadJson => "bad_json",
        }
    }

    pub fn blame(self) -> &'static str {
        match self {
            Verdict::Ok => "none",
            Verdict::CloudflareChallenge => "cloudflare",
            Verdict::SessionRejected | Verdict::LoginRedirect | Verdict::BadSessionKey => "session_key",
            Verdict::OrgNotFound => "org_id",
            Verdict::ClaudeOutage => "claude",
            Verdict::Network => "network",
            Verdict::HttpOther | Verdict::BadJson => "unknown",
        }
    }

    pub fn session_expired(self) -> bool {
        matches!(self, Verdict::SessionRejected | Verdict::LoginRedirect)
    }
}

/// A failed usage fetch. `session_expired` is the one bit the UI acts on: it's
/// set only when the failure is specifically a rejected/expired session cookie
/// — an HTTP 401/403 carrying the API's own JSON refusal, or a redirect to the
/// login page (claude.ai answering an unauthenticated API call with HTML instead
/// of a 401). Network errors, a wrong org id (404), a Claude outage (5xx) and a
/// Cloudflare challenge — which also arrives as 403, but with an HTML page the
/// API never sent — are NOT expired-cookie: they leave this false so the UI
/// doesn't wrongly send the user to re-enter a perfectly valid key.
#[derive(Debug)]
pub struct FetchError {
    pub message: String,
    pub session_expired: bool,
    pub verdict: Verdict,
}

impl FetchError {
    fn new(verdict: Verdict, message: String) -> Self {
        Self { message, session_expired: verdict.session_expired(), verdict }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FetchError {}

/// Heuristic for "the server bounced us to a login page". A 2xx whose body isn't
/// the expected JSON is almost always claude.ai serving its HTML login shell (or
/// a redirect landing there) because the session cookie was rejected — so we
/// read it as an expired key rather than an opaque "unexpected JSON".
/// Cloudflare's interstitial rather than an answer from the API. It comes back
/// as a 403 with an HTML page — indistinguishable from a rejected cookie by
/// status alone, which is exactly how a valid key gets blamed. The API's own
/// refusal is always JSON (`account_session_invalid`), so the markers below are
/// unambiguous; `cf-mitigated` is also sent as a response header.
fn is_cloudflare_challenge(body: &str) -> bool {
    body.contains("Just a moment") || body.contains("cf-mitigated")
}

const CLOUDFLARE_CHALLENGE_MESSAGE: &str =
    "Запрос заблокирован защитой Cloudflare — ключ сессии, скорее всего, действителен. \
     Обычно проходит при следующем обновлении; если повторяется, войдите в claude.ai в браузере.";

fn classify_response(status: StatusCode, cf_mitigated: bool, final_url: &Url, body: &str) -> Verdict {
    if cf_mitigated || is_cloudflare_challenge(body) {
        return Verdict::CloudflareChallenge;
    }
    match status.as_u16() {
        401 | 403 => Verdict::SessionRejected,
        404 => Verdict::OrgNotFound,
        500..=599 => Verdict::ClaudeOutage,
        200..=299 if looks_like_login_page(final_url, body) => Verdict::LoginRedirect,
        200..=299 => Verdict::BadJson,
        _ => Verdict::HttpOther,
    }
}

fn message_for(verdict: Verdict, status: StatusCode, detail: &str) -> String {
    match verdict {
        Verdict::CloudflareChallenge => CLOUDFLARE_CHALLENGE_MESSAGE.to_string(),
        Verdict::SessionRejected => format!("API вернул {} — ключ сессии недействителен или истёк", status),
        Verdict::LoginRedirect => "Ключ сессии истёк — Claude вернул страницу входа вместо данных".to_string(),
        Verdict::OrgNotFound => format!("API вернул {} — проверьте Organization ID", status),
        Verdict::ClaudeOutage => format!("API вернул {} — сервис Claude временно недоступен, повторите позже", status),
        Verdict::HttpOther => format!("API вернул {}", status),
        Verdict::BadJson => format!("Ответ usage — не ожидаемый JSON: {}", detail),
        Verdict::Network => format!("Сетевая ошибка запроса usage: {}", detail),
        Verdict::BadSessionKey => format!("Некорректный ключ сессии: {}", detail),
        Verdict::Ok => String::new(),
    }
}

fn looks_like_login_page(final_url: &Url, body: &str) -> bool {
    let path = final_url.path();
    let redirected_away = final_url.host_str() != Some("claude.ai")
        || path.contains("login")
        || path.contains("auth");
    let html = body.trim_start().starts_with('<');
    redirected_away || html
}

pub async fn fetch_usage(session_key: &str, org_id: &str) -> Result<UsageData, FetchError> {
    debug!(
        "fetch_usage: org_id_len={}, session_key_len={}",
        org_id.len(),
        session_key.len()
    );
    if session_key.is_empty() || org_id.is_empty() {
        warn!("fetch_usage: empty session_key or org_id");
    }

    let _api_guard = CLAUDE_API_LOCK.lock().await;
    let client = &*HTTP_CLIENT;
    let headers = prepare_request(session_key)?;

    let usage_url = format!("https://claude.ai/api/organizations/{}/usage", org_id);
    let credits_url = format!("https://claude.ai/api/organizations/{}/prepaid/credits", org_id);

    let cookies_sent = cookie_names_for(&CLAUDE_URL);
    debug!(
        "fetch_usage: GET usage cookies=[{}] ua={}",
        cookies_sent.join(","),
        BROWSER_UA
    );

    let usage_resp = client.get(&usage_url).headers(headers.clone()).send().await;

    let usage_resp = match usage_resp {
        Ok(r) => r,
        Err(e) => {
            let detail = describe_net_error(&e);
            warn!(
                "fetch_usage: verdict={} blame={} cookies_sent=[{}] error={}",
                Verdict::Network.code(),
                Verdict::Network.blame(),
                cookies_sent.join(","),
                detail
            );
            return Err(FetchError::new(Verdict::Network, message_for(Verdict::Network, StatusCode::OK, &detail)));
        }
    };

    let facts = ResponseFacts::capture(&usage_resp, cookies_sent);
    let body = match usage_resp.text().await {
        Ok(b) => b,
        Err(e) => {
            let detail = describe_net_error(&e);
            warn!(
                "fetch_usage: verdict={} blame={} {} error={}",
                Verdict::Network.code(),
                Verdict::Network.blame(),
                facts.describe(""),
                detail
            );
            return Err(FetchError::new(
                Verdict::Network,
                format!("Не удалось прочитать тело ответа usage: {}", detail),
            ));
        }
    };

    if !facts.status.is_success() {
        let verdict = classify_response(facts.status, facts.cf_mitigated, &facts.final_url, &body);
        log_verdict(verdict, &facts, &body);
        return Err(FetchError::new(verdict, message_for(verdict, facts.status, "")));
    }

    let api: ApiResponse = match serde_json::from_str(&body) {
        Ok(api) => api,
        Err(e) => {
            let verdict = classify_response(facts.status, facts.cf_mitigated, &facts.final_url, &body);
            log_verdict(verdict, &facts, &body);
            return Err(FetchError::new(verdict, message_for(verdict, facts.status, &e.to_string())));
        }
    };
    log_verdict(Verdict::Ok, &facts, &body);

    let credits_resp = client.get(&credits_url).headers(headers).send().await;

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

    // Pull the per-model weekly caps out of `limits[]`. Keep only `weekly_scoped`
    // entries that actually name a model — a scope with no display_name can't be
    // labelled, so it's dropped rather than shown as an anonymous bar.
    let scoped_weekly = api
        .limits
        .into_iter()
        .filter(|l| l.kind == "weekly_scoped")
        .filter_map(|l| {
            let model = l
                .scope
                .and_then(|s| s.model)
                .and_then(|m| m.display_name)
                .filter(|n| !n.is_empty())?;
            Some(ScopedTier {
                model,
                percent_used: l.percent,
                reset_at: l.resets_at,
                is_limited: l.severity.as_deref() == Some("critical"),
            })
        })
        .collect();

    UsageData {
        five_hour: api.five_hour.map(map_tier).unwrap_or(DEFAULT_TIER),
        seven_day: api.seven_day.map(map_tier).unwrap_or(DEFAULT_TIER),
        seven_day_opus: api.seven_day_opus.map(map_tier),
        seven_day_sonnet: api.seven_day_sonnet.map(map_tier),
        scoped_weekly,
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
    let _api_guard = CLAUDE_API_LOCK.lock().await;
    let client = &*HTTP_CLIENT;
    let headers = prepare_request(session_key)?;

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

    start_session_unchecked(session_key, org_id, project_id).await
}

pub async fn start_session_unchecked(
    session_key: &str,
    org_id: &str,
    project_id: &str,
) -> Result<SessionStartResult, Box<dyn std::error::Error + Send + Sync>> {
    let _api_guard = CLAUDE_API_LOCK.lock().await;
    let client = &*HTTP_CLIENT;
    let headers = prepare_request(session_key)?;

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

    #[test]
    fn scoped_weekly_limits_are_extracted_by_model() {
        // Real Max-5x payload: seven_day_sonnet/opus are null and the active
        // per-model weekly cap has moved into limits[] as a `weekly_scoped`
        // entry scoped to "Fable". session / weekly_all rows must be ignored.
        let json = r#"{
            "five_hour": {"utilization":3.0,"resets_at":"2026-07-07T07:10:00Z"},
            "seven_day": {"utilization":22.0,"resets_at":"2026-07-12T11:00:00Z"},
            "seven_day_opus": null,
            "seven_day_sonnet": null,
            "limits": [
                {"kind":"session","group":"session","percent":3,"severity":"normal","resets_at":"2026-07-07T07:10:00Z","scope":null,"is_active":false},
                {"kind":"weekly_all","group":"weekly","percent":22,"severity":"normal","resets_at":"2026-07-12T11:00:00Z","scope":null,"is_active":true},
                {"kind":"weekly_scoped","group":"weekly","percent":2,"severity":"normal","resets_at":"2026-07-12T11:00:00Z","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
            ]
        }"#;
        let u = parse(json, None);

        assert!(u.seven_day_opus.is_none());
        assert!(u.seven_day_sonnet.is_none());
        assert_eq!(u.scoped_weekly.len(), 1, "only the weekly_scoped row is kept");
        let f = &u.scoped_weekly[0];
        assert_eq!(f.model, "Fable");
        assert_eq!(f.percent_used, 2.0);
        assert_eq!(f.reset_at.as_deref(), Some("2026-07-12T11:00:00Z"));
        assert!(!f.is_limited, "severity=normal → not limited");
    }

    #[test]
    fn scoped_weekly_absent_when_no_limits() {
        // Old-shape payload without a limits[] array → empty scoped list, no panic.
        let json = r#"{
            "five_hour": { "utilization": 5.0 },
            "seven_day": { "utilization": 5.0 }
        }"#;
        let u = parse(json, None);
        assert!(u.scoped_weekly.is_empty());
    }

    #[test]
    fn cloudflare_challenge_is_told_apart_from_a_rejected_key() {
        // Verbatim opening of the 5.5 KB page claude.ai served on 2026-08-04
        // while the session key was in fact valid.
        let challenge = r#"<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--><title>Just a moment...</title>"#;
        assert!(is_cloudflare_challenge(challenge));

        // The API's own refusal for a genuinely bad key — JSON, 214 bytes.
        let rejected = r#"{"type":"error","error":{"type":"permission_error","message":"Invalid authorization","details":{"error_code":"account_session_invalid"}}}"#;
        assert!(!is_cloudflare_challenge(rejected), "a real auth failure must stay an auth failure");

        // Real usage payloads must never trip the check either.
        assert!(!is_cloudflare_challenge(r#"{"five_hour":{"utilization":19.0}}"#));
    }

    #[test]
    fn challenge_error_does_not_claim_the_key_expired() {
        let e = FetchError::new(
            Verdict::CloudflareChallenge,
            message_for(Verdict::CloudflareChallenge, StatusCode::FORBIDDEN, ""),
        );
        assert!(!e.session_expired, "the UI must not ask for a new key on a challenge");
        assert!(e.message.contains("Cloudflare"));
        assert_eq!(e.verdict.blame(), "cloudflare");
    }

    #[test]
    fn verdict_names_the_guilty_side() {
        let usage = Url::parse("https://claude.ai/api/organizations/x/usage").unwrap();
        let challenge = "<!DOCTYPE html><title>Just a moment...</title>";
        let rejected = r#"{"type":"error","error":{"details":{"error_code":"account_session_invalid"}}}"#;

        assert_eq!(classify_response(StatusCode::FORBIDDEN, false, &usage, challenge), Verdict::CloudflareChallenge);
        assert_eq!(classify_response(StatusCode::FORBIDDEN, true, &usage, "{}"), Verdict::CloudflareChallenge);
        assert_eq!(classify_response(StatusCode::FORBIDDEN, false, &usage, rejected), Verdict::SessionRejected);
        assert_eq!(classify_response(StatusCode::UNAUTHORIZED, false, &usage, rejected), Verdict::SessionRejected);
        assert_eq!(classify_response(StatusCode::NOT_FOUND, false, &usage, "{}"), Verdict::OrgNotFound);
        assert_eq!(classify_response(StatusCode::SERVICE_UNAVAILABLE, false, &usage, "down"), Verdict::ClaudeOutage);
        assert_eq!(classify_response(StatusCode::OK, false, &usage, "<!DOCTYPE html>"), Verdict::LoginRedirect);
        let login = Url::parse("https://claude.ai/login").unwrap();
        assert_eq!(classify_response(StatusCode::OK, false, &login, "{}"), Verdict::LoginRedirect);
        assert_eq!(classify_response(StatusCode::OK, false, &usage, "[]"), Verdict::BadJson);
        assert_eq!(classify_response(StatusCode::TOO_MANY_REQUESTS, false, &usage, "{}"), Verdict::HttpOther);

        assert!(Verdict::SessionRejected.session_expired());
        assert!(Verdict::LoginRedirect.session_expired());
        assert!(!Verdict::CloudflareChallenge.session_expired());
        assert!(!Verdict::OrgNotFound.session_expired());
        assert_eq!(Verdict::SessionRejected.blame(), "session_key");
        assert_eq!(Verdict::OrgNotFound.blame(), "org_id");
        assert_eq!(Verdict::ClaudeOutage.blame(), "claude");
    }

    #[test]
    fn session_key_goes_through_the_cookie_store() {
        assert!(session_key_is_cookie_safe("sk-ant-sid01-abcDEF_-123"));
        assert!(!session_key_is_cookie_safe(""));
        assert!(!session_key_is_cookie_safe("sk-ant sid"));
        assert!(!session_key_is_cookie_safe("sk;ant"));
        assert!(!session_key_is_cookie_safe("sk-ant-ключ"));

        assert!(install_session_cookie("sk-ant-sid01-abc").is_ok());
        let names = cookie_names_for(&CLAUDE_URL);
        assert!(names.iter().any(|n| n == "sessionKey"), "cookies={:?}", names);
        let api_url = Url::parse("https://claude.ai/api/organizations/x/usage").unwrap();
        assert!(cookie_names_for(&api_url).iter().any(|n| n == "sessionKey"));

        let e = install_session_cookie("bad key").unwrap_err();
        assert_eq!(e.verdict, Verdict::BadSessionKey);
        assert!(!e.session_expired);
    }

    async fn cookie_echo_server(seen: Arc<std::sync::Mutex<Vec<String>>>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = sock.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf).into_owned();
                    let cookie = head
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("cookie:"))
                        .map(|l| l["cookie:".len()..].trim().to_string())
                        .unwrap_or_default();
                    seen.lock().unwrap().push(cookie);
                    let body = "{}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: __cf_bm=cf-token; Path=/; HttpOnly\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    sock.write_all(resp.as_bytes()).await.unwrap();
                    sock.shutdown().await.ok();
                });
            }
        });
        format!("http://{}/", addr)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cookie_store_sends_cloudflare_cookie_back_only_without_a_manual_cookie_header() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = cookie_echo_server(seen.clone()).await;
        let base_url = Url::parse(&base).unwrap();
        let jar = Arc::new(Jar::default());
        jar.add_cookie_str("sessionKey=sk-test; Path=/", &base_url);
        let client = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .no_proxy()
            .build()
            .unwrap();
        let url = format!("{}api/usage", base);

        client.get(&url).headers(build_headers()).send().await.unwrap();
        client.get(&url).headers(build_headers()).send().await.unwrap();
        client
            .get(&url)
            .headers(build_headers())
            .header(reqwest::header::COOKIE, "sessionKey=sk-test")
            .send()
            .await
            .unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 3);
        assert!(seen[0].contains("sessionKey=sk-test") && !seen[0].contains("__cf_bm"), "first visit: {}", seen[0]);
        assert!(seen[1].contains("sessionKey=sk-test") && seen[1].contains("__cf_bm=cf-token"), "second visit: {}", seen[1]);
        assert!(!seen[2].contains("__cf_bm"), "manual Cookie header must silence the store (0.13.1 bug): {}", seen[2]);
    }

    #[test]
    fn set_cookie_names_are_logged_without_values() {
        let mut h = HeaderMap::new();
        h.append(SET_COOKIE, HeaderValue::from_static("__cf_bm=secret; Path=/; HttpOnly"));
        h.append(SET_COOKIE, HeaderValue::from_static("cf_clearance=secret2; Path=/"));
        let names = set_cookie_names(&h);
        assert_eq!(names, vec!["__cf_bm", "cf_clearance"]);
        assert!(!names.join(",").contains("secret"));
    }

    #[test]
    fn login_page_is_recognised_as_expired_cookie() {
        let usage = Url::parse("https://claude.ai/api/organizations/x/usage").unwrap();
        // Real JSON on the real endpoint → not a login page.
        assert!(!looks_like_login_page(&usage, r#"{"seven_day":{}}"#));
        // 2xx on the endpoint but an HTML shell came back → expired cookie.
        assert!(looks_like_login_page(&usage, "<!DOCTYPE html><html>…"));
        // Redirected to /login (even with a non-HTML body) → expired.
        let login = Url::parse("https://claude.ai/login").unwrap();
        assert!(looks_like_login_page(&login, "whatever"));
        // Bounced to a different host (auth provider) → expired.
        let other = Url::parse("https://auth.anthropic.com/authorize").unwrap();
        assert!(looks_like_login_page(&other, "{}"));
    }
}
