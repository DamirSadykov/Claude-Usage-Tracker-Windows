//! The resolver's two authentication boundaries (design doc §4):
//!   external module -> resolver : ingest token (shared secret, per-source)
//!   instance -> resolver        : Ed25519 device signature

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Is `presented` a valid ingest token for a source, given that source's set of
/// currently-valid tokens? The set is per-source (a module can't impersonate
/// another source: its token only appears under its own source's set) and may
/// hold several tokens at once for rotation without downtime.
///
/// Compared constant-time against every candidate, without short-circuiting, so a
/// timing side channel can't reveal how far a guess matched.
pub fn ingest_token_ok(valid: &[String], presented: &str) -> bool {
    let mut ok = false;
    for token in valid {
        ok |= bool::from(token.as_bytes().ct_eq(presented.as_bytes()));
    }
    ok
}

/// Verify a base64 Ed25519 signature over `challenge` with a base64 public key —
/// the check run on every poll.
///
/// CANONICAL COPY: `src-tauri/src/identity.rs::verify_b64`. The resolver and the
/// desktop app are separate deployables that share no crate, so this is
/// duplicated deliberately; keep the two in sync. The wire format (32-byte key,
/// 64-byte signature, base64) is frozen by the contract, so drift is unlikely.
pub fn verify_b64(
    public_key_b64: &str,
    challenge: &[u8],
    signature_b64: &str,
) -> Result<(), String> {
    let pk = B64.decode(public_key_b64).map_err(|e| e.to_string())?;
    let pk: [u8; 32] = pk
        .as_slice()
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|e| e.to_string())?;

    let sig = B64.decode(signature_b64).map_err(|e| e.to_string())?;
    let sig: [u8; 64] = sig
        .as_slice()
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;
    let sig = Signature::from_bytes(&sig);

    vk.verify(challenge, &sig).map_err(|e| e.to_string())
}

/// SHA-256 of a pairing code, lower-hex. The resolver stores and matches on this,
/// never on the raw code (enrollment §"register-code"/"bind"). The code's entropy
/// is the generator's responsibility — the resolver only hashes what it is given,
/// so the private/instance side MUST use a high-entropy code (a short numeric code
/// would be brute-forceable from a leaked hash within its TTL).
pub fn hash_code(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Constant-time equality of two code hashes. The stored `code_hash` is matched
/// against `hash_code(proof)` without short-circuiting, same discipline as
/// `ingest_token_ok` — a timing side channel must not reveal how far a hash matched.
pub fn code_hash_eq(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// Is `pk_b64` a well-formed Ed25519 public key (base64 of a valid 32-byte point)?
/// Checked at `bind` time so we never persist a key that would fail every poll.
pub fn valid_public_key_b64(pk_b64: &str) -> bool {
    let Ok(bytes) = B64.decode(pk_b64) else {
        return false;
    };
    let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) else {
        return false;
    };
    VerifyingKey::from_bytes(&arr).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn ingest_token_matches_within_source_set() {
        let valid = vec!["tok-a".to_string(), "tok-a-next".to_string()];
        assert!(ingest_token_ok(&valid, "tok-a"));
        assert!(ingest_token_ok(&valid, "tok-a-next")); // rotation
        assert!(!ingest_token_ok(&valid, "tok-b"));
        assert!(!ingest_token_ok(&valid, ""));
        // Unknown source => empty candidate set => never valid.
        assert!(!ingest_token_ok(&[], "anything"));
    }

    #[test]
    fn signature_verifies_and_rejects_tampering() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_b64 = B64.encode(sk.verifying_key().to_bytes());

        let challenge = b"dev1|2026-07-02T10:00:00Z";
        let sig_b64 = B64.encode(sk.sign(challenge).to_bytes());

        assert!(verify_b64(&pk_b64, challenge, &sig_b64).is_ok());
        // Any change to the signed bytes must fail (replay of another challenge).
        assert!(verify_b64(&pk_b64, b"dev1|2026-07-02T11:00:00Z", &sig_b64).is_err());
        // Wrong key must fail.
        let other = B64.encode(SigningKey::from_bytes(&[9u8; 32]).verifying_key().to_bytes());
        assert!(verify_b64(&other, challenge, &sig_b64).is_err());
    }

    #[test]
    fn hash_code_is_stable_hex_and_differs_per_code() {
        let h = hash_code("pair-code-123");
        // 32-byte SHA-256 => 64 hex chars, and deterministic.
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(h, hash_code("pair-code-123"));
        // Different code => different hash; equality check is constant-time.
        assert_ne!(h, hash_code("pair-code-124"));
        assert!(code_hash_eq(&h, &hash_code("pair-code-123")));
        assert!(!code_hash_eq(&h, &hash_code("pair-code-124")));
    }

    #[test]
    fn public_key_validation_accepts_real_keys_and_rejects_junk() {
        let pk = B64.encode(SigningKey::from_bytes(&[3u8; 32]).verifying_key().to_bytes());
        assert!(valid_public_key_b64(&pk));
        assert!(!valid_public_key_b64("not-base64!!"));
        assert!(!valid_public_key_b64(&B64.encode([1u8; 16]))); // wrong length
        assert!(!valid_public_key_b64(""));
    }
}
