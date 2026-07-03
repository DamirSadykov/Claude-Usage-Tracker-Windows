//! Device identity for the external-integration resolver client (plan
//! `External-integration-public-side`, phase 2).
//!
//! Each install owns an Ed25519 keypair generated on first run. The PRIVATE key
//! never leaves the device; the resolver stores only the PUBLIC key (enrollment).
//! Poll requests are authenticated by signing a server nonce/timestamp with the
//! private key, so a leaked resolver DB can't impersonate any device.
//!
//! At-rest protection of the private key is delegated to a [`SecretStore`] (phase
//! 2.2): this module is storage-agnostic and pure, mirroring `todos.rs`
//! (functions take a `&Path`), so it unit-tests without touching the OS keystore.
//! Only ed25519 math + the OS RNG are used here — no crypto-protect syscalls —
//! keeping the binary's behavioural-AV surface unchanged (see Cargo.toml note).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Seals/unseals the private-key blob at rest. The concrete secure impl (DPAPI or
/// file+ACL) is wired in phase 2.2; keeping it behind a trait lets the identity
/// logic be tested with an in-memory stub and lets the at-rest mechanism be
/// swapped without touching callers.
pub trait SecretStore {
    fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, String>;
    fn unseal(&self, ciphertext: &[u8]) -> Result<Vec<u8>, String>;
}

/// At-rest sealing via Windows DPAPI (`CryptProtectData`): the key blob is
/// encrypted under the current Windows user, so the seed is never plaintext on
/// disk. This is the one crypto-protect syscall in the module — a benign,
/// ubiquitous API (e.g. Chrome), and autostart (the prior behavioural-AV trigger)
/// is off.
#[cfg(windows)]
pub struct DpapiStore;

#[cfg(windows)]
impl SecretStore for DpapiStore {
    fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        dpapi(plaintext, true)
    }
    fn unseal(&self, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        dpapi(ciphertext, false)
    }
}

/// One DPAPI call. `protect=true` → CryptProtectData, else CryptUnprotectData. The
/// API allocates the output with LocalAlloc; we copy it out and LocalFree it.
#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: core::ptr::null_mut(),
    };

    let ok = unsafe {
        if protect {
            CryptProtectData(
                &in_blob as *const _,
                core::ptr::null(),
                core::ptr::null(),
                core::ptr::null(),
                core::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob as *mut _,
            )
        } else {
            CryptUnprotectData(
                &in_blob as *const _,
                core::ptr::null_mut(),
                core::ptr::null(),
                core::ptr::null(),
                core::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob as *mut _,
            )
        }
    };

    if ok == 0 {
        return Err(format!(
            "DPAPI {} failed: {}",
            if protect { "protect" } else { "unprotect" },
            std::io::Error::last_os_error()
        ));
    }

    let out =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData as _);
    }
    Ok(out)
}

#[derive(Serialize, Deserialize)]
struct KeyFile {
    device_id: String,
    /// Ed25519 secret seed (32 bytes), base64.
    secret_b64: String,
}

/// A loaded device identity. Holds the signing key in memory for the process
/// lifetime; the on-disk copy stays sealed.
pub struct DeviceIdentity {
    device_id: String,
    signing_key: SigningKey,
}

impl DeviceIdentity {
    /// Stable per-install id (random 16 bytes, hex). Distinguishes two devices of
    /// the same account in the resolver's `account → [devices]` map.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Base64 Ed25519 public key — what the resolver stores at enrollment.
    pub fn public_key_b64(&self) -> String {
        B64.encode(self.signing_key.verifying_key().to_bytes())
    }

    /// Sign an arbitrary challenge (server nonce + timestamp). Returns base64.
    pub fn sign_b64(&self, challenge: &[u8]) -> String {
        B64.encode(self.signing_key.sign(challenge).to_bytes())
    }
}

/// Verify a base64 signature against a base64 public key — the check the resolver
/// runs on each poll. Shared here so both sides use one implementation covered by
/// the same tests.
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

