//! Secret storage with a verified round-trip and a degraded-mode fallback.
//!
//! Every secret the client persists (login credentials, voice-E2EE long-term
//! identity keys and bounded pending-message text) goes through here. The OS
//! credential store is always tried first and used when the write round-trips.
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
        |acct| keyring_get(acct).map_err(|f| f.message),
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
                // Purge it — but, as with the write-failure arm below, not
                // until fallback_set has actually committed the replacement.
                // `get` reads the credential store first, so leaving a value
                // we did not write in place would shadow the fallback copy;
                // deleting eagerly here would, if the fallback write also
                // fails, destroy the last good copy of the secret.
                purge_stale_keyring_after_fallback_commits = true;
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

/// A failed OS credential store read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReadFailure {
    message: String,
    /// The machine has no OS credential store at all (Linux: nobody provides
    /// the Secret Service on the session bus), so it cannot hold anything and
    /// the fallback file is the only store. A locked or failing store is not
    /// this.
    no_store: bool,
}

/// Core decision logic for [`get`], with the keyring and fallback lookups
/// injected so the branching is testable without a live OS credential store.
fn get_with(
    account: &str,
    keyring_get: impl Fn(&str) -> Result<Option<String>, ReadFailure>,
    get_fallback: impl Fn(&str) -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    match keyring_get(account) {
        Ok(Some(secret)) => Ok(Some(secret)),
        Ok(None) => get_fallback(account),
        Err(failure) => {
            let e = failure.message;
            if failure.no_store {
                log::debug!("{SERVICE}: no OS credential store for '{account}': {e}");
            } else {
                log::warn!("{SERVICE}: credential store read failed for '{account}': {e}");
            }
            // A read error must not collapse to "nothing stored": on a
            // healthy machine set() clears the fallback on every successful
            // write, so an empty fallback here is indistinguishable from
            // "never stored". Prefer a fallback copy if one exists; report
            // "nothing" only when both stores genuinely have nothing — the
            // fallback is empty and there is no OS store that could hold a
            // copy — and otherwise propagate the error so the caller can tell
            // a broken store apart from first login.
            match get_fallback(account) {
                Ok(Some(secret)) => Ok(Some(secret)),
                Ok(None) if failure.no_store => Ok(None),
                Ok(None) => Err(e),
                Err(fallback) => Err(format!("{e}; fallback: {fallback}")),
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
        CredentialPersistence::EntryOnly => (
            false,
            "vanishes with the entry object (the in-memory mock store)",
        ),
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
    if cfg!(target_os = "android") {
        // No OS keyring backend is compiled for Android: every secret lives
        // in the encrypted fallback file, which persists.
        log::info!("credential store: encrypted fallback file (no OS keyring on Android)");
    } else if persistent {
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

fn keyring_get(account: &str) -> Result<Option<String>, ReadFailure> {
    let entry = entry(account).map_err(|message| ReadFailure {
        message,
        no_store: false,
    })?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(ReadFailure {
            message: format!("{e}"),
            no_store: no_os_store(&e),
        }),
    }
}

/// Whether `err` says the machine has no OS credential store: on Linux, no
/// session bus at all, or a session bus where nobody provides the Secret
/// Service and nothing can be started to (no gnome-keyring, KWallet or
/// KeePassXC). A locked collection, a dismissed prompt or a provider whose
/// start failed is a different error and stays a failure.
#[cfg(target_os = "linux")]
fn no_os_store(err: &keyring::Error) -> bool {
    let keyring::Error::PlatformFailure(inner) = err else {
        return false;
    };
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(inner.as_ref());
    while let Some(e) = source {
        if let Some(bus) = e.downcast_ref::<dbus::Error>() {
            return bus
                .name()
                .is_some_and(|name| names_missing_store(name, confirm_no_provider));
        }
        source = e.source();
    }
    false
}

#[cfg(not(target_os = "linux"))]
fn no_os_store(_err: &keyring::Error) -> bool {
    false
}

/// Whether D-Bus error `name` means no OS store. The bus-connect errors (no
/// session bus) do; "no such service" does only once `confirm` finds the
/// Secret Service neither running nor startable, since a provider launched
/// from session autostart registers its name a moment after login. Every
/// other name (a failed start, a provider that left the bus) is a failure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn names_missing_store(name: &str, confirm: impl FnOnce() -> bool) -> bool {
    match name {
        "org.freedesktop.DBus.Error.NoServer"
        | "org.freedesktop.DBus.Error.FileNotFound"
        | "org.freedesktop.DBus.Error.NotSupported" => true,
        "org.freedesktop.DBus.Error.ServiceUnknown" => confirm(),
        _ => false,
    }
}

/// The Secret Service's bus name.
#[cfg(target_os = "linux")]
const SECRETS_NAME: &str = "org.freedesktop.secrets";

/// Ask the session bus whether anybody owns, or could be started to own, the
/// Secret Service's name. No answer is given before a second after the first
/// ask of the run, for a provider that is still starting from session
/// autostart: every read that arrives in that second waits for its end.
#[cfg(target_os = "linux")]
fn confirm_no_provider() -> bool {
    static NOT_BEFORE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let not_before =
        *NOT_BEFORE.get_or_init(|| std::time::Instant::now() + std::time::Duration::from_secs(1));
    std::thread::sleep(not_before.saturating_duration_since(std::time::Instant::now()));
    secret_service_absent()
}

#[cfg(target_os = "linux")]
fn secret_service_absent() -> bool {
    let timeout = std::time::Duration::from_millis(500);
    let Ok(bus) = dbus::blocking::Connection::new_session() else {
        // The bus just answered, so this is a passing failure, not "no bus"
        // (the bus-connect errors never reach this check).
        return false;
    };
    let proxy = bus.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", timeout);
    let owned: Result<(bool,), dbus::Error> =
        proxy.method_call("org.freedesktop.DBus", "NameHasOwner", (SECRETS_NAME,));
    let activatable: Result<(Vec<String>,), dbus::Error> =
        proxy.method_call("org.freedesktop.DBus", "ListActivatableNames", ());
    // Any doubt (a failed query) reads as "a store may exist".
    matches!(owned, Ok((false,)))
        && activatable.is_ok_and(|(names,)| !names.iter().any(|n| n == SECRETS_NAME))
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

    let store = crate::json_store::open(app, CREDENTIAL_FALLBACK_STORE)
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

/// The fallback copy of `account`: `Ok(None)` only when the store opened and
/// holds no entry for it. An entry that cannot be read back is an error, never
/// "nothing stored": the identity key loader mints a new key on `None`.
fn get_fallback(app: &AppHandle, account: &str) -> Result<Option<String>, String> {
    let store = crate::json_store::open(app, CREDENTIAL_FALLBACK_STORE)
        .map_err(|e| format!("failed to open credential fallback store: {e}"))?;
    let read = read_fallback_entry(account, store.get(account), |blob| {
        unprotect_secret(app, account, blob)
    });
    if let Err(e) = &read {
        log::warn!("{e}");
    }
    read
}

/// Decode a fallback store value; `open` unseals the decoded blob.
fn read_fallback_entry(
    account: &str,
    value: Option<Value>,
    open: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    let encoded = match value {
        None => return Ok(None),
        Some(Value::String(s)) => s,
        Some(_) => {
            return Err(format!(
                "credential fallback entry for '{account}' is not a string"
            ))
        }
    };
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("credential fallback entry for '{account}' is not base64: {e}"))?;
    let plaintext = open(&blob)
        .map_err(|e| format!("credential fallback entry for '{account}' did not open: {e}"))?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| format!("credential fallback entry for '{account}' is not valid UTF-8"))
}

/// Drop any fallback copy of `account`, flushing the removal to disk.
///
/// Returns the flush error to the caller instead of only logging it: a
/// `delete()` that reported success while this failed to flush would leave
/// the sealed secret on disk to resurrect the "deleted" credential on the
/// next read. Callers where the keyring copy is authoritative (a `set()`
/// recovering from a stale fallback) may still discard the `Err` themselves.
fn clear_fallback(app: &AppHandle, account: &str) -> Result<(), String> {
    let store = crate::json_store::open(app, CREDENTIAL_FALLBACK_STORE)
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
        assert_ne!(
            fallback_aad("host.example"),
            fallback_aad("identity:host.example")
        );
        assert_eq!(fallback_aad("host.example"), fallback_aad("host.example"));
    }

    // -- get_with: finding "a keyring read error must not read as 'not stored'" --

    fn failed(message: &str) -> ReadFailure {
        ReadFailure {
            message: message.to_string(),
            no_store: false,
        }
    }

    fn no_store() -> ReadFailure {
        ReadFailure {
            message: "no Secret Service provider".to_string(),
            no_store: true,
        }
    }

    #[test]
    fn get_with_falls_back_when_the_keyring_errors_but_the_fallback_has_a_copy() {
        let result = get_with(
            "identity:chat.example",
            |_| Err(failed("keychain locked")),
            |_| Ok(Some("fallback-secret".to_string())),
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
        let result = get_with(
            "identity:chat.example",
            |_| Err(failed("keychain locked")),
            |_| Ok(None),
        );
        assert_eq!(result, Err("keychain locked".to_string()));
    }

    #[test]
    fn get_with_reports_nothing_stored_when_there_is_no_os_store_and_no_fallback_copy() {
        // A Linux desktop with no Secret Service provider: the keyring can
        // hold nothing, so an empty fallback is a true "never stored", and
        // the first write (identity key, pending messages) can create the
        // fallback copy every later read finds.
        let result = get_with("identity:chat.example", |_| Err(no_store()), |_| Ok(None));
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn get_with_reads_the_fallback_copy_when_there_is_no_os_store() {
        let result = get_with(
            "identity:chat.example",
            |_| Err(no_store()),
            |_| Ok(Some("fallback-secret".to_string())),
        );
        assert_eq!(result, Ok(Some("fallback-secret".to_string())));
    }

    #[test]
    fn get_with_reports_an_unreadable_fallback_entry_as_an_error() {
        // The keyring has nothing (always so on Android): a fallback copy
        // that cannot be read is not "nothing stored", or the identity key
        // loader would mint and publish a new key over the old one.
        let result = get_with(
            "identity:chat.example",
            |_| Ok(None),
            |_| Err("did not open".to_string()),
        );
        assert_eq!(result, Err("did not open".to_string()));
        let result = get_with(
            "identity:chat.example",
            |_| Err(no_store()),
            |_| Err("did not open".to_string()),
        );
        assert_eq!(
            result,
            Err("no Secret Service provider; fallback: did not open".to_string())
        );
    }

    #[test]
    fn get_with_prefers_the_live_keyring_value_over_the_fallback() {
        let result = get_with(
            "acct",
            |_| Ok(Some("live".to_string())),
            |_| Ok(Some("stale".to_string())),
        );
        assert_eq!(result, Ok(Some("live".to_string())));
    }

    #[test]
    fn get_with_uses_the_fallback_when_the_keyring_has_nothing_stored() {
        let result = get_with("acct", |_| Ok(None), |_| Ok(Some("fallback".to_string())));
        assert_eq!(result, Ok(Some("fallback".to_string())));
    }

    #[test]
    fn read_fallback_entry_separates_no_entry_from_an_unreadable_one() {
        use base64::Engine as _;
        let encode = |b: &[u8]| Value::String(base64::engine::general_purpose::STANDARD.encode(b));
        let open = |b: &[u8]| Ok(b.to_vec());
        assert_eq!(read_fallback_entry("a", None, open), Ok(None));
        assert_eq!(
            read_fallback_entry("a", Some(encode(b"secret")), open),
            Ok(Some("secret".to_string()))
        );
        assert!(read_fallback_entry("a", Some(Value::String("%%".into())), open).is_err());
        assert!(read_fallback_entry("a", Some(Value::Bool(true)), open).is_err());
        assert!(read_fallback_entry("a", Some(encode(&[0xff, 0xfe])), open).is_err());
        assert!(read_fallback_entry("a", Some(encode(b"x")), |_| Err("bad key".into())).is_err());
    }

    #[test]
    fn only_a_missing_bus_or_a_confirmed_missing_provider_counts_as_no_os_store() {
        for name in [
            "org.freedesktop.DBus.Error.NoServer",
            "org.freedesktop.DBus.Error.FileNotFound",
            "org.freedesktop.DBus.Error.NotSupported",
        ] {
            assert!(
                names_missing_store(name, || panic!("no bus needs no check")),
                "{name}"
            );
        }
        assert!(names_missing_store(
            "org.freedesktop.DBus.Error.ServiceUnknown",
            || true
        ));
        assert!(
            !names_missing_store("org.freedesktop.DBus.Error.ServiceUnknown", || false),
            "a provider that is running or startable by now is a store"
        );
        for name in [
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "org.freedesktop.DBus.Error.Spawn.ChildExited",
            "org.freedesktop.DBus.Error.Spawn.ExecFailed",
            "org.freedesktop.DBus.Error.NoReply",
            "org.freedesktop.DBus.Error.Timeout",
            "org.freedesktop.DBus.Error.AccessDenied",
            "org.freedesktop.Secret.Error.IsLocked",
        ] {
            assert!(!names_missing_store(name, || true), "{name}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_wrapped_bus_error_is_found_in_the_source_chain() {
        // keyring wraps dbus-secret-service's error, whose source is the bus
        // error; the chain is walked to find it.
        #[derive(Debug)]
        struct Wrapper(dbus::Error);
        impl std::fmt::Display for Wrapper {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "DBus error: {}", self.0)
            }
        }
        impl std::error::Error for Wrapper {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let wrap = |name: &str| {
            keyring::Error::PlatformFailure(Box::new(Wrapper(dbus::Error::new_custom(
                name, "test",
            ))))
        };
        assert!(no_os_store(&wrap("org.freedesktop.DBus.Error.NoServer")));
        assert!(!no_os_store(&wrap("org.freedesktop.DBus.Error.NoReply")));
        assert!(!no_os_store(&keyring::Error::NoStorageAccess(Box::new(
            Wrapper(dbus::Error::new_custom(
                "org.freedesktop.DBus.Error.ServiceUnknown",
                "test"
            ))
        ))));
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
    fn set_with_keeps_the_mismatched_keyring_entry_when_the_fallback_also_fails() {
        // The bug: a mismatched read-back must not delete the existing
        // keyring entry before the fallback write it is handing off to has
        // actually committed — same ordering invariant as the write-failure
        // arm's mirror test above. If the fallback write also fails,
        // deleting first destroys the only good copy of the secret.
        use std::cell::Cell;
        let delete_called = Cell::new(false);
        let result = set_with(
            "acct",
            "mine",
            |_, _| Ok(()),
            |_| Ok(Some("someone-elses-secret".to_string())),
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
            "a mismatched read-back must not delete the existing entry until the fallback \
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
        assert!(
            cleared.get(),
            "a recovered machine must clear any stale fallback copy"
        );
    }

    #[test]
    fn set_with_purges_the_keyring_entry_when_the_read_back_returns_a_different_secret() {
        // The bug: get() reads the keyring first, so a foreign value left in
        // place would shadow the fallback copy written below — handing the
        // caller an identity key whose public half was never published.
        use std::cell::Cell;
        let deleted = Cell::new(false);
        let fallback_written = Cell::new(false);
        let result = set_with(
            "acct",
            "mine",
            |_, _| Ok(()),
            |_| Ok(Some("someone-elses-secret".to_string())),
            |_| {
                deleted.set(true);
                Ok(())
            },
            |_, s| {
                assert_eq!(s, "mine");
                fallback_written.set(true);
                Ok(())
            },
            |_| panic!("must not clear the fallback copy it just wrote"),
        );
        assert_eq!(result, Ok(FALLBACK_BACKEND));
        assert!(
            deleted.get(),
            "a mismatched keyring entry must be purged, not left to shadow the fallback"
        );
        assert!(
            fallback_written.get(),
            "the secret must still land in the fallback"
        );
    }

    #[test]
    fn set_with_falls_back_when_the_read_back_reports_no_entry() {
        // The shipped keyring-mock defect: set_password returns Ok(()) and the
        // very next get_password returns nothing. A write that does not read
        // back is not a write.
        use std::cell::Cell;
        let fallback_written = Cell::new(false);
        let result = set_with(
            "acct",
            "secret",
            |_, _| Ok(()),
            |_| Ok(None),
            |_| panic!("nothing round-tripped, so there is no entry to delete"),
            |_, s| {
                assert_eq!(s, "secret");
                fallback_written.set(true);
                Ok(())
            },
            |_| panic!("must not clear the fallback copy it just wrote"),
        );
        assert_eq!(result, Ok(FALLBACK_BACKEND));
        assert!(
            fallback_written.get(),
            "a write that does not read back must land in the fallback"
        );
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
        assert_ne!(
            blob.as_slice(),
            secret.as_slice(),
            "blob must not be plaintext"
        );

        let back = crate::dpapi::unprotect(&blob, &fallback_aad("identity:a.example")).unwrap();
        assert_eq!(back, secret);

        // A blob moved to another account's slot must not decrypt.
        assert!(crate::dpapi::unprotect(&blob, &fallback_aad("identity:b.example")).is_err());
    }
}
