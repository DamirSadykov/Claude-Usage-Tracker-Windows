//! Instance-side enrollment (plan `External-integration-public-side`, phase 4.2).
//!
//! Flow B (aligned with the private #78 side): the CORP service generates the
//! pairing code (it is the authority on account ownership — the user is logged in
//! there), registers `hash(code) -> account` with the resolver, and shows the raw
//! code to the user once. The user types that code into THIS device, which
//! redeems it at the resolver's `/enroll/bind`, proving the device's public key
//! belongs to the account. The device never generates the code — it only submits
//! the user-entered code as the `proof`. This module owns the pure, testable
//! parts: the persisted binding state and the `bind` wire types. The actual HTTP
//! call lives in `lib.rs` (async, shares the app's `reqwest` client).
//!
//! Storage-agnostic like `todos.rs`/`identity.rs` (functions take a `&Path`), so
//! it unit-tests without the app or a running resolver.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// What the device remembers after a successful `bind`: which account it is bound
/// to, when, and the resolver it bound against. Phase 5's poll client reads this
/// to know where to poll and for which account. Absent file = not yet enrolled.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EnrollmentState {
    /// The corp account (email) this device is bound to; `None` until enrolled.
    #[serde(default)]
    pub account: Option<String>,
    /// RFC3339 timestamp the resolver reported at bind time.
    #[serde(default)]
    pub enrolled_at: Option<String>,
    /// Resolver base URL the binding was made against (for later polling).
    #[serde(default)]
    pub resolver_url: Option<String>,
}

impl EnrollmentState {
    /// Load the binding; an absent file means "not enrolled" (fresh install).
    pub fn load(path: &Path) -> Result<EnrollmentState, String> {
        if !path.exists() {
            return Ok(EnrollmentState::default());
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    /// Atomic write (temp + rename), same discipline as `todos::save`.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Is the device currently bound to an account?
    pub fn is_bound(&self) -> bool {
        self.account.is_some()
    }
}

/// `instance -> resolver` bind request body (resolver contract §"bind"). The
/// private key never appears here — only the public key and the proof (the
/// pairing code now, an SSO id_token later).
#[derive(Serialize)]
pub struct BindRequest<'a> {
    pub proof: &'a str,
    pub public_key: &'a str,
    pub device_id: &'a str,
}

/// The resolver's `200` bind response.
#[derive(Deserialize)]
pub struct BindResponse {
    pub account: String,
    pub enrolled_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("enroll-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("enrollment.json");
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn absent_file_is_unenrolled() {
        let s = EnrollmentState::load(&scratch("absent")).unwrap();
        assert!(!s.is_bound());
        assert_eq!(s.account, None);
    }

    #[test]
    fn round_trips_binding_through_disk() {
        let path = scratch("rt");
        let s = EnrollmentState {
            account: Some("user@corp".into()),
            enrolled_at: Some("2026-07-02T10:05:00Z".into()),
            resolver_url: Some("https://resolver.lan:8787".into()),
        };
        s.save(&path).unwrap();

        let back = EnrollmentState::load(&path).unwrap();
        assert!(back.is_bound());
        assert_eq!(back.account.as_deref(), Some("user@corp"));
        assert_eq!(back.resolver_url.as_deref(), Some("https://resolver.lan:8787"));
    }
}
