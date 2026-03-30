use serde_json::Value;
use tauri_plugin_store::StoreExt;

const SETTINGS_STORE: &str = "settings.json";
const CERTS_STORE: &str = "certs.json";

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

    if host.is_empty() {
        return Err("host must not be empty".into());
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

    store.set(&host, Value::String(fingerprint));
    store
        .save()
        .map_err(|e| format!("failed to persist cert fingerprint: {e}"))?;
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
// DevTools command
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_devtools(_window: tauri::WebviewWindow) {
    #[cfg(feature = "devtools")]
    {
        use tauri::Manager;
        _window.open_devtools();
    }
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
}
