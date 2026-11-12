//! Android call service. Android silences the mic of an app in the background
//! and may freeze its process, unless a foreground service with a visible
//! notification says the app is in use. `CallService.kt` is that service and
//! `CallServicePlugin.kt` starts, updates and stops it; the webview says when
//! a call begins, ends, or turns its camera on or off. The same call says
//! when a camera or a stream is on screen, and the plugin keeps the screen on
//! for as long.

use serde::Serialize;
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct CallServiceHandle(PluginHandle<Wry>);

/// Registers `CallServicePlugin.kt`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-call-service")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "CallServicePlugin")?;
            app.manage(CallServiceHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetCallArgs {
    active: bool,
    camera: bool,
    video_on_screen: bool,
}

/// Start or update the call service while `active`, stop it otherwise.
/// `camera` adds the camera to what the service keeps running, and
/// `video_on_screen` keeps the screen on while a call shows a picture.
/// Async so the wait for the Kotlin side never holds the main thread, which
/// that side may need.
#[tauri::command]
pub async fn set_call_service(
    app: AppHandle,
    active: bool,
    camera: bool,
    video_on_screen: bool,
) -> Result<(), String> {
    let service = app.state::<CallServiceHandle>();
    let args = SetCallArgs {
        active,
        camera,
        video_on_screen,
    };
    service
        .0
        .run_mobile_plugin_async::<serde_json::Value>("setCall", args)
        .await
        .map(|_| ())
        .map_err(|e| format!("call service: {e}"))
}
