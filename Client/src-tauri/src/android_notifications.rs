//! Android message and missed-call notifications, over
//! tauri-plugin-notification's mobile side. The desktop host shows its own
//! (`message_notification.rs`), which is not built here. A call that rings
//! has a notification of its own, with buttons (`call_service.rs`).
//!
//! The plugin reports that a notification was tapped but not which one, so
//! `NotificationTapPlugin.kt` keeps the id from the tap intent and
//! `take_notification_tap` hands it to the webview, which knows what that
//! notification was for.
//!
//! Every command is async: the plugin's calls wait on the Kotlin side, which
//! runs on the main thread, and a permission request waits on the user.

use serde::Deserialize;
use tauri::plugin::{Builder, PermissionState, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::{Channel, Importance, NotificationExt, Visibility};

/// Messages, mentions and missed calls: a banner over the app and a sound.
const MESSAGES_CHANNEL: &str = "messages";

struct NotificationTapHandle(PluginHandle<Wry>);

/// Registers `NotificationTapPlugin.kt`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-notification-tap")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle =
                api.register_android_plugin("com.owncord.client", "NotificationTapPlugin")?;
            app.manage(NotificationTapHandle(handle));
            Ok(())
        })
        .build()
}

/// The channel's name as Android lists it in the app's notification
/// settings, in the webview's language.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelNames {
    messages: String,
    messages_description: String,
}

/// Create the channel. Android keeps a channel's importance and sound from
/// its first creation, so a later call only renames it and never undoes what
/// the user changed.
#[tauri::command]
pub async fn android_notification_channels(
    app: AppHandle,
    names: ChannelNames,
) -> Result<(), String> {
    let channel = Channel::builder(MESSAGES_CHANNEL, names.messages)
        .description(names.messages_description)
        .importance(Importance::High)
        .visibility(Visibility::Private)
        .vibration(true)
        .build();
    app.notification()
        .create_channel(channel)
        .map_err(|e| format!("notification channel {MESSAGES_CHANNEL}: {e}"))
}

/// Show one notification; `group` stacks a server's notifications together.
/// The webview picks `id`, so it can withdraw the notification and recognise
/// its tap.
#[tauri::command]
pub async fn android_notify(
    app: AppHandle,
    id: i32,
    title: String,
    body: String,
    group: Option<String>,
) -> Result<(), String> {
    let mut builder = app
        .notification()
        .builder()
        .id(id)
        .channel_id(MESSAGES_CHANNEL)
        .title(title)
        .body(body)
        .auto_cancel();
    if let Some(group) = group {
        builder = builder.group(group);
    }
    builder.show().map_err(|e| format!("notification: {e}"))
}

/// Remove the notifications with these ids from the shade.
#[tauri::command]
pub async fn android_clear_notifications(app: AppHandle, ids: Vec<i32>) -> Result<(), String> {
    app.notification()
        .remove_active(ids)
        .map_err(|e| format!("notification removal: {e}"))
}

fn permission_word(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "prompt",
    }
}

/// The notification permission as Android has it now: "granted", "denied" or
/// "prompt" (not asked yet). With `ask`, a permission not held is asked for
/// first; one already held is never asked again, a request the plugin would
/// leave unanswered.
#[tauri::command]
pub async fn android_notification_permission(app: AppHandle, ask: bool) -> Result<String, String> {
    let notification = app.notification();
    let state = notification
        .permission_state()
        .map_err(|e| format!("notification permission: {e}"))?;
    if !ask || state == PermissionState::Granted {
        return Ok(permission_word(state).to_owned());
    }
    // The request waits for the user's answer: off the async runtime's
    // workers, so the dialog never holds one.
    let answer = tauri::async_runtime::spawn_blocking(move || {
        app.notification()
            .request_permission()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("notification permission request: {e}"))?
    .map_err(|e| format!("notification permission request: {e}"))?;
    Ok(permission_word(answer).to_owned())
}

#[derive(Deserialize)]
struct Tap {
    #[serde(default)]
    id: Option<i32>,
}

/// The id of the oldest notification tap not taken yet, once; `None` when
/// there is none.
#[tauri::command]
pub async fn take_notification_tap(app: AppHandle) -> Result<Option<i32>, String> {
    let plugin = app.state::<NotificationTapHandle>();
    plugin
        .0
        .run_mobile_plugin_async::<Tap>("takeTap", ())
        .await
        .map(|tap| tap.id)
        .map_err(|e| format!("notification tap: {e}"))
}
