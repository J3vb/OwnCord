//! Secret storage with a verified round-trip and a degraded-mode fallback.
//!
//! Every secret the client persists (the login credential and the voice-E2EE
//! long-term identity key) goes through here. The OS credential store is always
//! tried first and is the only store used on a healthy machine.
//!
//! # Why a write is verified
//!
//! `Entry::set_password` returning `Ok(())` does not mean the secret is
//! readable. This bit us for real: `keyring` 3.x declares no `default` feature,
//! and every platform arm in its `lib.rs` falls back to `pub use mock as
//! default` when the platform's backend feature is off. Built as a bare
//! `keyring = "3"`, the client shipped with the **mock** store on all three
//! desktop platforms — an in-memory cell owned by the `Entry` itself:
//!
//! ```text
//! save_identity_key  -> Entry::new(..)  -> set_password  -> Ok(())   // Entry dropped here
//! load_identity_key  -> Entry::new(..)  -> get_password  -> NoEntry  // brand-new empty cell
//! ```
//!
//! So a save reported success and the very next read in the same process
//! returned nothing, with no error anywhere and nothing ever written to
//! Credential Manager. Downstream, the identity keypair was regenerated on
//! every reconnect, the published key stopped matching the key that signed the
//! voice announce, and peers correctly rejected the announce as a forged
//! signature. `Cargo.toml` now names the backend features explicitly and
//! [`tests::compiled_keyring_backend_is_persistent`] fails the build if they
//! are ever dropped again — but a store that lies about a write is exactly the
//! failure a `Result` cannot express, so writes are read back regardless.
//!
//! # Fallback policy
//!
//! The keychain is the right store; the fallback is damage control, not a
//! default. It engages only after a write has been proven not to round-trip,
//! on every desktop platform. On Windows the fallback file is protected by
//! DPAPI (user-scoped, key held by the OS). On macOS and Linux — where the
//! thing that failed *is* the OS secret store, so no OS-held key is available
//! — entries are sealed with ChaCha20-Poly1305 under a per-install random key
//! file (owner-only, see [`crate::fallback_crypto`]). That is honest
//! damage-control, not a vault: same-user malware can read both files, exactly
//! as it could call DPAPI. What it fixes is the real-world failure this module
//! kept hitting — a Linux desktop with no Secret Service provider (no
//! gnome-keyring / KWallet) or a locked macOS Keychain previously had nowhere
//! to save at all, so credentials and the voice-E2EE identity key silently
//! never survived a restart. Secrets at rest are never plaintext, and the OS
//! credential store always wins again the moment it starts round-tripping.

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::constants::CREDENTIAL_FALLBACK_STORE;

/// Credential-store service name. Shared by every account this module stores.
pub const SERVICE: &str = "com.owncord.client";

/// Which store actually holds a secret.
///
/// Variant names are serialized verbatim: `tauri-typegen` does not read serde
/// rename attributes, so a `rename_all` here would silently make the generated
/// TypeScript union disagree with the values actually sent over IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Backend {
    /// The OS credential store. The expected answer on every healthy machine.
    Keyring,
    /// DPAPI-protected file under the app data dir (Windows), used only after
    /// the OS credential store accepted a write and then failed to return it.
    // Constructed only on its own platform; both variants exist everywhere so
    // the serialized Backend union is identical across OS builds.
    #[cfg_attr(not(windows), allow(dead_code))]
    DpapiFile,
    /// ChaCha20-Poly1305-sealed file under the app data dir (macOS/Linux),
    /// engaged under the same failed-round-trip condition as `DpapiFile`.
    #[cfg_attr(windows, allow(dead_code))]
    EncryptedFile,
}

