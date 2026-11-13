//! The Android Keystore secret store (`SecretsPlugin.kt`), the store
//! `secret_store` puts first on Android where desktop uses the OS keychain.
//!
//! Calls block until the plugin answers. `secret_store` runs only on the
//! credential commands' blocking thread, never on the Android main thread
//! where the plugin's commands run, so the wait cannot deadlock.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct SecretsHandle(PluginHandle<Wry>);

pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-secrets")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "SecretsPlugin")?;
            app.manage(SecretsHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
struct SecretArgs<'a> {
    account: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<&'a str>,
}

#[derive(Deserialize)]
struct Stored {
    #[serde(default)]
    value: Option<String>,
}

fn call<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    command: &str,
    args: SecretArgs<'_>,
) -> Result<T, String> {
    let state = app
        .try_state::<SecretsHandle>()
        .ok_or_else(|| "Android Keystore plugin is not registered".to_string())?;
    state
        .0
        .run_mobile_plugin(command, args)
        .map_err(|e| format!("Android Keystore {command} failed: {e}"))
}

pub(crate) fn set(app: &AppHandle, account: &str, secret: &str) -> Result<(), String> {
    let args = SecretArgs {
        account,
        secret: Some(secret),
    };
    call(app, "secretSet", args)
}

pub(crate) fn get(app: &AppHandle, account: &str) -> Result<Option<String>, String> {
    let args = SecretArgs {
        account,
        secret: None,
    };
    call::<Stored>(app, "secretGet", args).map(|stored| stored.value)
}

pub(crate) fn delete(app: &AppHandle, account: &str) -> Result<(), String> {
    let args = SecretArgs {
        account,
        secret: None,
    };
    call(app, "secretDelete", args)
}
