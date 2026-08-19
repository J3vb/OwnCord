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
    set_with(
        account,
        secret,
        keyring_set,
        keyring_get,
        keyring_delete,
        |acct, sec| set_fallback(app, acct, sec),
        // Best-effort here: the keyring copy just proved it round-trips, so
        // it is authoritative regardless of whether the stale fallback copy
        // actually got flushed off disk.
        |acct| {
            let _ = clear_fallback(app, acct);
        },
    )
}

/// Core decision logic for [`set`], with the keyring and fallback operations
/// injected so the branching is testable without a live OS credential store.
fn set_with(
    account: &str,
    secret: &str,
    keyring_set: impl Fn(&str, &str) -> Result<(), String>,
    keyring_get: impl Fn(&str) -> Result<Option<String>, String>,
    keyring_delete: impl Fn(&str) -> Result<(), String>,
    fallback_set: impl FnOnce(&str, &str) -> Result<(), String>,
    fallback_clear: impl FnOnce(&str),
) -> Result<Backend, String> {
    // Set only when the keyring write itself failed and a stale prior entry
    // needs to be purged — but not until the fallback write below has proven
    // it actually committed a replacement copy. Deleting eagerly here would,
    // if the fallback write also fails, destroy the only good copy of the
    // secret and leave nothing anywhere for it to hand off to.
    let mut purge_stale_keyring_after_fallback_commits = false;

    match keyring_set(account, secret) {
        Ok(()) => match keyring_get(account) {
            // The normal path: written and read back byte-for-byte.
            Ok(Some(ref got)) if got == secret => {
                // A machine that was previously degraded and has since been
                // fixed must not keep a stale ciphertext shadowing the real
                // store on the next read.
                fallback_clear(account);
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
        Err(e) => {
            log::error!("{SERVICE}: credential store write failed for '{account}': {e}");
            // An older secret may already sit in the keyring from a prior
            // successful write. get() reads the keyring first, so leaving
            // that stale entry in place would shadow the fresh secret parked
            // in the fallback below — mirrors the read-back-mismatch arm
            // above, which purges for the same reason. But the purge must
            // wait until fallback_set below has actually committed the
            // replacement: deleting now, before that write is known to
            // succeed, risks erasing the last good copy of the secret if the
            // fallback write fails too.
            purge_stale_keyring_after_fallback_commits = true;
        }
    }

    fallback_set(account, secret)?;

    if purge_stale_keyring_after_fallback_commits {
        if let Err(de) = keyring_delete(account) {
            log::warn!(
                "{SERVICE}: could not remove a stale keyring entry for '{account}' after a \
                 failed write: {de}"
            );
        }
    }

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
    get_with(account, keyring_get, |acct| get_fallback(app, acct))
}

/// Core decision logic for [`get`], with the keyring and fallback lookups
/// injected so the branching is testable without a live OS credential store.
fn get_with(
    account: &str,
    keyring_get: impl Fn(&str) -> Result<Option<String>, String>,
    get_fallback: impl Fn(&str) -> Option<String>,
) -> Result<Option<String>, String> {
    match keyring_get(account) {
        Ok(Some(secret)) => Ok(Some(secret)),
        Ok(None) => Ok(get_fallback(account)),
        Err(e) => {
            log::warn!("{SERVICE}: credential store read failed for '{account}': {e}");
            // A read error must not collapse to "nothing stored": on a
            // healthy machine set() clears the fallback on every successful
            // write, so an empty fallback here is indistinguishable from
            // "never stored". Prefer a fallback copy if one exists; only
            // report "nothing" when both stores genuinely have nothing, and
            // otherwise propagate the error so the caller can tell a broken
            // store apart from first login.
            match get_fallback(account) {
                Some(secret) => Ok(Some(secret)),
                None => Err(e),
            }
        }
    }
}

/// Remove `account` from every store. Absent entries are not an error.
///
/// Both stores are cleared even if one errors: a delete that left the fallback
/// copy behind would resurrect a "deleted" secret on the next read.
pub fn delete(app: &AppHandle, account: &str) -> Result<(), String> {
    delete_with(account, keyring_delete, |acct| clear_fallback(app, acct))
}

/// Core decision logic for [`delete`], with the keyring and fallback removals
/// injected so the branching is testable without a live OS credential store.
fn delete_with(
    account: &str,
    keyring_delete: impl Fn(&str) -> Result<(), String>,
    fallback_clear: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let keyring_result = keyring_delete(account);
    // `Result::and`'s argument is evaluated eagerly, so `fallback_clear` runs
    // regardless of whether the keyring delete succeeded — both stores are
    // still cleared even if one errors. Whichever side failed is what gets
    // reported: a delete must not read as Ok(()) while either store still
    // holds the "deleted" secret.
    keyring_result.and(fallback_clear(account))
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

/// Drop any fallback copy of `account`, flushing the removal to disk.
///
/// Returns the flush error to the caller instead of only logging it: a
/// `delete()` that reported success while this failed to flush would leave
/// the sealed secret on disk to resurrect the "deleted" credential on the
/// next read. Callers where the keyring copy is authoritative (a `set()`
/// recovering from a stale fallback) may still discard the `Err` themselves.
fn clear_fallback(app: &AppHandle, account: &str) -> Result<(), String> {
    let store = app
        .store(CREDENTIAL_FALLBACK_STORE)
        .map_err(|e| format!("failed to open credential fallback store: {e}"))?;
    // `delete` reports whether a key was present; only flush when one was, so
    // the common healthy path does not rewrite the file on every save.
    if store.delete(account) {
        if let Err(e) = store.save() {
            return Err(format!(
                "failed to flush credential fallback removal for '{account}': {e}"
            ));
        }
    }
    Ok(())
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

    // -- get_with: finding "a keyring read error must not read as 'not stored'" --

    #[test]
    fn get_with_falls_back_when_the_keyring_errors_but_the_fallback_has_a_copy() {
        let result = get_with(
            "identity:chat.example",
            |_| Err("keychain locked".to_string()),
            |_| Some("fallback-secret".to_string()),
        );
        assert_eq!(result, Ok(Some("fallback-secret".to_string())));
    }

    #[test]
    fn get_with_propagates_the_keyring_error_when_the_fallback_is_also_empty() {
        // The bug: a keyring read failure must never be reported as "nothing
        // stored" (Ok(None)) when the fallback is empty too — that is
        // indistinguishable from first login, and the E2EE identity keypair
        // loader mints and publishes a brand-new identity key on exactly that
        // signal, invalidating every peer's TOFU pin.
        let result = get_with("identity:chat.example", |_| Err("keychain locked".to_string()), |_| None);
        assert_eq!(result, Err("keychain locked".to_string()));
    }

    #[test]
    fn get_with_prefers_the_live_keyring_value_over_the_fallback() {
        let result = get_with("acct", |_| Ok(Some("live".to_string())), |_| Some("stale".to_string()));
        assert_eq!(result, Ok(Some("live".to_string())));
    }

    #[test]
    fn get_with_uses_the_fallback_when_the_keyring_has_nothing_stored() {
        let result = get_with("acct", |_| Ok(None), |_| Some("fallback".to_string()));
        assert_eq!(result, Ok(Some("fallback".to_string())));
    }

    // -- set_with: finding "a failed keyring write must not leave a stale entry" --

    #[test]
    fn set_with_deletes_any_stale_keyring_entry_when_the_write_fails() {
        // The bug: a write failure with an older secret already sitting in
        // the keyring from a prior successful write must not leave that
        // stale entry in place — get() reads the keyring first, so it would
        // shadow the fresh secret parked in the fallback below forever.
        use std::cell::Cell;
        let delete_called = Cell::new(false);
        let result = set_with(
            "acct",
            "new-secret",
            |_, _| Err("write failed".to_string()),
            |_| panic!("keyring_get must not run after a failed write"),
            |_| {
                delete_called.set(true);
                Ok(())
            },
            |_, _| Ok(()),
            |_| {},
        );
        assert_eq!(result, Ok(FALLBACK_BACKEND));
        assert!(
            delete_called.get(),
            "a failed keyring write must delete any stale prior entry before falling back"
        );
    }

    #[test]
    fn set_with_keeps_the_stale_keyring_entry_when_the_write_and_fallback_both_fail() {
        // The bug: a failed keyring write must not delete the existing
        // keyring entry before the fallback write it is handing off to has
        // actually committed. If the fallback write also fails, deleting
        // first destroys the only good copy of the secret and the caller
        // (e.g. save_identity_key) gets an Err with nothing left anywhere —
        // the next get() then returns Ok(None), indistinguishable from
        // first login.
        use std::cell::Cell;
        let delete_called = Cell::new(false);
        let result = set_with(
            "acct",
            "new-secret",
            |_, _| Err("write failed".to_string()),
            |_| panic!("keyring_get must not run after a failed write"),
            |_| {
                delete_called.set(true);
                Ok(())
            },
            |_, _| Err("fallback failed too".to_string()),
            |_| {},
        );
        assert!(result.is_err());
        assert!(
            !delete_called.get(),
            "a failed keyring write must not delete the existing entry until the fallback \
             write has actually committed a replacement copy"
        );
    }

    #[test]
    fn set_with_returns_keyring_backend_when_the_write_round_trips() {
        use std::cell::Cell;
        let cleared = Cell::new(false);
        let result = set_with(
            "acct",
            "secret",
            |_, s| {
                assert_eq!(s, "secret");
                Ok(())
            },
            |_| Ok(Some("secret".to_string())),
            |_| panic!("must not delete a keyring entry that round-tripped"),
            |_, _| panic!("must not touch the fallback on a successful round trip"),
            |_| cleared.set(true),
        );
        assert_eq!(result, Ok(Backend::Keyring));
        assert!(cleared.get(), "a recovered machine must clear any stale fallback copy");
    }

    // -- delete_with: finding "delete must not report success while the
    //    fallback copy survives on disk to resurrect a deleted secret" --

    #[test]
    fn delete_with_propagates_a_fallback_flush_failure() {
        // The bug: a delete that removed the keyring entry but failed to
        // flush the fallback file's removal must not report Ok(()) — the
        // sealed secret is still on disk and comes back on the next launch.
        let result = delete_with("acct", |_| Ok(()), |_| Err("disk full".to_string()));
        assert_eq!(result, Err("disk full".to_string()));
    }

    #[test]
    fn delete_with_clears_the_fallback_even_when_the_keyring_delete_fails() {
        use std::cell::Cell;
        let fallback_cleared = Cell::new(false);
        let result = delete_with(
            "acct",
            |_| Err("keyring delete failed".to_string()),
            |_| {
                fallback_cleared.set(true);
                Ok(())
            },
        );
        assert_eq!(result, Err("keyring delete failed".to_string()));
        assert!(
            fallback_cleared.get(),
            "delete must still clear the fallback even when the keyring delete errors"
        );
    }

    #[test]
    fn delete_with_succeeds_when_both_stores_clear() {
        let result = delete_with("acct", |_| Ok(()), |_| Ok(()));
        assert_eq!(result, Ok(()));
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
