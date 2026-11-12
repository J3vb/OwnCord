//! The Android app's idle time, for the client's auto-idle.
//!
//! A phone has no keyboard or mouse to watch, so the idle time here is how
//! long the app has been out of view (in the background, or the screen off),
//! and 0 while it shows: someone looking at the app is here. `IdlePlugin.kt`
//! keeps that clock.
//!
//! The page polls it like any other idle time, but a phone that sleeps runs no
//! timer of the page. So the plugin also sends the page a `look` event when
//! the answer is worth reading at once: as the app comes back into view, and
//! each time it has been out of view for the delay `system_idle_follow` was
//! given, by an alarm that wakes the phone.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct IdleHandle(PluginHandle<Wry>);

/// Registers `IdlePlugin.kt`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-idle")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "IdlePlugin")?;
            app.manage(IdleHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize)]
struct Away {
    ms: u64,
}

/// Milliseconds the app has been out of view, 0 while it shows; `None` when
/// the plugin cannot say, and the frontend then falls back to in-window
/// activity. The Android app's answer to the desktop's `idle::system_idle_ms`.
/// Async so the wait for the Kotlin side never holds the main thread, which
/// that side runs on.
#[tauri::command]
pub async fn system_idle_ms(app: AppHandle) -> Option<u64> {
    app.state::<IdleHandle>()
        .0
        .run_mobile_plugin_async::<Away>("awayMs", ())
        .await
        .ok()
        .map(|away| away.ms)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowArgs {
    threshold_ms: u64,
}

/// Have the plugin send `look` each time the app has been out of view for
/// `threshold_ms`; 0 ends that. The `look` for coming back into view is sent
/// either way.
#[tauri::command]
pub async fn system_idle_follow(app: AppHandle, threshold_ms: u64) -> Result<(), String> {
    app.state::<IdleHandle>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>("follow", FollowArgs { threshold_ms })
        .await
        .map(|_| ())
        .map_err(|e| format!("idle follow: {e}"))
}
