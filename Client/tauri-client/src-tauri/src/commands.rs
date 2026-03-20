use serde_json::Value;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

const SETTINGS_STORE: &str = "settings.json";
const CERTS_STORE: &str = "certs.json";

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
    if host.is_empty() {
        return Err("host must not be empty".into());
    }
    if fingerprint.is_empty() {
        return Err("fingerprint must not be empty".into());
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
pub fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(feature = "devtools")]
    window.open_devtools();
}
