//! HTTP handlers. Kept thin: authentication lives in `auth`, dedup/delivery in
//! `store`, both unit-tested there. The handlers wire those together and map
//! failures to `401`/`500`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;

use crate::model::{Envelope, MessageOut};
use crate::{auth, AppState};

type ApiError = (StatusCode, String);

pub async fn health() -> &'static str {
    "ok"
}

/// `external module -> resolver`: authenticate by per-source ingest token, then
/// dedup + append to the mailbox. Duplicate = `200` (idempotent), new = `202`.
pub async fn ingest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(env): Json<Envelope>,
) -> Result<StatusCode, ApiError> {
    let presented =
        bearer(&headers).ok_or((StatusCode::UNAUTHORIZED, "missing bearer token".into()))?;

    // Per-source: the token must be valid for THIS envelope's source, so a module
    // can't relabel its events as another source (design doc §4).
    let valid = state
        .config
        .tokens
        .get(&env.source)
        .cloned()
        .unwrap_or_default();
    if !auth::ingest_token_ok(&valid, &presented) {
        return Err((StatusCode::UNAUTHORIZED, "invalid ingest token".into()));
    }

    let mut store = state.store.lock().expect("store mutex");
    let stored = store.ingest(env);
    if stored {
        store
            .save(&state.config.store_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(StatusCode::ACCEPTED)
    } else {
        Ok(StatusCode::OK)
    }
}

#[derive(Deserialize)]
pub struct PollRequest {
    pub device_id: String,
    /// RFC3339. Echoed verbatim into the signed challenge, so no reformatting can
    /// desync the client's signature from the resolver's check.
    pub ts: String,
    /// Base64 Ed25519 signature over `"{device_id}|{ts}"`.
    pub signature: String,
}

/// `instance -> resolver`: authenticate by device signature, then hand back this
/// device's undelivered messages (fan-out delivery, marked delivered).
///
/// The challenge is `"{device_id}|{ts}"` and replay is bounded by a freshness
/// window on `ts` (`poll_skew_secs`). This is the stateless MVP; a server-issued
/// nonce (eliminating in-window replay) is a later hardening — see README.
pub async fn poll(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PollRequest>,
) -> Result<Json<Vec<MessageOut>>, ApiError> {
    // 1. Freshness — reject stale/future timestamps before touching the store.
    let ts = chrono::DateTime::parse_from_rfc3339(&req.ts)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "bad timestamp".into()))?;
    let now = Utc::now();
    let age = (now - ts.with_timezone(&Utc)).num_seconds().abs();
    if age > state.config.poll_skew_secs {
        return Err((StatusCode::UNAUTHORIZED, "stale timestamp".into()));
    }

    let mut store = state.store.lock().expect("store mutex");

    // 2. Identity — an unknown device is indistinguishable from a bad signature
    //    to the caller (both 401): knowing an account or a device_id grants
    //    nothing without the private key.
    let (account, public_key) = store
        .find_device(&req.device_id)
        .ok_or((StatusCode::UNAUTHORIZED, "unauthorized".into()))?;

    let challenge = format!("{}|{}", req.device_id, req.ts);
    auth::verify_b64(&public_key, challenge.as_bytes(), &req.signature)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "unauthorized".into()))?;

    // 3. Deliver. Persist afterwards to record delivery + last_seen durably.
    let now_str = now.to_rfc3339();
    let messages = store.take_undelivered(&account, &req.device_id, &now_str);
    store
        .save(&state.config.store_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(messages.iter().map(MessageOut::from).collect()))
}

