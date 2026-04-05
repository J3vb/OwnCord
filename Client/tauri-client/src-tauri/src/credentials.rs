use serde::Serialize;
use std::ptr;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_NOT_FOUND;
// CRED_PERSIST_ENTERPRISE scopes credentials per-user (roams with domain
// profile). Previously CRED_PERSIST_LOCAL_MACHINE was used, which exposes
// credentials to all users on shared machines.
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_ENTERPRISE, CRED_TYPE_GENERIC,
};

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

/// Build the target name used in Windows Credential Manager.
fn target_name(host: &str) -> Vec<u16> {
    let name = format!("OwnCord/{host}");
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Encode a Rust string as a null-terminated UTF-16 vector.
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Save a credential (username + token + optional password) to Windows
/// Credential Manager.
///
/// Target name: `OwnCord/{host}`
/// Blob: JSON `{"username":"...","token":"...","password":"..."}`
///
/// The password field is only included when the user checks "Remember
/// password". Windows Credential Manager encrypts the blob at rest using
/// DPAPI, tied to the logged-in Windows user — plaintext is never on disk.
#[tauri::command]
pub fn save_credential(host: String, username: String, token: String, password: Option<String>) -> Result<(), String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }
    if token.is_empty() {
        return Err("token must not be empty".into());
    }
    if username.is_empty() {
        return Err("username must not be empty".into());
    }

    let target = target_name(&host);
    let wide_user = to_wide(&username);

    let mut payload = serde_json::json!({
        "username": username,
        "token": token,
    });
    if let Some(ref pw) = password {
        payload["password"] = serde_json::Value::String(pw.clone());
    }
    let blob = payload.to_string().into_bytes();

    let cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_ptr() as *mut u16),
        Comment: PWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_ENTERPRISE,
        AttributeCount: 0,
        Attributes: ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(wide_user.as_ptr() as *mut u16),
    };

    unsafe {
        CredWriteW(&cred, 0)
            .map_err(|e| format!("CredWriteW failed: {e}"))?;
    }

    Ok(())
}

/// Load a credential from Windows Credential Manager.
///
/// Returns `None` when no credential exists for the given host.
#[tauri::command]
pub fn load_credential(host: String) -> Result<Option<CredentialData>, String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }

    let target = target_name(&host);
    let mut pcred: *mut CREDENTIALW = ptr::null_mut();

    let read_result = unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            0,
            &mut pcred,
        )
    };

    match read_result {
        Ok(()) => {}
        Err(e) => {
            if e.code() == ERROR_NOT_FOUND.to_hresult() {
                return Ok(None);
            }
            return Err(format!("CredReadW failed: {e}"));
        }
    }

    // SAFETY: `pcred` is valid after a successful CredReadW call.
    // Copy the blob bytes and free immediately — CredFree must run even if
    // parsing fails, otherwise the credential memory leaks.
    let blob = unsafe {
        let cred = &*pcred;
        let bytes = std::slice::from_raw_parts(
            cred.CredentialBlob,
            cred.CredentialBlobSize as usize,
        )
        .to_vec();
        CredFree(pcred as *const std::ffi::c_void);
        bytes
    };

    // Parse outside the unsafe block — CredFree has already been called.
    let json_str = String::from_utf8(blob)
        .map_err(|e| format!("credential blob is not valid UTF-8: {e}"))?;

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

/// Delete a credential from Windows Credential Manager.
#[tauri::command]
pub fn delete_credential(host: String) -> Result<(), String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }

    let target = target_name(&host);

    let delete_result = unsafe {
        CredDeleteW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            0,
        )
    };

    match delete_result {
        Ok(()) => Ok(()),
        Err(e) => {
            if e.code() == ERROR_NOT_FOUND.to_hresult() {
                // Deleting a non-existent credential is not an error.
                return Ok(());
            }
            Err(format!("CredDeleteW failed: {e}"))
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
    fn target_name_encodes_host_as_utf16() {
        let result = target_name("localhost:8443");
        let expected: Vec<u16> = "OwnCord/localhost:8443"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        assert_eq!(result, expected);
    }

    #[test]
    fn target_name_empty_host() {
        let result = target_name("");
        let expected: Vec<u16> = "OwnCord/"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        assert_eq!(result, expected);
    }

    #[test]
    fn to_wide_ascii() {
        let result = to_wide("hello");
        let expected: Vec<u16> = "hello"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        assert_eq!(result, expected);
        // Last element must be null terminator
        assert_eq!(*result.last().unwrap(), 0u16);
    }

    #[test]
    fn to_wide_empty_string() {
        let result = to_wide("");
        assert_eq!(result, vec![0u16]);
    }

    #[test]
    fn to_wide_unicode() {
        let result = to_wide("日本語");
        assert_eq!(*result.last().unwrap(), 0u16);
        // 3 CJK chars + null terminator = 4 elements
        assert_eq!(result.len(), 4);
    }
}
