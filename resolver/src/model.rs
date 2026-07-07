//! Data types on the wire and at rest, mirroring
//! `docs/plans/external-integration-contract.md`. The resolver treats `payload`
//! as opaque — it routes by `recipient` and never interprets task content
//! (security invariant #2: sensitive data must not be read/logged by public code).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Neutral event envelope: `external module -> resolver` (contract §1.1).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Envelope {
    /// Idempotency/dedup key, unique within `(source, recipient)`. The private
    /// side additionally encodes the recipient into this value
    /// (`{taskId}:{discriminator}:{hash(CustomerId)}`), which is harmless here.
    pub id: String,
    pub ts: String,
    pub recipient: String,
    pub source: String,
    /// `task_created | task_status_changed | task_moved | task_comment_added`.
    /// Kept as a free string: the resolver does not enforce the enum (the
    /// contract does), so a new event form never requires a resolver change.
    #[serde(rename = "type")]
    pub kind: String,
    /// Opaque to the resolver — copied into the mailbox as-is.
    pub payload: serde_json::Value,
}

/// A device's public identity as stored by the resolver (contract §1.2). The
/// private key never leaves the device; the resolver only ever holds the public
/// key, so a leaked resolver DB can't impersonate a device.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Device {
    pub device_id: String,
    /// Ed25519 public key, base64.
    pub public_key: String,
    pub enrolled_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_seen: Option<String>,
}

/// A mailbox entry: the routed copy of an envelope plus delivery bookkeeping.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Message {
    pub id: String,
    pub recipient: String,
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: serde_json::Value,
    pub ts: String,
    /// `device_id`s that already picked this message up (fan-out: every device of
    /// the account gets one copy). Persisted, so dedup and delivery survive a
    /// restart.
    pub delivered_to: Vec<String>,
}

/// A pending enrollment: a pairing code (stored only as its hash) that a device
/// can redeem to bind itself to `account` until `expires_at` (contract
/// §"enrollment endpoints"). The raw code is never persisted, so a leaked store
/// cannot be replayed into a rogue binding — an attacker would have to reverse
/// the hash before the short TTL elapses.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PendingCode {
    /// SHA-256 of the raw pairing code, hex. The raw code is never stored.
    pub code_hash: String,
    /// Account (email) the code binds a device to, proven by whoever registered
    /// the code through the corp-authenticated `register-code` endpoint.
    pub account: String,
    /// RFC3339 expiry, or `None` for an **eternal** token. `Some(ts)` = a normal
    /// one-time code: it times out at `ts` and is quenched on the first `bind`.
    /// `None` = never expires AND is never quenched — reusable, so anyone holding
    /// the token can bind a device to `account` at any time. Eternal is an opt-in
    /// the corp side requests (contract §"Enrollment endpoints"); the resolver
    /// stays neutral and just honours the flag.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// The resolver's persistent store (contract §1.2). `pending_codes` is
/// resolver-internal enrollment state (the private side never reads this store);
/// it is `#[serde(default)]` so a pre-enrollment store JSON still loads.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Store {
    /// account (email) -> its devices.
    pub accounts: HashMap<String, Vec<Device>>,
    pub mailbox: Vec<Message>,
    #[serde(default)]
    pub pending_codes: Vec<PendingCode>,
}

/// What a polling device receives: the event, without the resolver's internal
/// `delivered_to` bookkeeping (the client doesn't need it, and it names other
/// devices).
#[derive(Debug, Clone, Serialize)]
pub struct MessageOut {
    pub id: String,
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: serde_json::Value,
    pub ts: String,
}

impl From<&Message> for MessageOut {
    fn from(m: &Message) -> Self {
        MessageOut {
            id: m.id.clone(),
            source: m.source.clone(),
            kind: m.kind.clone(),
            payload: m.payload.clone(),
            ts: m.ts.clone(),
        }
    }
}