/// The fallback backend this platform's build parks degraded secrets in.
#[cfg(windows)]
const FALLBACK_BACKEND: Backend = Backend::DpapiFile;
#[cfg(not(windows))]
const FALLBACK_BACKEND: Backend = Backend::EncryptedFile;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Store `secret` under `account`, and prove it can be read back.
///
/// Returns which backend ended up holding it. An `Err` means no store kept the
/// secret — the caller's in-memory copy is all that is left, so the current
/// session still works but nothing survives a restart.
pub fn set(app: &AppHandle, account: &str, secret: &str) -> Result<Backend, String> {
    match keyring_set(account, secret) {
        Ok(()) => match keyring_get(account) {
            // The normal path: written and read back byte-for-byte.
            Ok(Some(ref got)) if got == secret => {
                // A machine that was previously degraded and has since been
                // fixed must not keep a stale ciphertext shadowing the real
                // store on the next read.
                clear_fallback(app, account);
                return Ok(Backend::Keyring);
            }
            Ok(Some(_)) => {
                log::error!(
                    "{SERVICE}: credential store returned a different secret than was written \
                     for account '{account}' — falling back"
                );
                // Purge it. `get` reads the credential store first, so leaving
                // a value we did not write in place would shadow the fallback
                // copy written below — handing the caller an identity key whose
                // public half was never published, which is the exact failure
                // this module exists to prevent.
                if let Err(e) = keyring_delete(account) {
                    log::warn!(
                        "{SERVICE}: could not remove the mismatched entry for '{account}': {e}"
                    );
                }
            }
            Ok(None) => log::error!(
                "{SERVICE}: credential store accepted the write for account '{account}' \
                 but reports no entry on read-back — falling back"
            ),
            Err(e) => log::error!(
                "{SERVICE}: credential store accepted the write for account '{account}' \
                 but the read-back failed: {e} — falling back"
            ),
        },
        Err(e) => log::error!("{SERVICE}: credential store write failed for '{account}': {e}"),
    }

    set_fallback(app, account, secret)?;
    log::warn!(
        "{SERVICE}: account '{account}' is stored in the encrypted fallback file, not the OS \
         credential store. See docs/credential-storage.md"
    );
    Ok(FALLBACK_BACKEND)
}

/// Load the secret for `account`, or `None` when nothing is stored.
///
/// The OS credential store wins over the fallback file, so a machine that
/// recovers goes back to the real store without any migration step.
pub fn get(app: &AppHandle, account: &str) -> Result<Option<String>, String> {
    match keyring_get(account) {
        Ok(Some(secret)) => return Ok(Some(secret)),
        Ok(None) => {}
        Err(e) => log::warn!("{SERVICE}: credential store read failed for '{account}': {e}"),
    }
    Ok(get_fallback(app, account))
}

/// Remove `account` from every store. Absent entries are not an error.
///
/// Both stores are cleared even if one errors: a delete that left the fallback
/// copy behind would resurrect a "deleted" secret on the next read.
pub fn delete(app: &AppHandle, account: &str) -> Result<(), String> {
    let keyring_result = keyring_delete(account);
    clear_fallback(app, account);
    keyring_result
}

// ---------------------------------------------------------------------------
// Compiled-backend introspection
// ---------------------------------------------------------------------------

/// Whether the `keyring` backend compiled into this build keeps secrets on disk.
///
/// `keyring` picks its backend at compile time and falls back to the in-memory
/// mock when a platform's feature is missing, so this is a property of the
/// build, not of the machine. `CredentialPersistence` is `#[non_exhaustive]`
/// and carries no `Debug`, hence the explicit description.
fn compiled_backend_persistence() -> (bool, &'static str) {
    // `CredentialBuilderApi` needs no import: `default_credential_builder`
    // returns a `dyn` trait object, whose methods resolve without it.
    use keyring::credential::CredentialPersistence;

    match keyring::default::default_credential_builder().persistence() {
        CredentialPersistence::UntilDelete => (true, "persists until deleted (on disk)"),
        CredentialPersistence::UntilReboot => (false, "vanishes on reboot (kernel memory)"),
        CredentialPersistence::ProcessOnly => (false, "vanishes when the process exits"),
        CredentialPersistence::EntryOnly => {
            (false, "vanishes with the entry object (the in-memory mock store)")
        }
        _ => (false, "unrecognized persistence class"),
    }
}

