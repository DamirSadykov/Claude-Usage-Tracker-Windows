//! Persistence + the two core operations: `ingest` (dedup + append) and
//! `take_undelivered` (fan-out delivery). Pure, synchronous, storage-agnostic —
//! mirrors the discipline of `src-tauri/src/{todos,identity}.rs` so it unit-tests
//! without an HTTP server or a real clock.

use std::fs;
use std::path::Path;

use crate::auth;
use crate::model::{Device, Envelope, Message, PendingCode, Store};

/// Is the code past its expiry at `now`? `None` = eternal → never expired.
/// `Some(ts)`: both RFC3339; an unparseable expiry is treated as expired (fail
/// closed — a corrupt code is never redeemable). `now` is injected (never read
/// from the wall clock here), so this stays unit-testable.
fn expired(expires_at: &Option<String>, now: &str) -> bool {
    use chrono::DateTime;
    let Some(exp) = expires_at else {
        return false; // eternal
    };
    match (
        DateTime::parse_from_rfc3339(exp),
        DateTime::parse_from_rfc3339(now),
    ) {
        (Ok(exp), Ok(now)) => now > exp,
        _ => true,
    }
}

impl Store {
    /// Load the store from disk; an absent file is an empty store (first run).
    pub fn load(path: &Path) -> Result<Store, String> {
        if !path.exists() {
            return Ok(Store::default());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    /// Atomic write (temp + rename), same discipline as `todos::save`.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Append an envelope to the mailbox, deduplicated by **`(source, recipient,
    /// id)`** (contract §"Дедупликация"). Returns `true` if newly stored, `false`
    /// if it was a duplicate (idempotent no-op).
    ///
    /// The scan covers the WHOLE mailbox, including already-delivered messages:
    /// delivered entries are never pruned in the MVP, which is exactly the
    /// retention the private side asked for (a late retry, past delivery, must
    /// still be recognised as a duplicate — trigger-dedup §2 "Обязательство
    /// resolver'а"). Retention-based pruning is a later phase's decision.
    pub fn ingest(&mut self, env: Envelope) -> bool {
        let duplicate = self
            .mailbox
            .iter()
            .any(|m| m.source == env.source && m.recipient == env.recipient && m.id == env.id);
        if duplicate {
            return false;
        }
        self.mailbox.push(Message {
            id: env.id,
            recipient: env.recipient,
            source: env.source,
            kind: env.kind,
            payload: env.payload,
            ts: env.ts,
            delivered_to: Vec::new(),
        });
        true
    }

    /// Find a device by id across all accounts. Returns `(account_email,
    /// public_key)`. There is deliberately no "give me tasks for email X" path —
    /// a poller proves possession of a device key, and the account is derived
    /// from the matched device (design doc §4).
    pub fn find_device(&self, device_id: &str) -> Option<(String, String)> {
        for (email, devices) in &self.accounts {
            for d in devices {
                if d.device_id == device_id {
                    return Some((email.clone(), d.public_key.clone()));
                }
            }
        }
        None
    }

    /// Collect the messages for `account` that `device_id` has not yet received,
    /// mark them delivered to this device, and bump the device's `last_seen`.
    /// Fan-out: each device of the account picks up its own copy independently.
    pub fn take_undelivered(&mut self, account: &str, device_id: &str, now: &str) -> Vec<Message> {
        let mut out = Vec::new();
        for m in self.mailbox.iter_mut() {
            if m.recipient == account && !m.delivered_to.iter().any(|d| d == device_id) {
                m.delivered_to.push(device_id.to_string());
                out.push(m.clone());
            }
        }
        for devices in self.accounts.values_mut() {
            for d in devices.iter_mut() {
                if d.device_id == device_id {
                    d.last_seen = Some(now.to_string());
                }
            }
        }
        out
    }

    /// Register a pairing code (given as its hash) for `account`, valid until
    /// `expires_at` — or `None` for an eternal token (enrollment §"register-code").
    /// Expired codes are pruned in passing, and re-registering the same hash
    /// replaces the prior entry (idempotent). The raw code is never seen here —
    /// only its hash is stored.
    pub fn register_code(
        &mut self,
        code_hash: String,
        account: String,
        expires_at: Option<String>,
        now: &str,
    ) {
        self.pending_codes
            .retain(|c| c.code_hash != code_hash && !expired(&c.expires_at, now));
        self.pending_codes.push(PendingCode {
            code_hash,
            account,
            expires_at,
        });
    }

    /// Redeem a proof (given as `proof_hash`) to bind a device to its account
    /// (enrollment §"bind"). On a live, matching code: the device is added to
    /// `accounts[account]` (re-binding the same `device_id` updates its key rather
    /// than duplicating) and the account is returned. A normal (expiring) code is
    /// **quenched** (removed — one-time use); an **eternal** code (`expires_at ==
    /// None`) is left in place so it can bind more devices later (reusable — the
    /// corp side opted into this). Returns `None` if no live code matches — an
    /// unknown, expired, or already-redeemed code is indistinguishable to the
    /// caller (all map to a single 401 upstream).
    pub fn bind_device(
        &mut self,
        proof_hash: &str,
        device_id: &str,
        public_key: &str,
        now: &str,
    ) -> Option<String> {
        let idx = self.pending_codes.iter().position(|c| {
            auth::code_hash_eq(&c.code_hash, proof_hash) && !expired(&c.expires_at, now)
        })?;
        // Quench a one-time code; keep an eternal (reusable) one.
        let account = if self.pending_codes[idx].expires_at.is_some() {
            self.pending_codes.remove(idx).account
        } else {
            self.pending_codes[idx].account.clone()
        };

        let devices = self.accounts.entry(account.clone()).or_default();
        if let Some(existing) = devices.iter_mut().find(|d| d.device_id == device_id) {
            existing.public_key = public_key.to_string();
            existing.enrolled_at = now.to_string();
            existing.last_seen = None;
        } else {
            devices.push(Device {
                device_id: device_id.to_string(),
                public_key: public_key.to_string(),
                enrolled_at: now.to_string(),
                last_seen: None,
            });
        }
        Some(account)
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{Device, Envelope, Store};

    fn env(id: &str, recipient: &str, source: &str) -> Envelope {
        Envelope {
            id: id.into(),
            ts: "2026-07-02T10:00:00Z".into(),
            recipient: recipient.into(),
            source: source.into(),
            kind: "task_created".into(),
            payload: serde_json::json!({ "title": "t", "status": "open" }),
        }
    }

    #[test]
    fn dedup_is_by_source_recipient_id() {
        let mut s = Store::default();

        // First insert stores.
        assert!(s.ingest(env("1", "a@x", "svc-a")));
        // Exact (source, recipient, id) repeat = duplicate (retry idempotency).
        assert!(!s.ingest(env("1", "a@x", "svc-a")));
        // Same id, DIFFERENT recipient = a legitimate fan-out envelope, NOT a dup.
        assert!(s.ingest(env("1", "b@x", "svc-a")));
        // Same id + recipient, different source = different origin, not a dup.
        assert!(s.ingest(env("1", "a@x", "svc-b")));

        assert_eq!(s.mailbox.len(), 3);
    }

    #[test]
    fn delivery_fans_out_and_is_once_per_device() {
        let mut s = Store::default();
        s.accounts.insert(
            "a@x".into(),
            vec![
                Device {
                    device_id: "dev1".into(),
                    public_key: "pk".into(),
                    enrolled_at: "t".into(),
                    last_seen: None,
                },
                Device {
                    device_id: "dev2".into(),
                    public_key: "pk".into(),
                    enrolled_at: "t".into(),
                    last_seen: None,
                },
            ],
        );
        s.ingest(env("1", "a@x", "svc-a"));

        // dev1's first poll gets the message; its second poll gets nothing.
        assert_eq!(s.take_undelivered("a@x", "dev1", "now").len(), 1);
        assert_eq!(s.take_undelivered("a@x", "dev1", "now").len(), 0);
        // dev2 still gets its own copy (fan-out is per device).
        assert_eq!(s.take_undelivered("a@x", "dev2", "now").len(), 1);

        // last_seen was recorded on delivery.
        let dev1 = s.accounts["a@x"].iter().find(|d| d.device_id == "dev1").unwrap();
        assert_eq!(dev1.last_seen.as_deref(), Some("now"));
    }

    #[test]
    fn poll_does_not_leak_other_accounts() {
        let mut s = Store::default();
        s.accounts.insert(
            "a@x".into(),
            vec![Device {
                device_id: "dev1".into(),
                public_key: "pk".into(),
                enrolled_at: "t".into(),
                last_seen: None,
            }],
        );
        s.ingest(env("1", "a@x", "svc-a"));
        s.ingest(env("2", "b@x", "svc-a")); // another account's message

        let got = s.take_undelivered("a@x", "dev1", "now");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].recipient, "a@x");
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("resolver-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        let _ = std::fs::remove_file(&path);

        let mut s = Store::default();
        s.ingest(env("1", "a@x", "svc-a"));
        s.save(&path).unwrap();

        let reloaded = Store::load(&path).unwrap();
        assert_eq!(reloaded.mailbox.len(), 1);
        assert_eq!(reloaded.mailbox[0].id, "1");
    }

    use crate::auth::hash_code;

    #[test]
    fn bind_redeems_a_live_code_and_quenches_it() {
        let mut s = Store::default();
        s.register_code(
            hash_code("secret-code"),
            "a@x".into(),
            Some("2026-07-02T10:10:00Z".into()),
            "2026-07-02T10:00:00Z",
        );

        // Redeem: device lands under the account, code is one-time.
        let acct = s.bind_device(
            &hash_code("secret-code"),
            "dev1",
            "pk-b64",
            "2026-07-02T10:05:00Z",
        );
        assert_eq!(acct.as_deref(), Some("a@x"));
        assert_eq!(s.accounts["a@x"].len(), 1);
        assert_eq!(s.accounts["a@x"][0].device_id, "dev1");
        assert_eq!(s.accounts["a@x"][0].enrolled_at, "2026-07-02T10:05:00Z");
        assert!(s.pending_codes.is_empty(), "code must be quenched");

        // Second redeem of the now-quenched code fails.
        assert!(s
            .bind_device(&hash_code("secret-code"), "dev2", "pk2", "2026-07-02T10:06:00Z")
            .is_none());
    }

    #[test]
    fn bind_rejects_wrong_and_expired_codes() {
        let mut s = Store::default();
        s.register_code(
            hash_code("good"),
            "a@x".into(),
            Some("2026-07-02T10:10:00Z".into()),
            "2026-07-02T10:00:00Z",
        );

        // Wrong code never matches.
        assert!(s
            .bind_device(&hash_code("wrong"), "dev1", "pk", "2026-07-02T10:05:00Z")
            .is_none());
        // Right code, but past its expiry => dead.
        assert!(s
            .bind_device(&hash_code("good"), "dev1", "pk", "2026-07-02T10:20:00Z")
            .is_none());
        // A dead-on-expiry redeem must not have consumed the account map.
        assert!(s.accounts.get("a@x").is_none());
    }

    #[test]
    fn rebinding_same_device_updates_key_not_duplicates() {
        let mut s = Store::default();
        s.register_code(
            hash_code("c1"),
            "a@x".into(),
            Some("2026-07-02T10:10:00Z".into()),
            "2026-07-02T10:00:00Z",
        );
        s.bind_device(&hash_code("c1"), "dev1", "pk-old", "2026-07-02T10:01:00Z");

        // A fresh code for the SAME device_id rotates its key in place.
        s.register_code(
            hash_code("c2"),
            "a@x".into(),
            Some("2026-07-02T10:10:00Z".into()),
            "2026-07-02T10:02:00Z",
        );
        s.bind_device(&hash_code("c2"), "dev1", "pk-new", "2026-07-02T10:03:00Z");

        assert_eq!(s.accounts["a@x"].len(), 1);
        assert_eq!(s.accounts["a@x"][0].public_key, "pk-new");
    }

    #[test]
    fn register_prunes_expired_and_replaces_same_hash() {
        let mut s = Store::default();
        // An already-expired code from an earlier attempt.
        s.register_code(
            hash_code("old"),
            "a@x".into(),
            Some("2026-07-02T09:00:00Z".into()),
            "2026-07-02T08:00:00Z",
        );
        // A new registration at 10:00 prunes the 09:00-expired one.
        s.register_code(
            hash_code("fresh"),
            "a@x".into(),
            Some("2026-07-02T10:10:00Z".into()),
            "2026-07-02T10:00:00Z",
        );
        assert_eq!(s.pending_codes.len(), 1);
        assert_eq!(s.pending_codes[0].code_hash, hash_code("fresh"));

        // Re-registering the same hash replaces rather than accumulating.
        s.register_code(
            hash_code("fresh"),
            "a@x".into(),
            Some("2026-07-02T10:20:00Z".into()),
            "2026-07-02T10:01:00Z",
        );
        assert_eq!(s.pending_codes.len(), 1);
        assert_eq!(
            s.pending_codes[0].expires_at.as_deref(),
            Some("2026-07-02T10:20:00Z")
        );
    }

    #[test]
    fn eternal_code_never_expires_and_is_reusable() {
        let mut s = Store::default();
        // expires_at = None => eternal token.
        s.register_code(hash_code("forever"), "a@x".into(), None, "2026-07-02T10:00:00Z");

        // Binds far in the future (never times out) and is NOT quenched.
        let acct = s.bind_device(&hash_code("forever"), "dev1", "pk1", "2030-01-01T00:00:00Z");
        assert_eq!(acct.as_deref(), Some("a@x"));
        assert_eq!(s.pending_codes.len(), 1, "eternal code must not be quenched");

        // The SAME token binds a second device later — reusable => multi-device.
        let acct2 = s.bind_device(&hash_code("forever"), "dev2", "pk2", "2031-06-01T00:00:00Z");
        assert_eq!(acct2.as_deref(), Some("a@x"));
        assert_eq!(s.accounts["a@x"].len(), 2);
        assert_eq!(s.pending_codes.len(), 1);
    }
}