#[derive(Deserialize)]
pub struct RegisterCodeRequest {
    /// Same per-source identity as `ingest`: the bearer token must be valid for
    /// THIS source. Enrollment reuses the corp module's ingest credential — a
    /// separate secret from the pairing code that authorises `bind`.
    pub source: String,
    /// `SHA-256(code)` in lower-hex, computed by the corp side. The raw code never
    /// reaches the resolver — only this hash — and it is stored verbatim
    /// (contract §"Enrollment endpoints"). `bind` matches it against
    /// `hash_code(proof)`, so both sides must use the same SHA-256 hex encoding.
    pub code_hash: String,
    /// Account (corp email) the code will bind a device to.
    pub account_email: String,
    /// Optional code lifetime in seconds; falls back to `enroll_code_ttl_secs`.
    #[serde(default)]
    pub ttl_seconds: Option<i64>,
}

/// Is `s` a 64-char lower-hex string (a SHA-256 digest)? `bind` hashes the proof
/// to lower-hex, so a differently-cased or wrong-length `code_hash` would silently
/// never match — reject it up front instead.
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `corp service -> resolver`: register a pairing code so a device can later
/// redeem it at `bind` (enrollment §"register-code"). Authenticated by the
/// per-source ingest token. The corp side sends only `hash(code)`; the raw code
/// never reaches the resolver and the hash is persisted as-is.
pub async fn register_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RegisterCodeRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let presented =
        bearer(&headers).ok_or((StatusCode::UNAUTHORIZED, "missing bearer token".into()))?;
    let valid = state
        .config
        .tokens
        .get(&req.source)
        .cloned()
        .unwrap_or_default();
    if !auth::ingest_token_ok(&valid, &presented) {
        return Err((StatusCode::UNAUTHORIZED, "invalid ingest token".into()));
    }

    if req.account_email.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "account_email is required".into()));
    }
    if !is_sha256_hex(&req.code_hash) {
        return Err((
            StatusCode::BAD_REQUEST,
            "code_hash must be a 64-char lower-hex SHA-256".into(),
        ));
    }

    // `ttl_seconds`: >0 → a normal one-time code expiring after that many seconds
    // (capped at a day); <=0 → an ETERNAL token (never expires, reusable — the
    // corp side opting into "one list forever, anyone can bind"); absent → the
    // configured default TTL.
    let now = Utc::now();
    let expires_at = match req.ttl_seconds {
        Some(n) if n <= 0 => None,
        Some(n) => Some((now + Duration::seconds(n.min(86_400))).to_rfc3339()),
        None => Some((now + Duration::seconds(state.config.enroll_code_ttl_secs)).to_rfc3339()),
    };

    let mut store = state.store.lock().expect("store mutex");
    store.register_code(req.code_hash, req.account_email, expires_at.clone(), &now.to_rfc3339());
    store
        .save(&state.config.store_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "expires_at": expires_at })),
    ))
}

#[derive(Deserialize)]
pub struct BindRequest {
    /// Proof of account ownership: the pairing code now, an SSO `id_token` later.
    /// The resolver resolves `proof -> account`; swapping the proof kind never
    /// touches this contract (design doc §4 "два независимых слоя").
    pub proof: String,
    /// Ed25519 public key, base64. The private key never leaves the device.
    pub public_key: String,
    pub device_id: String,
}

/// `device -> resolver`: redeem a proof to bind this device to its account
/// (enrollment §"bind"). No ingest token — the proof itself is the credential.
/// A live, matching code binds the device and is quenched (one-time). Any
/// unknown/expired/spent code is a single `401` (no oracle on code validity).
pub async fn bind(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BindRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.proof.is_empty() || req.device_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "proof and device_id are required".into()));
    }
    if !auth::valid_public_key_b64(&req.public_key) {
        return Err((StatusCode::BAD_REQUEST, "invalid public key".into()));
    }

    let now = Utc::now().to_rfc3339();
    let proof_hash = auth::hash_code(&req.proof);

    let mut store = state.store.lock().expect("store mutex");
    let account = store
        .bind_device(&proof_hash, &req.device_id, &req.public_key, &now)
        .ok_or((StatusCode::UNAUTHORIZED, "invalid or expired code".into()))?;
    store
        .save(&state.config.store_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(
        serde_json::json!({ "account": account, "enrolled_at": now }),
    ))
}

/// Extract a bearer token from the `Authorization` header.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}
