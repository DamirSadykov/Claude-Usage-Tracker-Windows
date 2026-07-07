//! Endpoint-level tests: drive the real axum handler stack (auth wiring, status
//! codes, JSON, bearer parsing, freshness) that the in-module unit tests don't
//! reach. Covers phase-3 subphases 3.2 (ingest endpoint) and 3.3/3.4 (poll +
//! fan-out delivery).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use tower::ServiceExt; // for `oneshot`

use resolver::auth::hash_code;
use resolver::config::Config;
use resolver::model::{Device, Store};
use resolver::{app, AppState};

fn temp_store_path(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("resolver-it-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("store.json");
    let _ = std::fs::remove_file(&p);
    p
}

fn state(tokens: HashMap<String, Vec<String>>, store: Store, tag: &str) -> Arc<AppState> {
    Arc::new(AppState {
        config: Config {
            bind: "127.0.0.1:0".into(),
            store_path: temp_store_path(tag),
            tokens,
            poll_skew_secs: 300,
            enroll_code_ttl_secs: 600,
        },
        store: Mutex::new(store),
    })
}

fn tokens(pairs: &[(&str, &str)]) -> HashMap<String, Vec<String>> {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for (s, t) in pairs {
        m.entry(s.to_string()).or_default().push(t.to_string());
    }
    m
}

fn envelope(id: &str, recipient: &str, source: &str) -> String {
    serde_json::json!({
        "id": id,
        "ts": "2026-07-02T10:00:00Z",
        "recipient": recipient,
        "source": source,
        "type": "task_created",
        "payload": { "title": "t", "status": "open", "url": "https://x/1", "updated_at": "2026-07-02T10:00:00Z" }
    })
    .to_string()
}

fn post(uri: &str, bearer: Option<&str>, body: String) -> Request<Body> {
    let mut b = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(tok) = bearer {
        b = b.header(header::AUTHORIZATION, format!("Bearer {tok}"));
    }
    b.body(Body::from(body)).unwrap()
}

async fn status_of(st: Arc<AppState>, req: Request<Body>) -> StatusCode {
    app(st).oneshot(req).await.unwrap().status()
}

async fn body_json(st: Arc<AppState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let resp = app(st).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

#[tokio::test]
async fn health_ok() {
    let st = state(tokens(&[]), Store::default(), "health");
    let req = Request::builder().uri("/health").body(Body::empty()).unwrap();
    let (status, _) = body_json(st, req).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn ingest_rejects_bad_and_missing_token() {
    let st = state(tokens(&[("svc-a", "good")]), Store::default(), "ingest-auth");

    // Missing bearer.
    assert_eq!(
        status_of(st.clone(), post("/ingest", None, envelope("1", "a@x", "svc-a"))).await,
        StatusCode::UNAUTHORIZED
    );
    // Wrong token.
    assert_eq!(
        status_of(st.clone(), post("/ingest", Some("bad"), envelope("1", "a@x", "svc-a"))).await,
        StatusCode::UNAUTHORIZED
    );
    // Right token, but wrong source for it (per-source binding): token "good" is
    // only valid for svc-a, so an envelope claiming svc-b must be rejected.
    assert_eq!(
        status_of(st.clone(), post("/ingest", Some("good"), envelope("1", "a@x", "svc-b"))).await,
        StatusCode::UNAUTHORIZED
    );

    // Nothing was stored on any rejection.
    assert_eq!(st.store.lock().unwrap().mailbox.len(), 0);
}

#[tokio::test]
async fn ingest_accepts_and_dedups() {
    let st = state(tokens(&[("svc-a", "good")]), Store::default(), "ingest-ok");

    // New envelope => 202.
    assert_eq!(
        status_of(st.clone(), post("/ingest", Some("good"), envelope("1", "a@x", "svc-a"))).await,
        StatusCode::ACCEPTED
    );
    // Exact repeat => 200 (idempotent, no second copy).
    assert_eq!(
        status_of(st.clone(), post("/ingest", Some("good"), envelope("1", "a@x", "svc-a"))).await,
        StatusCode::OK
    );
    assert_eq!(st.store.lock().unwrap().mailbox.len(), 1);
}

#[tokio::test]
async fn poll_full_flow() {
    // Seed one account with a device whose key we control.
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let pk_b64 = B64.encode(sk.verifying_key().to_bytes());
    let mut store = Store::default();
    store.accounts.insert(
        "a@x".into(),
        vec![Device {
            device_id: "dev1".into(),
            public_key: pk_b64,
            enrolled_at: "2026-07-02T00:00:00Z".into(),
            last_seen: None,
        }],
    );

    let st = state(tokens(&[("svc-a", "good")]), store, "poll");

    // Ingest a message for that account.
    assert_eq!(
        status_of(st.clone(), post("/ingest", Some("good"), envelope("1", "a@x", "svc-a"))).await,
        StatusCode::ACCEPTED
    );

    // Correctly signed poll => 200 with the one message.
    let ts = Utc::now().to_rfc3339();
    let sig = B64.encode(sk.sign(format!("dev1|{ts}").as_bytes()).to_bytes());
    let poll_body = |ts: &str, sig: &str| {
        serde_json::json!({ "device_id": "dev1", "ts": ts, "signature": sig }).to_string()
    };

    let (status, json) = body_json(st.clone(), post("/poll", None, poll_body(&ts, &sig))).await;
    assert_eq!(status, StatusCode::OK);
    let arr = json.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], "1");
    // The internal `delivered_to` bookkeeping must NOT leak to the client.
    assert!(arr[0].get("delivered_to").is_none());

    // Second poll (fresh ts + sig) => empty (already delivered to this device).
    let ts2 = Utc::now().to_rfc3339();
    let sig2 = B64.encode(sk.sign(format!("dev1|{ts2}").as_bytes()).to_bytes());
    let (status, json) = body_json(st.clone(), post("/poll", None, poll_body(&ts2, &sig2))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json.as_array().unwrap().len(), 0);

    // Bad signature => 401.
    assert_eq!(
        status_of(st.clone(), post("/poll", None, poll_body(&ts, "AAAA"))).await,
        StatusCode::UNAUTHORIZED
    );

    // Stale timestamp (older than the 300s window) => 401 even if well-signed.
    let old = (Utc::now() - chrono::Duration::seconds(600)).to_rfc3339();
    let old_sig = B64.encode(sk.sign(format!("dev1|{old}").as_bytes()).to_bytes());
    assert_eq!(
        status_of(st.clone(), post("/poll", None, poll_body(&old, &old_sig))).await,
        StatusCode::UNAUTHORIZED
    );

    // Unknown device => 401.
    let ts3 = Utc::now().to_rfc3339();
    let sig3 = B64.encode(sk.sign(format!("ghost|{ts3}").as_bytes()).to_bytes());
    let ghost = serde_json::json!({ "device_id": "ghost", "ts": ts3, "signature": sig3 }).to_string();
    assert_eq!(
        status_of(st.clone(), post("/poll", None, ghost)).await,
        StatusCode::UNAUTHORIZED
    );
}

fn register_body(source: &str, account_email: &str, code_hash: &str) -> String {
    serde_json::json!({
        "source": source,
        "code_hash": code_hash,
        "account_email": account_email,
        "ttl_seconds": 600
    })
    .to_string()
}

fn bind_body(proof: &str, public_key: &str, device_id: &str) -> String {
    serde_json::json!({ "proof": proof, "public_key": public_key, "device_id": device_id })
        .to_string()
}

#[tokio::test]
async fn register_code_requires_matching_source_token() {
    let st = state(tokens(&[("svc-a", "good")]), Store::default(), "reg-auth");

    let h = hash_code("c");
    // Missing token, wrong token, and right token but wrong source all 401.
    assert_eq!(
        status_of(st.clone(), post("/enroll/register-code", None, register_body("svc-a", "a@x", &h))).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status_of(st.clone(), post("/enroll/register-code", Some("bad"), register_body("svc-a", "a@x", &h))).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status_of(st.clone(), post("/enroll/register-code", Some("good"), register_body("svc-b", "a@x", &h))).await,
        StatusCode::UNAUTHORIZED
    );
    // No code was registered on any rejection.
    assert!(st.store.lock().unwrap().pending_codes.is_empty());
}

#[tokio::test]
async fn enrollment_end_to_end_then_poll_works() {
    let st = state(tokens(&[("svc-a", "good")]), Store::default(), "enroll-e2e");

    // 1. Corp hashes the code and registers hash(code) => 201. The raw code never
    //    reaches the resolver; the stored value is exactly the hash it was sent.
    let (status, json) = body_json(
        st.clone(),
        post("/enroll/register-code", Some("good"), register_body("svc-a", "a@x", &hash_code("pair-42"))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(json.get("expires_at").is_some());
    {
        let store = st.store.lock().unwrap();
        assert_eq!(store.pending_codes.len(), 1);
        assert_eq!(store.pending_codes[0].code_hash, hash_code("pair-42"));
        assert_ne!(store.pending_codes[0].code_hash, "pair-42"); // the hash, not the raw code
    }

    // 2. Device redeems the RAW code with its own public key => 200, bound to a@x.
    //    The resolver hashes the proof and it matches the stored hash.
    let sk = SigningKey::from_bytes(&[11u8; 32]);
    let pk_b64 = B64.encode(sk.verifying_key().to_bytes());
    let (status, json) = body_json(
        st.clone(),
        post("/enroll/bind", None, bind_body("pair-42", &pk_b64, "dev1")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["account"], "a@x");
    {
        let store = st.store.lock().unwrap();
        assert_eq!(store.accounts["a@x"].len(), 1);
        assert!(store.pending_codes.is_empty(), "code must be quenched");
    }

    // 3. The freshly-bound device can now poll and receive its account's messages.
    assert_eq!(
        status_of(st.clone(), post("/ingest", Some("good"), envelope("1", "a@x", "svc-a"))).await,
        StatusCode::ACCEPTED
    );
    let ts = Utc::now().to_rfc3339();
    let sig = B64.encode(sk.sign(format!("dev1|{ts}").as_bytes()).to_bytes());
    let poll = serde_json::json!({ "device_id": "dev1", "ts": ts, "signature": sig }).to_string();
    let (status, json) = body_json(st.clone(), post("/poll", None, poll)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn bind_rejects_bad_code_and_bad_key() {
    let st = state(tokens(&[("svc-a", "good")]), Store::default(), "bind-reject");
    let sk = SigningKey::from_bytes(&[12u8; 32]);
    let pk_b64 = B64.encode(sk.verifying_key().to_bytes());

    // Unknown code => 401 (nothing registered).
    assert_eq!(
        status_of(st.clone(), post("/enroll/bind", None, bind_body("nope", &pk_b64, "dev1"))).await,
        StatusCode::UNAUTHORIZED
    );

    // Register a code, then a well-formed but wrong public key => 400.
    let _ = status_of(
        st.clone(),
        post("/enroll/register-code", Some("good"), register_body("svc-a", "a@x", &hash_code("pair-9"))),
    )
    .await;
    assert_eq!(
        status_of(st.clone(), post("/enroll/bind", None, bind_body("pair-9", "not-a-key", "dev1"))).await,
        StatusCode::BAD_REQUEST
    );
    // The rejected bind must not have consumed the code.
    assert_eq!(st.store.lock().unwrap().pending_codes.len(), 1);

    // A code is one-time: first valid bind succeeds, an immediate replay 401s.
    assert_eq!(
        status_of(st.clone(), post("/enroll/bind", None, bind_body("pair-9", &pk_b64, "dev1"))).await,
        StatusCode::OK
    );
    assert_eq!(
        status_of(st.clone(), post("/enroll/bind", None, bind_body("pair-9", &pk_b64, "dev2"))).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn eternal_token_is_reusable_across_devices() {
    let st = state(tokens(&[("svc-a", "good")]), Store::default(), "eternal");

    // Register an ETERNAL token (ttl_seconds = 0): never expires, reusable.
    let body = serde_json::json!({
        "source": "svc-a",
        "code_hash": hash_code("forever"),
        "account_email": "a@x",
        "ttl_seconds": 0
    })
    .to_string();
    let (status, json) =
        body_json(st.clone(), post("/enroll/register-code", Some("good"), body)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(json["expires_at"].is_null(), "eternal token has no expiry");

    // Two different devices bind with the SAME raw token, and it is NOT quenched.
    let pk1 = B64.encode(SigningKey::from_bytes(&[21u8; 32]).verifying_key().to_bytes());
    let pk2 = B64.encode(SigningKey::from_bytes(&[22u8; 32]).verifying_key().to_bytes());
    assert_eq!(
        status_of(st.clone(), post("/enroll/bind", None, bind_body("forever", &pk1, "dev1"))).await,
        StatusCode::OK
    );
    assert_eq!(
        status_of(st.clone(), post("/enroll/bind", None, bind_body("forever", &pk2, "dev2"))).await,
        StatusCode::OK
    );

    let store = st.store.lock().unwrap();
    assert_eq!(store.accounts["a@x"].len(), 2, "both devices bound under the account");
    assert_eq!(store.pending_codes.len(), 1, "eternal token survives binds");
}