/// Record the compiled credential backend in the log file at startup.
///
/// A shipped release build has no console, so the log file is the only place a
/// user can be asked to look. Stating the backend there turns "my identity key
/// keeps changing" into a one-line answer.
pub fn log_compiled_backend() {
    let (persistent, description) = compiled_backend_persistence();
    if persistent {
        log::info!("credential store: OS keyring, {description}");
    } else {
        log::error!(
            "credential store: NO persistent backend compiled in — {description}. Credentials \
             and the voice-E2EE identity key will not survive a restart. This is a build \
             configuration fault, not a machine fault: check the keyring backend features in \
             src-tauri/Cargo.toml."
        );
    }
}

// ---------------------------------------------------------------------------
// OS credential store
// ---------------------------------------------------------------------------

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("keyring entry error: {e}"))
}

fn keyring_set(account: &str, secret: &str) -> Result<(), String> {
    entry(account)?
        .set_password(secret)
        .map_err(|e| format!("{e}"))
}

fn keyring_get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("{e}")),
    }
}

fn keyring_delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete failed: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Degraded-mode fallback (all desktop platforms; sealing differs per OS)
// ---------------------------------------------------------------------------

/// Associated data bound into the sealed blob for `account` (the DPAPI
/// "entropy" on Windows, the AEAD AAD elsewhere).
///
/// Including the service and account means a ciphertext lifted from one entry
/// cannot be pasted over another and still decrypt — the identity key for one
/// host cannot be made to load as another's.
fn fallback_aad(account: &str) -> Vec<u8> {
    format!("{SERVICE}\u{1}{account}").into_bytes()
}

/// Seal `secret` for the fallback store. Windows: DPAPI (user-scoped, OS-held
/// key). Elsewhere: ChaCha20-Poly1305 under the per-install key file.
#[cfg(windows)]
fn protect_secret(_app: &AppHandle, account: &str, secret: &str) -> Result<Vec<u8>, String> {
    crate::dpapi::protect(secret.as_bytes(), &fallback_aad(account))
        .map_err(|code| format!("DPAPI protect failed (Win32 error {code})"))
}

#[cfg(not(windows))]
fn protect_secret(app: &AppHandle, account: &str, secret: &str) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve the app data dir for the fallback key: {e}"))?;
    let key = crate::fallback_crypto::load_or_create_key(&dir)?;
    crate::fallback_crypto::protect(&key, secret.as_bytes(), &fallback_aad(account))
}

/// Open a blob written by [`protect_secret`]. Errors are logged by the caller.
#[cfg(windows)]
fn unprotect_secret(_app: &AppHandle, account: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    crate::dpapi::unprotect(blob, &fallback_aad(account)).map_err(|code| {
        format!(
            "DPAPI unprotect failed (Win32 error {code}) — the entry was written by a \
             different Windows user or on a different machine"
        )
    })
}

#[cfg(not(windows))]
fn unprotect_secret(app: &AppHandle, account: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve the app data dir for the fallback key: {e}"))?;
    let key = crate::fallback_crypto::load_or_create_key(&dir)?;
    crate::fallback_crypto::unprotect(&key, blob, &fallback_aad(account))
}

fn set_fallback(app: &AppHandle, account: &str, secret: &str) -> Result<(), String> {
    use base64::Engine as _;

    let blob = protect_secret(app, account, secret)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(blob);

    let store = app
        .store(CREDENTIAL_FALLBACK_STORE)
        .map_err(|e| format!("failed to open credential fallback store: {e}"))?;
    let old = store.get(account);
    store.set(account, Value::String(encoded));
    if let Err(e) = store.save() {
        // Restore the previous in-memory state so a failed flush cannot drop a
        // credential that was already parked here.
        match old {
            Some(v) => store.set(account, v),
            None => {
                let _ = store.delete(account);
            }
        }
        return Err(format!("failed to persist credential fallback: {e}"));
    }
    Ok(())
}

