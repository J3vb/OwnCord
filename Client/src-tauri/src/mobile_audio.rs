//! Android call audio. The WebView runs a call's sound by itself;
//! `MobileAudioPlugin.kt` adds the route the user picks (speaker, earpiece,
//! headset) and the pause while a phone call holds the audio. The webview says
//! when a call begins and ends and which route was tapped; the routes, the one
//! in use and the pause come back as each command's answer and as the plugin's
//! `state` events. Nothing here is persisted.

use serde::Serialize;
use serde_json::Value;
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct MobileAudioHandle(PluginHandle<Wry>);

/// Registers `MobileAudioPlugin.kt`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-mobile-audio")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "MobileAudioPlugin")?;
            app.manage(MobileAudioHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
struct SessionArgs {
    active: bool,
}

#[derive(Serialize)]
struct RouteArgs {
    kind: String,
}

/// Run a plugin command and hand its audio state through as it came. Async so
/// the wait for the Kotlin side never holds the main thread, which that side
/// works on.
async fn run(app: &AppHandle, command: &str, args: impl Serialize + Send) -> Result<Value, String> {
    app.state::<MobileAudioHandle>()
        .0
        .run_mobile_plugin_async(command, args)
        .await
        .map_err(|error| format!("call audio: {error}"))
}

/// A call began (`active`) or ended.
#[tauri::command]
pub async fn mobile_audio_set_session(app: AppHandle, active: bool) -> Result<Value, String> {
    run(&app, "setSession", SessionArgs { active }).await
}

/// The user picked where the call's sound goes: `speaker`, `earpiece`, `wired`
/// or `bluetooth`.
#[tauri::command]
pub async fn mobile_audio_set_route(app: AppHandle, kind: String) -> Result<Value, String> {
    run(&app, "setRoute", RouteArgs { kind }).await
}

/// The audio state now, for a webview that may have missed an event.
#[tauri::command]
pub async fn mobile_audio_state(app: AppHandle) -> Result<Value, String> {
    run(&app, "getState", ()).await
}
