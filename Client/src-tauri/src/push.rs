//! Push for a closed Android app through UnifiedPush (`PushPlugin.kt`): the
//! user's push app (ntfy or another distributor) holds the connection, and no
//! Google service is involved. The page registers each server it signs in to
//! (the instance is the server's host), sends the endpoint and keys it gets
//! back to that server, and unregisters on sign-out. A push is shown by
//! `OwnCordPushService.kt`, with no page running.
//!
//! Every command is async: the Kotlin side runs on the main thread, and a
//! registration waits for the push app's answer.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct PushHandle(PluginHandle<Wry>);

/// Registers `PushPlugin.kt`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-push")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "PushPlugin")?;
            app.manage(PushHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize, Serialize)]
pub struct Distributor {
    id: String,
    name: String,
}

/// The push apps installed, and the one the app uses (`None` until one is
/// chosen or the only one is taken).
#[derive(Deserialize, Serialize)]
pub struct PushStatus {
    distributors: Vec<Distributor>,
    current: Option<String>,
}

/// What a server needs to push to this phone.
#[derive(Deserialize, Serialize)]
pub struct PushEndpoint {
    endpoint: String,
    p256dh: String,
    auth: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterArgs {
    instance: String,
    vapid: String,
    server_name: String,
    title: String,
    body: String,
}

#[derive(Serialize)]
struct InstanceArgs {
    instance: String,
}

#[derive(Serialize)]
struct ChooseArgs {
    distributor: String,
}

async fn run<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    command: &str,
    args: impl Serialize,
) -> Result<T, String> {
    app.state::<PushHandle>()
        .0
        .run_mobile_plugin_async(command, args)
        .await
        .map_err(|e| format!("push {command}: {e}"))
}

#[tauri::command]
pub async fn push_status(app: AppHandle) -> Result<PushStatus, String> {
    run(&app, "status", ()).await
}

#[tauri::command]
pub async fn push_choose(app: AppHandle, distributor: String) -> Result<(), String> {
    run::<serde_json::Value>(&app, "choose", ChooseArgs { distributor })
        .await
        .map(|_| ())
}

/// Register `instance` with the push app; `title` and `body` are the text of
/// its "new messages" notification, in the page's language.
#[tauri::command]
pub async fn push_register(
    app: AppHandle,
    instance: String,
    vapid: String,
    server_name: String,
    title: String,
    body: String,
) -> Result<PushEndpoint, String> {
    let args = RegisterArgs {
        instance,
        vapid,
        server_name,
        title,
        body,
    };
    run(&app, "register", args).await
}

#[tauri::command]
pub async fn push_unregister(app: AppHandle, instance: String) -> Result<(), String> {
    run::<serde_json::Value>(&app, "unregister", InstanceArgs { instance })
        .await
        .map(|_| ())
}
