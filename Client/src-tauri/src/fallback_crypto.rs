//! Encryption for the non-Windows credential fallback file.
//!
//! Windows parks fallback secrets behind DPAPI, whose key lives with the OS.
//! macOS and Linux have no DPAPI equivalent that works while the Keychain /
//! Secret Service itself is the thing that failed, so this module seals
//! secrets with ChaCha20-Poly1305 (via `ring`, already in the tree) under a
//! per-install random key stored next to the app data (mode 0600).
//!
//! This is damage control, not a vault: an attacker who can read both the key
//! file and the fallback store as this user has the secrets, exactly as they
//! would with DPAPI under the same user account. What it buys is (a) secrets
//! at rest are never plaintext, (b) a copied fallback store is useless without
//! the key file beside it, and (c) an entry cannot be moved between accounts
//! — the account name is bound in as AEAD associated data, mirroring the DPAPI
//! entropy on Windows. The OS credential store always remains the primary
//! store; this file only ever holds entries whose keychain write failed a
//! verified round-trip (see `secret_store`).

use std::fs;
use std::io::Write;
use std::path::Path;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};

use crate::constants::CREDENTIAL_FALLBACK_KEY_FILE;

/// Size of the sealing key in bytes (ChaCha20-Poly1305).
pub const KEY_LEN: usize = 32;

/// Load the per-install sealing key from `dir`, creating it on first use.
///
/// The key file is written with owner-only permissions (0600) and never
/// rewritten once it exists — losing it orphans every sealed entry, which the
/// caller treats the same as an absent entry.
pub fn load_or_create_key(dir: &Path) -> Result<[u8; KEY_LEN], String> {
    let path = dir.join(CREDENTIAL_FALLBACK_KEY_FILE);

    match fs::read(&path) {
        Ok(bytes) => {
            let key: [u8; KEY_LEN] = bytes.as_slice().try_into().map_err(|_| {
                format!(
                    "credential fallback key file has {} bytes, expected {KEY_LEN} — \
                     refusing to use it",
                    bytes.len()
                )
            })?;
            return Ok(key);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("failed to read credential fallback key: {e}")),
    }

    let mut key = [0u8; KEY_LEN];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "system RNG failed generating the fallback key".to_string())?;

    fs::create_dir_all(dir)
        .map_err(|e| format!("failed to create app data dir for fallback key: {e}"))?;

    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => finish_new_key_file(&path, key, || {
            file.write_all(&key).and_then(|()| file.sync_all())
        }),
        // Lost the create race to another thread — use the winner's key.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let bytes = fs::read(&path)
                .map_err(|e| format!("failed to re-read credential fallback key: {e}"))?;
            bytes
                .as_slice()
                .try_into()
                .map_err(|_| "concurrently written fallback key has the wrong size".to_string())
        }
        Err(e) => Err(format!("failed to create credential fallback key: {e}")),
    }
}

/// Finish writing a just-created (empty) key file: run `write_and_sync` — the
/// real write_all + sync_all in production, injected here so the failure
/// path is testable without forcing a genuine disk-full/IO error — and
/// delete the file again if it fails.
///
/// `create_new` above already created `path` with zero bytes in it. Left
/// behind, a write/sync failure leaves a short file that every future
/// `load_or_create_key` call reads back and rejects forever (see this
/// function's doc comment: "never rewritten once it exists") — silently
/// poisoning the fallback store on the first ENOSPC/IO hiccup.
fn finish_new_key_file(
    path: &Path,
    key: [u8; KEY_LEN],
    write_and_sync: impl FnOnce() -> std::io::Result<()>,
) -> Result<[u8; KEY_LEN], String> {
    if let Err(e) = write_and_sync() {
        let _ = fs::remove_file(path);
        return Err(format!("failed to write credential fallback key: {e}"));
    }
    Ok(key)
}

/// Seal `plaintext` under `key`, binding `aad` (the service + account name).
///
/// Output layout: `nonce (12 bytes) || ciphertext || tag`. The nonce is random
/// per call; at the fallback store's write volume (a handful per login) the
/// birthday bound on 96-bit nonces is not a concern.
pub fn protect(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let unbound = UnboundKey::new(&CHACHA20_POLY1305, key)
        .map_err(|_| "failed to build the fallback sealing key".to_string())?;
    let sealing = LessSafeKey::new(unbound);

    let mut nonce_bytes = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "system RNG failed generating a nonce".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut in_out = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| "sealing the fallback entry failed".to_string())?;

    let mut blob = Vec::with_capacity(NONCE_LEN + in_out.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.append(&mut in_out);
    Ok(blob)
}

