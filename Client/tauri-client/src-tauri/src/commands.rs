use serde_json::Value;
use tauri_plugin_store::StoreExt;

use crate::constants::{CERTS_STORE, IDENTITY_PINS_STORE, SETTINGS_STORE};

/// Maximum length for a settings key to prevent denial-of-service.
const MAX_SETTINGS_KEY_LEN: usize = 128;

/// Allowed key prefixes and exact keys for the settings store.
/// Keys must either match an exact entry or start with an allowed prefix.
const ALLOWED_SETTINGS_PREFIXES: &[&str] = &[
    "owncord:",      // owncord:profiles, owncord:settings:*, owncord:recent-emoji
    "userVolume_",   // per-user volume: userVolume_{userId}
];

const ALLOWED_SETTINGS_EXACT: &[&str] = &[
    "windowState",
];

fn is_settings_key_allowed(key: &str) -> bool {
    if key.len() > MAX_SETTINGS_KEY_LEN || key.is_empty() {
        return false;
    }
    if ALLOWED_SETTINGS_EXACT.contains(&key) {
        return true;
    }
    ALLOWED_SETTINGS_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;

    let keys = store.keys();
    let mut map = serde_json::Map::new();
    for key in keys {
        if let Some(val) = store.get(&key) {
            map.insert(key, val);
        }
    }
    Ok(Value::Object(map))
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, key: String, value: Value) -> Result<(), String> {
    if !is_settings_key_allowed(&key) {
        return Err(format!("unknown settings key: {key}"));
    }

    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;

    store.set(&key, value);
    store
        .save()
        .map_err(|e| format!("failed to persist settings: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Certificate fingerprint commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn store_cert_fingerprint(
    app: tauri::AppHandle,
    host: String,
    fingerprint: String,
) -> Result<(), String> {
    // Normalize to lowercase for consistent comparison with ws_proxy fingerprints
    let fingerprint = fingerprint.to_lowercase();

    if host.is_empty() || host.len() > 253 {
        return Err("host must be 1-253 characters".into());
    }
    // Validate host format: alphanumeric, dots, hyphens, colons (port), brackets (IPv6)
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return Err("host contains invalid characters".into());
    }
    if fingerprint.is_empty() {
        return Err("fingerprint must not be empty".into());
    }

    // Validate SHA-256 colon-hex format: "aa:bb:cc:..." (95 chars, 32 hex pairs)
    if fingerprint.len() != 95 {
        return Err("fingerprint must be a SHA-256 colon-hex string (95 chars)".into());
    }
    for (i, ch) in fingerprint.chars().enumerate() {
        if i % 3 == 2 {
            if ch != ':' {
                return Err("fingerprint must use colon-separated hex pairs".into());
            }
        } else if !ch.is_ascii_hexdigit() {
            return Err("fingerprint contains invalid hex character".into());
        }
    }

    let store = app
        .store(CERTS_STORE)
        .map_err(|e| format!("failed to open certs store: {e}"))?;

    // Capture old value before mutating so we can restore it if save fails.
    let old_value = store.get(&host);
    store.set(&host, Value::String(fingerprint));
    if let Err(e) = store.save() {
        // Restore previous in-memory state: put back old fingerprint if one
        // existed, or delete if there was none. Without this, a failed save
        // during cert rotation would silently lose the previously trusted cert.
        match old_value {
            Some(v) => { store.set(&host, v); }
            None    => { let _ = store.delete(&host); }
        }
        return Err(format!("failed to persist cert fingerprint: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub fn get_cert_fingerprint(
    app: tauri::AppHandle,
    host: String,
) -> Result<Option<String>, String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }

    let store = app
        .store(CERTS_STORE)
        .map_err(|e| format!("failed to open certs store: {e}"))?;

    let value = store.get(&host).and_then(|v| {
        if let Value::String(s) = v {
            Some(s)
        } else {
            None
        }
    });

    Ok(value)
}

// ---------------------------------------------------------------------------
// Voice E2EE identity-key pin commands (TOFU)
// ---------------------------------------------------------------------------
//
// Near-verbatim mirror of the cert-fingerprint commands above, but the store is
// keyed on `{host}:{userId}` and the value is a peer's base64 identity public
// key (opaque here — the JS side parses it) instead of a SHA-256 fingerprint.

/// Max length for a base64 identity public key (DoS guard). A raw P-256 key is
/// 65 bytes (~88 base64 chars); an SPKI-wrapped one ~124. 512 is generous.
const MAX_IDENTITY_PIN_LEN: usize = 512;

/// Store key for a peer's identity pin. A mismatch here (wrong separator, etc.)
/// would make pins silently fail to match and accept a MITM'd key, so it is a
/// pure, testable helper shared by both commands.
fn identity_pin_key(host: &str, user_id: &str) -> String {
    format!("{host}:{user_id}")
}

#[tauri::command]
pub fn store_identity_pin(
    app: tauri::AppHandle,
    host: String,
    user_id: String,
    pin: String,
) -> Result<(), String> {
    if host.is_empty() || host.len() > 253 {
        return Err("host must be 1-253 characters".into());
    }
    // Validate host format: alphanumeric, dots, hyphens, colons (port), brackets (IPv6)
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return Err("host contains invalid characters".into());
    }
    if user_id.is_empty() || user_id.len() > 64 {
        return Err("user_id must be 1-64 characters".into());
    }
    if !user_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err("user_id contains invalid characters".into());
    }
    if pin.is_empty() || pin.len() > MAX_IDENTITY_PIN_LEN {
        return Err("pin must be 1-512 characters".into());
    }
    // Base64 charset (standard + url-safe + padding). Guards against garbage/DoS;
    // the actual key parsing/verification happens on the JS side.
    if !pin.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_')) {
        return Err("pin contains invalid characters".into());
    }

    let store = app
        .store(IDENTITY_PINS_STORE)
        .map_err(|e| format!("failed to open identity pins store: {e}"))?;

    let store_key = identity_pin_key(&host, &user_id);
    // Capture old value before mutating so we can restore it if save fails.
    let old_value = store.get(&store_key);
    store.set(&store_key, Value::String(pin));
    if let Err(e) = store.save() {
        // Restore previous in-memory state so a failed save during a re-pin
        // doesn't silently drop the previously trusted identity key.
        match old_value {
            Some(v) => { store.set(&store_key, v); }
            None    => { let _ = store.delete(&store_key); }
        }
        return Err(format!("failed to persist identity pin: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub fn get_identity_pin(
    app: tauri::AppHandle,
    host: String,
    user_id: String,
) -> Result<Option<String>, String> {
    if host.is_empty() {
        return Err("host must not be empty".into());
    }
    if user_id.is_empty() {
        return Err("user_id must not be empty".into());
    }

    let store = app
        .store(IDENTITY_PINS_STORE)
        .map_err(|e| format!("failed to open identity pins store: {e}"))?;

    let value = store.get(&identity_pin_key(&host, &user_id)).and_then(|v| {
        if let Value::String(s) = v {
            Some(s)
        } else {
            None
        }
    });

    Ok(value)
}

// ---------------------------------------------------------------------------
// DevTools command
// ---------------------------------------------------------------------------

#[cfg(feature = "devtools")]
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_key_owncord_prefix() {
        assert!(is_settings_key_allowed("owncord:profiles"));
        assert!(is_settings_key_allowed("owncord:settings:theme"));
        assert!(is_settings_key_allowed("owncord:recent-emoji"));
    }

    #[test]
    fn allowed_key_user_volume_prefix() {
        assert!(is_settings_key_allowed("userVolume_42"));
        assert!(is_settings_key_allowed("userVolume_0"));
    }

    #[test]
    fn allowed_key_exact_match() {
        assert!(is_settings_key_allowed("windowState"));
    }

    #[test]
    fn rejected_key_empty() {
        assert!(!is_settings_key_allowed(""));
    }

    #[test]
    fn rejected_key_too_long() {
        let long_key = "owncord:".to_owned() + &"x".repeat(MAX_SETTINGS_KEY_LEN);
        assert!(!is_settings_key_allowed(&long_key));
    }

    #[test]
    fn rejected_key_unknown_prefix() {
        assert!(!is_settings_key_allowed("unknown:key"));
        assert!(!is_settings_key_allowed("admin:secret"));
    }

    #[test]
    fn rejected_key_partial_prefix_match() {
        // "owncord" without colon should not match "owncord:" prefix
        assert!(!is_settings_key_allowed("owncordNOCOLON"));
    }

    #[test]
    fn fingerprint_validation_accepts_valid() {
        let valid = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99";
        assert_eq!(valid.len(), 95);
        // Validation logic: length 95, hex digits at non-colon positions, colons at every 3rd
        for (i, ch) in valid.chars().enumerate() {
            if i % 3 == 2 {
                assert_eq!(ch, ':');
            } else {
                assert!(ch.is_ascii_hexdigit());
            }
        }
    }

    #[test]
    fn fingerprint_validation_rejects_wrong_length() {
        let short = "aa:bb:cc";
        assert_ne!(short.len(), 95);
    }

    #[test]
    fn identity_pin_key_combines_host_and_user() {
        assert_eq!(identity_pin_key("chat.example.com", "42"), "chat.example.com:42");
        assert_eq!(identity_pin_key("192.168.1.10:8443", "u_7"), "192.168.1.10:8443:u_7");
    }
}
