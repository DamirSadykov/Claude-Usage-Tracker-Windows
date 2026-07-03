//! Neutral event resolver — plan `External-integration-public-side`, phase 3.
//!
//! Accepts sanitized event envelopes from a private `external module` (ingest
//! token), stores them in a mailbox, and serves them to enrolled devices that
//! prove possession of their Ed25519 key (poll signature). It is domain-neutral:
//! it routes by `recipient` and never interprets `payload`.
//!
//! Enrollment (phase 4) populates that account->devices map at runtime: the corp
//! service registers a pairing code (`register-code`, ingest-token auth) and the
//! device redeems it (`bind`, the code itself is the credential). Seeding the
//! store JSON by hand still works for tests/dev.
//!
//! Library target so the HTTP endpoints are drivable from `tests/`; the binary
//! (`main.rs`) is a thin env-config + serve wrapper.

pub mod auth;
pub mod config;
pub mod model;
pub mod routes;
pub mod store;

use std::sync::{Arc, Mutex};

use axum::routing::{get, post};
use axum::Router;

use crate::config::Config;
use crate::model::Store;

/// Shared handler state. The store is behind a `std::sync::Mutex`: critical
/// sections are short and hold no `.await`, and the synchronous disk write is
/// acceptable for the low LAN traffic of the MVP.
pub struct AppState {
    pub config: Config,
    pub store: Mutex<Store>,
}

/// Build the router over a ready `AppState`. Kept separate from `main` so tests
/// can drive the exact endpoint stack against an in-memory state.
pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .route("/ingest", post(routes::ingest))
        .route("/poll", post(routes::poll))
        .route("/enroll/register-code", post(routes::register_code))
        .route("/enroll/bind", post(routes::bind))
        .with_state(state)
}
