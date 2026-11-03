//! Android crash and exit info. `ExitInfoPlugin.kt` writes how earlier runs
//! ended (Android 11+ keeps that per app), uncaught JVM exceptions, the
//! webview's render process going away and the call service's start and stop
//! into the native log, which the support bundle already carries. Rust only
//! hands it the log file's path, which the Kotlin side cannot work out itself.

use std::path::Path;

use serde::Serialize;
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct ExitInfoHandle(PluginHandle<Wry>);

/// Registers `ExitInfoPlugin.kt`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-exit-info")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "ExitInfoPlugin")?;
            app.manage(ExitInfoHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs {
    log_file: String,
}

/// Tell the Kotlin side where the native log is, and let it report the
/// earlier exits. Off the main thread: the Kotlin side may need it.
pub(crate) fn start(app: &AppHandle, log_file: &Path) {
    let app = app.clone();
    let log_file = log_file.to_string_lossy().into_owned();
    tauri::async_runtime::spawn(async move {
        let Some(plugin) = app.try_state::<ExitInfoHandle>() else {
            return;
        };
        if let Err(e) = plugin
            .0
            .run_mobile_plugin_async::<serde_json::Value>("start", StartArgs { log_file })
            .await
        {
            log::warn!("[exit] exit info not started: {e}");
        }
    });
}
