use serde::Serialize;
use tauri::AppHandle;

use crate::secret_store::{self, Backend};

/// Data returned from `load_credential`.
#[derive(Serialize, Clone)]
pub struct CredentialData {
    pub username: String,
    pub token: String,
    // Password is stored in the credential blob for re-authentication but
    // is never serialized back to the frontend over IPC to limit exposure.
    #[serde(skip)]
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
#[tauri::command]
pub fn save_credential(
    app: AppHandle,
    host: String,
    username: String,
    token: String,
    password: Option<String>,
) -> Result<(), String> {
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
}

/// Load a credential from the system credential store.
///
/// Returns `None` when no credential exists for the given host.
#[tauri::command]
pub fn load_credential(app: AppHandle, host: String) -> Result<Option<CredentialData>, String> {
    require_non_empty(&host, "host")?;

    let Some(json_str) = secret_store::get(&app, &login_account(&host))
        .map_err(|e| format!("load_credential failed: {e}"))?
    else {
        return Ok(None);
    };

    parse_credential_blob(&json_str).map(Some)
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
#[tauri::command]
pub fn delete_credential(app: AppHandle, host: String) -> Result<(), String> {
    require_non_empty(&host, "host")?;
    secret_store::delete(&app, &login_account(&host))
        .map_err(|e| format!("delete_credential failed: {e}"))
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
#[tauri::command]
pub fn save_identity_key(app: AppHandle, host: String, key: String) -> Result<(), String> {
    require_non_empty(&host, "host")?;
    require_non_empty(&key, "key")?;

    secret_store::set(&app, &identity_account(&host), &key)
        .map_err(|e| format!("save_identity_key failed: {e}"))?;
    Ok(())
}

/// Load the identity private key for `host`.
///
/// Returns `None` when no identity key exists for the given host.
#[tauri::command]
pub fn load_identity_key(app: AppHandle, host: String) -> Result<Option<String>, String> {
    require_non_empty(&host, "host")?;
    secret_store::get(&app, &identity_account(&host))
        .map_err(|e| format!("load_identity_key failed: {e}"))
}

/// Delete the identity private key for `host`.
///
/// Deleting a non-existent key is not treated as an error.
#[tauri::command]
pub fn delete_identity_key(app: AppHandle, host: String) -> Result<(), String> {
    require_non_empty(&host, "host")?;
    secret_store::delete(&app, &identity_account(&host))
        .map_err(|e| format!("delete_identity_key failed: {e}"))
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
#[tauri::command]
pub fn probe_credential_store(app: AppHandle) -> CredentialStoreProbe {
    // Underscores are not legal in DNS hostnames, so this cannot collide with a
    // real `{host}` or `identity:{host}` account.
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
    fn credential_data_skips_password_in_json() {
        let data = CredentialData {
            username: "alice".into(),
            token: "tok".into(),
            password: Some("pw".into()),
        };
        let json = serde_json::to_string(&data).unwrap();
        assert!(!json.contains("password"));
        assert!(!json.contains("pw"));
    }
}
