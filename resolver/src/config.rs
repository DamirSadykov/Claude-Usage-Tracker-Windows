//! Runtime configuration, entirely from the environment (secrets never on the
//! command line or in the store). See `resolver/README.md` for the variables.

use std::collections::HashMap;
use std::path::PathBuf;

pub struct Config {
    /// Listen address, e.g. `0.0.0.0:8787`.
    pub bind: String,
    /// Path to the persistent store JSON.
    pub store_path: PathBuf,
    /// `source -> valid ingest tokens`. More than one token per source is a
    /// rotation set (§4 design doc). An absent source has no valid tokens.
    pub tokens: HashMap<String, Vec<String>>,
    /// How far the poll timestamp may be from `now`, in seconds — the replay
    /// window for the (stateless, MVP) poll challenge.
    pub poll_skew_secs: i64,
    /// Default lifetime of a pairing code when `register-code` does not specify
    /// one, in seconds. Codes are short-lived and single-use (enrollment §bind).
    pub enroll_code_ttl_secs: i64,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let bind = std::env::var("RESOLVER_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
        let store_path = std::env::var("RESOLVER_STORE")
            .unwrap_or_else(|_| "resolver-store.json".to_string())
            .into();
        let tokens = parse_tokens(&std::env::var("RESOLVER_INGEST_TOKENS").unwrap_or_default());
        let poll_skew_secs = std::env::var("RESOLVER_POLL_SKEW_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);
        let enroll_code_ttl_secs = std::env::var("RESOLVER_ENROLL_CODE_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(600);
        Ok(Config {
            bind,
            store_path,
            tokens,
            poll_skew_secs,
            enroll_code_ttl_secs,
        })
    }
}

/// Parse `source:token,source:token2,...`. A source repeated across entries
/// accumulates a rotation set. Blank/malformed entries are skipped.
pub fn parse_tokens(raw: &str) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for pair in raw.split(',') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        if let Some((source, token)) = pair.split_once(':') {
            let source = source.trim();
            let token = token.trim();
            if !source.is_empty() && !token.is_empty() {
                map.entry(source.to_string())
                    .or_default()
                    .push(token.to_string());
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_tokens_by_source_and_skips_junk() {
        let m = parse_tokens("svc-a:tok1, svc-a:tok2 , svc-b:tok3, , bad-entry, :nope, empty:");
        assert_eq!(m.get("svc-a").unwrap().len(), 2); // rotation set
        assert_eq!(m.get("svc-b").unwrap(), &vec!["tok3".to_string()]);
        assert!(m.get("bad-entry").is_none());
        assert!(m.get("").is_none());
        assert!(m.get("empty").is_none());
    }
}
