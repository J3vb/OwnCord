use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "com.owncord.client";

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
/// On macOS it is stored in the system Keychain.
#[tauri::command]
pub fn save_credential(
    host: String,
    username: String,
    token: String,
    password: Option<String>,
) -> Result<(), String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }
    if token.is_empty() {
        return Err("token must not be empty".into());
    }
    if username.is_empty() {
        return Err("username must not be empty".into());
    }

    let mut payload = serde_json::json!({
        "username": username,
        "token": token,
    });
    if let Some(ref pw) = password {
        payload["password"] = serde_json::Value::String(pw.clone());
    }

    let entry =
        Entry::new(SERVICE, &host).map_err(|e| format!("keyring entry error: {e}"))?;
    entry
        .set_password(&payload.to_string())
        .map_err(|e| format!("save_credential failed: {e}"))?;

    Ok(())
}

/// Load a credential from the system credential store.
///
/// Returns `None` when no credential exists for the given host.
#[tauri::command]
pub fn load_credential(host: String) -> Result<Option<CredentialData>, String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }

    let entry =
        Entry::new(SERVICE, &host).map_err(|e| format!("keyring entry error: {e}"))?;

    let json_str = match entry.get_password() {
        Ok(s) => s,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(format!("load_credential failed: {e}")),
    };

    let parsed: serde_json::Value = serde_json::from_str(&json_str)
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

    Ok(Some(CredentialData { username, token, password }))
}

/// Delete a credential from the system credential store.
///
/// Deleting a non-existent credential is not treated as an error.
#[tauri::command]
pub fn delete_credential(host: String) -> Result<(), String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }

    let entry =
        Entry::new(SERVICE, &host).map_err(|e| format!("keyring entry error: {e}"))?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete_credential failed: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_credential_rejects_empty_host() {
        let result = save_credential("".into(), "user".into(), "tok".into(), None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("host must not be empty"));
    }

    #[test]
    fn save_credential_rejects_empty_token() {
        let result = save_credential("host".into(), "user".into(), "".into(), None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("token must not be empty"));
    }

    #[test]
    fn save_credential_rejects_empty_username() {
        let result = save_credential("host".into(), "".into(), "tok".into(), None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("username must not be empty"));
    }

    #[test]
    fn load_credential_rejects_empty_host() {
        let result = load_credential("".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("host must not be empty"));
    }

    #[test]
    fn delete_credential_rejects_empty_host() {
        let result = delete_credential("".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("host must not be empty"));
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
