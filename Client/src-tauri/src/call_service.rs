//! Android call service. Android silences the mic of an app in the background
//! and may freeze its process, unless a foreground service with a visible
//! notification says the app is in use. `CallService.kt` is that service and
//! `CallServicePlugin.kt` starts, updates and stops it; the webview says when
//! a call begins, ends, or turns its camera on or off. The same call says
//! when a camera or a stream is on screen, and the plugin keeps the screen on
//! for as long.
//!
//! The service's notification has the call's buttons (Mute or Unmute, Leave),
//! and an incoming call gets a notification of its own with Accept and
//! Decline (`CallRing.kt`), which rings with the phone's ringtone. The words
//! on both come from the webview, and a pressed button goes back to it as the
//! plugin's `action` event: the webview acts, this side only shows.

use serde::{Deserialize, Serialize};
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

/// What the service's notification says and offers, in the webview's words:
/// `mic` is "live", "muted" or "locked" (muted by a moderator, so no button),
/// and a label left out leaves its button out.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallFace {
    mic: String,
    text: String,
    mic_label: Option<String>,
    leave_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetCallArgs {
    active: bool,
    camera: bool,
    video_on_screen: bool,
    mic: String,
    text: String,
    mic_label: Option<String>,
    leave_label: String,
}

/// Start or update the call service while `active`, stop it otherwise.
/// `camera` adds the camera to what the service keeps running,
/// `video_on_screen` keeps the screen on while a call shows a picture, and
/// `face` is what its notification says.
/// Async so the wait for the Kotlin side never holds the main thread, which
/// that side may need.
#[tauri::command]
pub async fn set_call_service(
    app: AppHandle,
    active: bool,
    camera: bool,
    video_on_screen: bool,
    face: CallFace,
) -> Result<(), String> {
    let service = app.state::<CallServiceHandle>();
    let args = SetCallArgs {
        active,
        camera,
        video_on_screen,
        mic: face.mic,
        text: face.text,
        mic_label: face.mic_label,
        leave_label: face.leave_label,
    };
    service
        .0
        .run_mobile_plugin_async::<serde_json::Value>("setCall", args)
        .await
        .map(|_| ())
        .map_err(|e| format!("call service: {e}"))
}

/// An incoming call's notification, in the webview's words. `quiet` shows it
/// without the ringtone, and Android takes it down by itself after
/// `timeout_ms`, so it never outlasts a webview that is gone.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRing {
    channel_id: i64,
    title: String,
    text: String,
    accept_label: String,
    decline_label: String,
    channel_name: String,
    channel_description: String,
    quiet: bool,
    timeout_ms: u32,
}

/// Show the incoming call's notification, or show it again (the same call
/// rang again, so its time starts over). An error when Android would not show
/// it: the webview then rings by itself.
#[tauri::command]
pub async fn show_call_ring(app: AppHandle, ring: CallRing) -> Result<(), String> {
    let service = app.state::<CallServiceHandle>();
    service
        .0
        .run_mobile_plugin_async::<serde_json::Value>("showRing", ring)
        .await
        .map(|_| ())
        .map_err(|e| format!("call ring: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearRingArgs {
    channel_id: i64,
}

/// Take the incoming call's notification down, if the one that is up is for
/// this channel.
#[tauri::command]
pub async fn clear_call_ring(app: AppHandle, channel_id: i64) -> Result<(), String> {
    let service = app.state::<CallServiceHandle>();
    service
        .0
        .run_mobile_plugin_async::<serde_json::Value>("clearRing", ClearRingArgs { channel_id })
        .await
        .map(|_| ())
        .map_err(|e| format!("call ring: {e}"))
}
