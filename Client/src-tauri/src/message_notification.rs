//! Message notifications that open their message when clicked.
//!
//! `tauri-plugin-notification`'s desktop backend drops the click/action
//! callback — only its mobile backend emits one — so the popup that tells you a
//! message arrived cannot take you to it. This module shows the notification
//! through `notify-rust` directly (the same crate the plugin's desktop backend
//! uses), waits for the activation on a dedicated thread, then focuses the
//! window and emits `notification-click` with the message it was for. The
//! renderer turns that into `jumpToMessage`.
//!
//! Only message notifications go through here; the plain `show` path (a
//! notification with no target) stays on the plugin.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The message a clicked notification should open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTarget {
    pub channel_id: i64,
    pub message_id: i64,
}

/// Show a notification that opens `channel_id`/`message_id` when clicked.
#[tauri::command]
pub fn notify_message<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    channel_id: i64,
    message_id: i64,
) -> Result<(), String> {
    show_message_notification(
        &app,
        &title,
        &body,
        MessageTarget {
            channel_id,
            message_id,
        },
    )
}

/// Show `title`/`body` and, on activation, focus the window and emit
/// `notification-click` carrying `target`.
fn show_message_notification<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    target: MessageTarget,
) -> Result<(), String> {
    // `notify-rust`'s macOS backend needs the bundle identifier set before a
    // notification can be attributed (and its click observed); mirror what the
    // plugin's desktop backend does so a clicked popup is ours.
    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &app.config().identifier
        });
    }

    // The `"default"` action is what a click on the notification body fires;
    // declaring it keeps the signal available on every desktop.
    let handle = notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .action("default", "Open")
        .show()
        .map_err(|e| format!("failed to show notification: {e}"))?;

    // One waiter thread per shown notification: `wait_for_action` blocks until
    // the user clicks or dismisses it. A channel's notifications are coalesced
    // upstream (U1c), so a burst does not stack waiters.
    let app = app.clone();
    std::thread::spawn(move || {
        handle.wait_for_action(move |action| {
            if !is_activation(action) {
                return;
            }
            focus_main_window(&app);
            let _ = app.emit("notification-click", target);
        });
    });

    Ok(())
}

/// Whether a `notify-rust` action string means the user clicked the
/// notification. `"default"` is the body click; `"__closed"` (the crate's own
/// keyword) is a dismissal, and a named action is not this command's.
fn is_activation(action: &str) -> bool {
    action == "default"
}

/// Bring the main window to the front, un-minimizing first so a hidden window
/// actually comes forward.
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_body_click_is_an_activation() {
        assert!(is_activation("default"));
        // A dismissal is the crate's `__closed` keyword, and any other action
        // string is not this command's.
        assert!(!is_activation("__closed"));
        assert!(!is_activation("open"));
        assert!(!is_activation(""));
    }

    #[test]
    fn a_target_serializes_camel_case_for_the_renderer() {
        let target = MessageTarget {
            channel_id: 7,
            message_id: 42,
        };
        let json = serde_json::to_value(target).expect("serialize");
        assert_eq!(json, serde_json::json!({ "channelId": 7, "messageId": 42 }));
    }
}