/// Open a blob produced by [`protect`]. Fails on tampering, a wrong key, or a
/// blob moved to a different account's slot (AAD mismatch).
pub fn unprotect(key: &[u8; KEY_LEN], blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < NONCE_LEN + CHACHA20_POLY1305.tag_len() {
        return Err("fallback entry is too short to be a sealed blob".to_string());
    }
    let unbound = UnboundKey::new(&CHACHA20_POLY1305, key)
        .map_err(|_| "failed to build the fallback sealing key".to_string())?;
    let opening = LessSafeKey::new(unbound);

    let nonce_bytes: [u8; NONCE_LEN] = blob[..NONCE_LEN].try_into().expect("length checked");
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut in_out = blob[NONCE_LEN..].to_vec();
    let plaintext = opening
        .open_in_place(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| {
            "fallback entry failed authentication — wrong key, tampered data, or an entry \
             moved between accounts"
                .to_string()
        })?;
    Ok(plaintext.to_vec())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; KEY_LEN] {
        let mut key = [0u8; KEY_LEN];
        SystemRandom::new().fill(&mut key).unwrap();
        key
    }

    #[test]
    fn round_trips_a_secret() {
        let key = test_key();
        let blob = protect(&key, b"hunter2", b"aad").unwrap();
        assert_ne!(&blob[NONCE_LEN..], b"hunter2", "blob must not be plaintext");
        assert_eq!(unprotect(&key, &blob, b"aad").unwrap(), b"hunter2");
    }

    #[test]
    fn rejects_a_foreign_aad() {
        // A blob moved to another account's slot must not decrypt — the same
        // property dpapi_entropy provides on Windows.
        let key = test_key();
        let blob = protect(&key, b"secret", b"com.owncord.client\x01a.example").unwrap();
        assert!(unprotect(&key, &blob, b"com.owncord.client\x01b.example").is_err());
    }

    #[test]
    fn rejects_a_wrong_key_and_tampering() {
        let key = test_key();
        let blob = protect(&key, b"secret", b"aad").unwrap();

        let other = test_key();
        assert!(unprotect(&other, &blob, b"aad").is_err());

        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(unprotect(&key, &tampered, b"aad").is_err());

        assert!(
            unprotect(&key, &blob[..NONCE_LEN], b"aad").is_err(),
            "truncated blob"
        );
    }

    #[test]
    fn nonces_are_unique_per_seal() {
        let key = test_key();
        let a = protect(&key, b"same", b"aad").unwrap();
        let b = protect(&key, b"same", b"aad").unwrap();
        assert_ne!(a, b, "two seals of the same plaintext must differ");
    }

    #[test]
    fn creates_and_reuses_the_key_file() {
        let dir =
            std::env::temp_dir().join(format!("owncord-fallback-key-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let first = load_or_create_key(&dir).unwrap();
        let second = load_or_create_key(&dir).unwrap();
        assert_eq!(first, second, "the key must be stable across loads");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(CREDENTIAL_FALLBACK_KEY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "key file must be owner-only");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removes_the_partial_file_when_the_write_fails() {
        // A crash / ENOSPC mid-write must not leave a short file behind:
        // load_or_create_key's doc comment says the key file is "never
        // rewritten once it exists", so a poisoned short file is permanent —
        // every future load fails the length check forever.
        let dir = std::env::temp_dir().join(format!(
            "owncord-fallback-partial-write-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CREDENTIAL_FALLBACK_KEY_FILE);
        // `create_new` in load_or_create_key already created this empty file
        // before the write step (which is what's under test) runs.
        fs::write(&path, b"").unwrap();

        let err = finish_new_key_file(&path, [7u8; KEY_LEN], || {
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();

        assert!(err.contains("failed to write"), "unexpected error: {err}");
        assert!(
            !path.exists(),
            "a failed write must not leave a partial key file behind"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_corrupt_key_file() {
        let dir = std::env::temp_dir().join(format!(
            "owncord-fallback-badkey-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CREDENTIAL_FALLBACK_KEY_FILE), b"short").unwrap();

        let err = load_or_create_key(&dir).unwrap_err();
        assert!(err.contains("expected 32"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&dir);
    }
}