fn get_fallback(app: &AppHandle, account: &str) -> Option<String> {
    use base64::Engine as _;

    let store = app
        .store(CREDENTIAL_FALLBACK_STORE)
        .map_err(|e| log::warn!("failed to open credential fallback store: {e}"))
        .ok()?;
    let encoded = match store.get(account) {
        Some(Value::String(s)) => s,
        _ => return None,
    };
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| log::warn!("credential fallback entry for '{account}' is not base64: {e}"))
        .ok()?;
    let plaintext = unprotect_secret(app, account, &blob)
        .map_err(|e| log::warn!("credential fallback entry for '{account}' did not open: {e}"))
        .ok()?;
    String::from_utf8(plaintext)
        .map_err(|_| log::warn!("credential fallback entry for '{account}' is not valid UTF-8"))
        .ok()
}

/// Drop any fallback copy of `account`. Best-effort: a failure here is logged,
/// never propagated, because it must not mask the outcome of the real store.
fn clear_fallback(app: &AppHandle, account: &str) {
    let Ok(store) = app.store(CREDENTIAL_FALLBACK_STORE) else {
        return;
    };
    // `delete` reports whether a key was present; only flush when one was, so
    // the common healthy path does not rewrite the file on every save.
    if store.delete(account) {
        if let Err(e) = store.save() {
            log::warn!("failed to flush credential fallback removal for '{account}': {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression guard for the bug this module exists to prevent.
    ///
    /// `keyring` has no `default` feature: with the backend features missing it
    /// silently compiles the in-memory mock store, whose writes never survive
    /// the `Entry` that made them. This asserts the backend linked into *this*
    /// build persists to disk, so dropping the features from `Cargo.toml` is a
    /// test failure rather than a silent loss of credential storage on a user's
    /// machine. It needs no live keychain — it inspects the compiled backend.
    #[test]
    fn compiled_keyring_backend_is_persistent() {
        let (persistent, description) = compiled_backend_persistence();
        assert!(
            persistent,
            "keyring compiled a non-persistent backend ({description}); the platform backend \
             features in Cargo.toml (windows-native / apple-native / sync-secret-service) are \
             missing or a platform arm fell through to `mock`"
        );
    }

    #[test]
    fn service_name_is_stable() {
        // The service name is half of the credential's identity; changing it
        // orphans every already-stored credential.
        assert_eq!(SERVICE, "com.owncord.client");
    }

    /// Pins the IPC wire format to the variant names, which is what
    /// `tauri-typegen` emits into `generated/types.ts`. Renaming a variant, or
    /// adding a serde rename, desyncs the generated union from the runtime
    /// value.
    #[test]
    fn backend_serializes_as_its_variant_name() {
        assert_eq!(
            serde_json::to_string(&Backend::Keyring).unwrap(),
            "\"Keyring\""
        );
        assert_eq!(
            serde_json::to_string(&Backend::DpapiFile).unwrap(),
            "\"DpapiFile\""
        );
        assert_eq!(
            serde_json::to_string(&Backend::EncryptedFile).unwrap(),
            "\"EncryptedFile\""
        );
    }

    #[test]
    fn fallback_aad_is_account_specific() {
        assert_ne!(fallback_aad("host.example"), fallback_aad("identity:host.example"));
        assert_eq!(fallback_aad("host.example"), fallback_aad("host.example"));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_and_rejects_foreign_entropy() {
        let secret = b"eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2In0";
        let blob = crate::dpapi::protect(secret, &fallback_aad("identity:a.example")).unwrap();
        assert_ne!(blob.as_slice(), secret.as_slice(), "blob must not be plaintext");

        let back = crate::dpapi::unprotect(&blob, &fallback_aad("identity:a.example")).unwrap();
        assert_eq!(back, secret);

        // A blob moved to another account's slot must not decrypt.
        assert!(crate::dpapi::unprotect(&blob, &fallback_aad("identity:b.example")).is_err());
    }
}
