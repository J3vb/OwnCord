use serde::Serialize;
use std::sync::Mutex;
use tauri::AppHandle;

use crate::secret_store::{self, Backend};

/// Data returned from `load_credential`.
#[derive(Serialize, Clone)]
pub struct CredentialData {
    pub username: String,
    pub token: String,
    // Password is stored in the credential blob for re-authentication and is
    // serialized back to the frontend over IPC so the login form can prefill
    // it when the user ticked "Remember password".
    pub password: Option<String>,
}

impl std::fmt::Debug for CredentialData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialData")
            .field("username", &self.username)
            .field("token", &"[REDACTED]")
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Account naming
// ---------------------------------------------------------------------------
//
// Both secrets live in the same credential-store service
// (`secret_store::SERVICE`) and are told apart by their account name. Changing
// either function orphans every credential already stored under the old name,
// so they are pure and covered by tests.

/// Account holding the login credential for `host`.
fn login_account(host: &str) -> String {
    host.to_string()
}

/// Account holding the voice-E2EE identity private key for `host`.
///
/// The `identity:` prefix keeps it distinct from the login credential for the
/// same host; a collision would make one secret overwrite the other.
fn identity_account(host: &str) -> String {
    format!("identity:{host}")
}

fn require_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cross-command serialization
// ---------------------------------------------------------------------------
//
// B4-3 moved every command below to `#[tauri::command(async)]` so the
// blocking keyring/DPAPI I/O runs off Tauri's IPC main thread instead of
// freezing the UI on it. Before that, Tauri ran all (sync) commands one at a
// time on that thread, so two overlapping invocations were always fully
// serialized in arrival order. `async` dispatches each invocation onto the
// async runtime's thread pool instead, so two overlapping calls can now
// genuinely run concurrently and interleave their OS credential-store
// operations.
//
// That is reachable, not hypothetical: `identity.ts`'s legacy-key migration
// does a save-then-delete pair for two different accounts, and logging out
// fires a fire-and-forget `delete_credential` for a host whose connect-page
// auto-login can immediately issue `load_credential` for the very same host.
// Nothing upstream awaits the delete before the read can start.
//
// This mutex restores the "only one credential-store operation in flight at
// a time" property that made ordering safe pre-`async`, without giving back
// the perf win: it guards the whole command body (not just the raw OS call),
// so the fallback file's read-modify-write in `secret_store::set_with` is
// still atomic with respect to a concurrent read or delete for the same or a
// different account.
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` with every other credential-store command excluded. Poisoning is
/// recovered from (the guarded value is `()`, so there is nothing to
/// distrust) rather than propagated, so a panic inside one command cannot
/// permanently wedge every credential operation for the rest of the process.
fn with_credential_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = CREDENTIAL_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Save a credential (username + token + optional password) to the system
/// credential store.
///
/// Credential key: service=`com.owncord.client`, account=`host`
/// Secret: JSON `{"username":"...","token":"...","password":"..."}`
///
/// On Windows the secret is protected by DPAPI via Windows Credential Manager.
/// On Linux it is stored in the Secret Service (GNOME Keyring / KWallet).
/// On macOS it is stored in the system Keychain. The write is read back before
/// this returns — see [`crate::secret_store`] for what happens when it does not
/// come back.
#[tauri::command(async)]
pub fn save_credential(
    app: AppHandle,
    host: String,
    username: String,
    token: String,
    password: Option<String>,
) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        require_non_empty(&token, "token")?;
        require_non_empty(&username, "username")?;

        let mut payload = serde_json::json!({
            "username": username,
            "token": token,
        });
        if let Some(ref pw) = password {
            payload["password"] = serde_json::Value::String(pw.clone());
        }

        secret_store::set(&app, &login_account(&host), &payload.to_string())
            .map_err(|e| format!("save_credential failed: {e}"))?;
        Ok(())
    })
}

/// Load a credential from the system credential store.
///
/// Returns `None` when no credential exists for the given host.
#[tauri::command(async)]
pub fn load_credential(app: AppHandle, host: String) -> Result<Option<CredentialData>, String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;

        let Some(json_str) = secret_store::get(&app, &login_account(&host))
            .map_err(|e| format!("load_credential failed: {e}"))?
        else {
            return Ok(None);
        };

        parse_credential_blob(&json_str).map(Some)
    })
}

/// Parse the stored credential JSON blob.
///
/// Split out from the command so the blob contract is testable without a
/// credential store.
fn parse_credential_blob(json_str: &str) -> Result<CredentialData, String> {
    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("credential blob is not valid JSON: {e}"))?;

    let username = parsed
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("credential blob missing 'username' field")?
        .to_string();
    let token = parsed
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or("credential blob missing 'token' field")?
        .to_string();
    let password = parsed
        .get("password")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(CredentialData {
        username,
        token,
        password,
    })
}

/// Delete a credential from the system credential store.
///
/// Deleting a non-existent credential is not treated as an error.
#[tauri::command(async)]
pub fn delete_credential(app: AppHandle, host: String) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        secret_store::delete(&app, &login_account(&host))
            .map_err(|e| format!("delete_credential failed: {e}"))
    })
}

// ---------------------------------------------------------------------------
// Identity-key commands (F3: voice E2EE TOFU long-term identity keypair)
// ---------------------------------------------------------------------------
//
// Mirrors save/load/delete_credential, but the secret is a single opaque
// key blob (base64 JWK private key) rather than a JSON credential struct,
// and it is stored under account `identity:{host}` to keep it distinct from
// the login credential entry (account `{host}`) in the same service.

/// Save the long-term identity private key for `host`.
///
/// The write is read back before this returns. A machine whose credential store
/// accepts writes without keeping them falls through to the encrypted fallback
/// file (DPAPI on Windows, sealed per-install key elsewhere); if that is also
/// unavailable this returns an error rather than reporting a success that would
/// leave peers rejecting the user's voice announce after a restart.
#[tauri::command(async)]
pub fn save_identity_key(app: AppHandle, host: String, key: String) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        require_non_empty(&key, "key")?;

        secret_store::set(&app, &identity_account(&host), &key)
            .map_err(|e| format!("save_identity_key failed: {e}"))?;
        Ok(())
    })
}

/// Load the identity private key for `host`.
///
/// Returns `None` when no identity key exists for the given host.
#[tauri::command(async)]
pub fn load_identity_key(app: AppHandle, host: String) -> Result<Option<String>, String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        secret_store::get(&app, &identity_account(&host))
            .map_err(|e| format!("load_identity_key failed: {e}"))
    })
}

/// Delete the identity private key for `host`.
///
/// Deleting a non-existent key is not treated as an error.
#[tauri::command(async)]
pub fn delete_identity_key(app: AppHandle, host: String) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        secret_store::delete(&app, &identity_account(&host))
            .map_err(|e| format!("delete_identity_key failed: {e}"))
    })
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Result of [`probe_credential_store`].
#[derive(Serialize, Debug)]
pub struct CredentialStoreProbe {
    /// Whether a write/read/delete cycle completed with the value intact.
    pub ok: bool,
    /// Which store served the probe, when it succeeded.
    pub backend: Option<Backend>,
    /// Failure detail, for the log and the support bundle.
    pub error: Option<String>,
}

/// Write, read back and delete a throwaway secret to prove the credential store
/// works on this machine.
///
/// This is the check to run when a user reports peers rejecting their voice
/// announce: it distinguishes "the credential store is fine" from "writes are
/// accepted and dropped" without touching any real credential. The probe
/// account is removed again whatever the outcome.
#[tauri::command(async)]
pub fn probe_credential_store(app: AppHandle) -> CredentialStoreProbe {
    with_credential_lock(|| {
        // Underscores are not legal in DNS hostnames, so this cannot collide
        // with a real `{host}` or `identity:{host}` account.
        const PROBE_ACCOUNT: &str = "__diagnostic_probe__";
        const PROBE_SECRET: &str = "owncord-credential-store-probe";

        let result = secret_store::set(&app, PROBE_ACCOUNT, PROBE_SECRET).and_then(|backend| {
            match secret_store::get(&app, PROBE_ACCOUNT)? {
                Some(ref got) if got == PROBE_SECRET => Ok(backend),
                Some(_) => Err("read back a different value than was written".into()),
                None => Err("the store reported a successful write but returned no entry".into()),
            }
        });

        // Always clean up, including when the probe failed part-way through.
        if let Err(e) = secret_store::delete(&app, PROBE_ACCOUNT) {
            log::warn!("failed to remove credential store probe entry: {e}");
        }

        match result {
            Ok(backend) => {
                log::info!("credential store probe succeeded (backend: {backend:?})");
                CredentialStoreProbe {
                    ok: true,
                    backend: Some(backend),
                    error: None,
                }
            }
            Err(e) => {
                log::error!("credential store probe failed: {e}");
                CredentialStoreProbe {
                    ok: false,
                    backend: None,
                    error: Some(e),
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_non_empty_rejects_empty_and_names_the_field() {
        let err = require_non_empty("", "host").unwrap_err();
        assert_eq!(err, "host must not be empty");
        assert_eq!(
            require_non_empty("", "token").unwrap_err(),
            "token must not be empty"
        );
        assert_eq!(
            require_non_empty("", "username").unwrap_err(),
            "username must not be empty"
        );
        assert_eq!(
            require_non_empty("", "key").unwrap_err(),
            "key must not be empty"
        );
    }

    #[test]
    fn require_non_empty_accepts_a_value() {
        assert!(require_non_empty("chat.example.com", "host").is_ok());
    }

    #[test]
    fn login_and_identity_accounts_never_collide() {
        // Both secrets share one credential-store service, so a collision would
        // silently overwrite one with the other.
        let host = "chat.example.com";
        assert_eq!(login_account(host), "chat.example.com");
        assert_eq!(identity_account(host), "identity:chat.example.com");
        assert_ne!(login_account(host), identity_account(host));
    }

    #[test]
    fn account_names_keep_the_port_that_distinguishes_hosts() {
        // Two servers on one machine differ only by port; dropping it would
        // make them share an identity key.
        assert_ne!(login_account("localhost:8443"), login_account("localhost:9443"));
        assert_eq!(identity_account("localhost:8443"), "identity:localhost:8443");
    }

    #[test]
    fn parse_credential_blob_reads_all_fields() {
        let data =
            parse_credential_blob(r#"{"username":"alice","token":"tok","password":"pw"}"#).unwrap();
        assert_eq!(data.username, "alice");
        assert_eq!(data.token, "tok");
        assert_eq!(data.password.as_deref(), Some("pw"));
    }

    #[test]
    fn parse_credential_blob_allows_missing_password() {
        let data = parse_credential_blob(r#"{"username":"alice","token":"tok"}"#).unwrap();
        assert_eq!(data.password, None);
    }

    #[test]
    fn parse_credential_blob_rejects_malformed_input() {
        assert!(parse_credential_blob("not json").unwrap_err().contains("not valid JSON"));
        assert!(parse_credential_blob(r#"{"token":"tok"}"#)
            .unwrap_err()
            .contains("missing 'username'"));
        assert!(parse_credential_blob(r#"{"username":"alice"}"#)
            .unwrap_err()
            .contains("missing 'token'"));
    }

    #[test]
    fn credential_data_debug_redacts_sensitive_fields() {
        let data = CredentialData {
            username: "alice".into(),
            token: "secret-token".into(),
            password: Some("hunter2".into()),
        };
        let debug = format!("{data:?}");
        assert!(debug.contains("alice"));
        assert!(!debug.contains("secret-token"));
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn credential_data_serializes_password_for_prefill() {
        let data = CredentialData {
            username: "alice".into(),
            token: "tok".into(),
            password: Some("pw".into()),
        };
        let json = serde_json::to_string(&data).unwrap();
        assert!(json.contains("password"));
        assert!(json.contains("pw"));
    }

    /// B4-3 follow-up: all 7 commands moved to `#[tauri::command(async)]`,
    /// which runs each invocation on the async runtime's thread pool instead
    /// of Tauri's single IPC main thread. Two overlapping invocations (e.g.
    /// `identity.ts`'s save-then-delete legacy-key migration, or a logout's
    /// `delete_credential` racing a connect-page auto-login's
    /// `load_credential` for the same host) can now genuinely run
    /// concurrently. `with_credential_lock` must serialize them: this proves
    /// no two holders of the lock ever run their critical section at the
    /// same time, regardless of which OS thread the runtime schedules them
    /// on.
    #[test]
    fn credential_lock_serializes_overlapping_commands() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;
        use std::time::Duration;

        let concurrent = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let concurrent = Arc::clone(&concurrent);
                let max_concurrent = Arc::clone(&max_concurrent);
                thread::spawn(move || {
                    with_credential_lock(|| {
                        let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                        max_concurrent.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(5));
                        concurrent.fetch_sub(1, Ordering::SeqCst);
                    });
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            max_concurrent.load(Ordering::SeqCst),
            1,
            "two credential-store commands ran their critical section concurrently"
        );
    }

    /// `with_credential_lock`'s doc comment promises that poisoning is
    /// recovered from rather than propagated, so a panic inside one
    /// credential command cannot permanently wedge every later credential
    /// operation for the rest of the process. Prove it: panic while holding
    /// the lock on a spawned thread (which poisons `CREDENTIAL_LOCK`), then
    /// confirm a later `with_credential_lock` call still runs its closure
    /// instead of panicking on the poisoned mutex.
    #[test]
    fn with_credential_lock_recovers_from_a_poisoned_guard() {
        use std::thread;

        let poisoning = thread::spawn(|| {
            with_credential_lock(|| {
                panic!("boom");
            });
        });
        assert!(
            poisoning.join().is_err(),
            "expected the spawned thread to panic while holding the lock"
        );

        assert_eq!(
            with_credential_lock(|| 42),
            42,
            "with_credential_lock must recover from a poisoned mutex, not propagate it"
        );
    }
}
