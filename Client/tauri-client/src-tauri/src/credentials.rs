use serde::Serialize;
use std::ptr;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

/// Data returned from `load_credential`.
#[derive(Serialize, Clone)]
pub struct CredentialData {
    pub username: String,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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

/// Save a credential (username + token) to Windows Credential Manager.
///
/// Target name: `OwnCord/{host}`
/// Blob: JSON `{"username":"...","token":"..."}`
///
/// NOTE: The `password` parameter is accepted for API compatibility but is
/// intentionally NOT stored. Only the session token is persisted — storing
/// plaintext passwords in the credential blob is an unnecessary security risk.
#[tauri::command]
pub fn save_credential(host: String, username: String, token: String, _password: Option<String>) -> Result<(), String> {
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

    let payload = serde_json::json!({
        "username": username,
        "token": token,
    });
    let blob = payload.to_string().into_bytes();

    let mut cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_ptr() as *mut u16),
        Comment: PWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(wide_user.as_ptr() as *mut u16),
    };

    unsafe {
        CredWriteW(&mut cred, 0)
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
    let result = unsafe {
        let cred = &*pcred;
        let blob_slice = std::slice::from_raw_parts(
            cred.CredentialBlob,
            cred.CredentialBlobSize as usize,
        );
        let json_str = String::from_utf8(blob_slice.to_vec())
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

        // Free the credential memory allocated by Windows.
        CredFree(pcred as *const std::ffi::c_void);

        Ok(Some(CredentialData { username, token, password }))
    };

    result
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