/// Load the device identity, generating + persisting a fresh keypair on first run.
/// `path` is the sealed key file (a sibling of `todos.json` in the app data dir).
pub fn load_or_create(path: &Path, store: &dyn SecretStore) -> Result<DeviceIdentity, String> {
    if path.exists() {
        let sealed = std::fs::read(path).map_err(|e| e.to_string())?;
        let plain = store.unseal(&sealed)?;
        let kf: KeyFile = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
        return identity_from_keyfile(&kf);
    }

    // First run: generate seed + device id from the OS RNG.
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|e| e.to_string())?;
    let mut dev = [0u8; 16];
    getrandom::getrandom(&mut dev).map_err(|e| e.to_string())?;

    let kf = KeyFile {
        device_id: hex(&dev),
        secret_b64: B64.encode(seed),
    };
    let plain = serde_json::to_vec(&kf).map_err(|e| e.to_string())?;
    let sealed = store.seal(&plain)?;
    save_atomic(path, &sealed)?;

    identity_from_keyfile(&kf)
}

fn identity_from_keyfile(kf: &KeyFile) -> Result<DeviceIdentity, String> {
    let seed = B64.decode(&kf.secret_b64).map_err(|e| e.to_string())?;
    let seed: [u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| "secret must be 32 bytes".to_string())?;
    Ok(DeviceIdentity {
        device_id: kf.device_id.clone(),
        signing_key: SigningKey::from_bytes(&seed),
    })
}

/// Atomic write (temp + rename), same discipline as `todos::save`.
fn save_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{:02x}", b);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory stub: seals to plaintext. NOT for production — the real at-rest
    /// store (DPAPI / file+ACL) is phase 2.2.
    struct NoopStore;
    impl SecretStore for NoopStore {
        fn seal(&self, p: &[u8]) -> Result<Vec<u8>, String> {
            Ok(p.to_vec())
        }
        fn unseal(&self, c: &[u8]) -> Result<Vec<u8>, String> {
            Ok(c.to_vec())
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("id-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("device_key.bin");
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let id = load_or_create(&scratch("sv"), &NoopStore).unwrap();
        let challenge = b"nonce-123|2026-07-02T10:00:00Z";
        let sig = id.sign_b64(challenge);

        assert!(verify_b64(&id.public_key_b64(), challenge, &sig).is_ok());
        // A tampered challenge must not verify.
        assert!(verify_b64(&id.public_key_b64(), b"different", &sig).is_err());
    }

    #[test]
    fn persists_and_reloads_same_key() {
        let path = scratch("persist");
        let a = load_or_create(&path, &NoopStore).unwrap();
        let b = load_or_create(&path, &NoopStore).unwrap();

        assert_eq!(a.public_key_b64(), b.public_key_b64());
        assert_eq!(a.device_id(), b.device_id());

        // The reloaded key still produces a signature the public key verifies.
        let ch = b"challenge";
        assert!(verify_b64(&b.public_key_b64(), ch, &a.sign_b64(ch)).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_seal_unseal_roundtrips() {
        let store = DpapiStore;
        let secret = b"top-secret-seed-bytes";
        let sealed = store.seal(secret).unwrap();
        // Ciphertext must differ from plaintext (actually encrypted at rest).
        assert_ne!(sealed.as_slice(), secret.as_slice());
        assert_eq!(store.unseal(&sealed).unwrap(), secret);
    }

    #[cfg(windows)]
    #[test]
    fn load_or_create_with_dpapi_persists() {
        let path = scratch("dpapi");
        let a = load_or_create(&path, &DpapiStore).unwrap();
        let b = load_or_create(&path, &DpapiStore).unwrap();
        assert_eq!(a.public_key_b64(), b.public_key_b64());
        assert_eq!(a.device_id(), b.device_id());

        // On-disk bytes are DPAPI-sealed, not the raw base64 secret.
        let raw = std::fs::read(&path).unwrap();
        assert!(std::str::from_utf8(&raw).is_err() || !raw.starts_with(b"{\"device_id\""));
    }
}
