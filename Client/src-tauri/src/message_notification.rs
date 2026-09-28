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

use std::sync::atomic::{AtomicUsize, Ordering};

use notify_rust::NotificationResponse;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// ponytail: at most 16 notifications wait for a click at once; past that a
// popup is shown without a click action. Reuse one handle per channel if
// dropping the click on a busy day matters.
const MAX_WAITERS: usize = 16;

static LIVE_WAITERS: AtomicUsize = AtomicUsize::new(0);

/// One live click waiter, counted in its `AtomicUsize` until dropped.
struct WaiterSlot<'a>(&'a AtomicUsize);

impl<'a> WaiterSlot<'a> {
    /// Take a slot, or `None` when `MAX_WAITERS` are already live.
    fn reserve(live: &'a AtomicUsize) -> Option<Self> {
        live.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < MAX_WAITERS).then_some(n + 1)
        })
        .ok()
        .map(|_| Self(live))
    }
}

impl Drop for WaiterSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The message a clicked notification should open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTarget {
    pub channel_id: i64,
    pub message_id: i64,
}

/// Show a notification that opens `channel_id`/`message_id` when clicked.
/// Async so showing it never blocks the UI thread on the notification server.
#[tauri::command(async)]
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

    let slot = WaiterSlot::reserve(&LIVE_WAITERS);

    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();
    // The `"default"` action is what a click on the notification body fires;
    // declaring it keeps the signal available on every desktop. Without a
    // waiter slot nothing would observe the click, so none is offered.
    if slot.is_some() {
        notification.action("default", "Open");
    }
    // Attribute the toast to OwnCord, not PowerShell, when running installed
    // (the same check the plugin's desktop backend makes).
    #[cfg(windows)]
    {
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let exe_dir = exe
            .parent()
            .map(|d| d.display().to_string())
            .unwrap_or_default();
        let sep = std::path::MAIN_SEPARATOR;
        if !(exe_dir.ends_with(&format!("{sep}target{sep}debug"))
            || exe_dir.ends_with(&format!("{sep}target{sep}release")))
        {
            notification.app_id(&app.config().identifier);
        }
    }
    let handle = notification
        .show()
        .map_err(|e| format!("failed to show notification: {e}"))?;

    // A waiter thread blocks in `wait_for_response` until the notification is
    // clicked or closed; a notification parked in a tray or notification
    // centre keeps it alive, hence the `MAX_WAITERS` cap.
    let Some(slot) = slot else {
        return Ok(());
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let _slot = slot;
        let _ = handle.wait_for_response(|response: &NotificationResponse| {
            if !is_activation(response) {
                return;
            }
            focus_main_window(&app);
            let _ = app.emit("notification-click", target);
        });
    });

    Ok(())
}

/// Whether a `notify-rust` response means the user clicked the notification:
/// `Default` is a body click on every desktop, and `Action("default")` is the
/// declared "Open" button where the platform shows it as one. A dismissal or
/// any other action is not this command's.
fn is_activation(response: &NotificationResponse) -> bool {
    match response {
        NotificationResponse::Default => true,
        NotificationResponse::Action(key) => key == "default",
        _ => false,
    }
}

/// Bring the main window to the front, un-minimizing first so a hidden window
/// actually comes forward.
pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
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
    fn a_body_click_or_the_open_button_is_an_activation() {
        assert!(is_activation(&NotificationResponse::Default));
        assert!(is_activation(&NotificationResponse::Action(
            "default".into()
        )));
        assert!(!is_activation(&NotificationResponse::Action("open".into())));
        assert!(!is_activation(&NotificationResponse::Reply("hi".into())));
        assert!(!is_activation(&NotificationResponse::Closed(
            notify_rust::CloseReason::Dismissed
        )));
    }

    #[test]
    fn waiter_slots_stop_at_the_cap_and_free_on_drop() {
        let live = AtomicUsize::new(0);
        let mut slots: Vec<_> = (0..MAX_WAITERS)
            .map(|_| WaiterSlot::reserve(&live).expect("under the cap"))
            .collect();
        assert_eq!(live.load(Ordering::Acquire), MAX_WAITERS);
        assert!(WaiterSlot::reserve(&live).is_none());
        assert_eq!(live.load(Ordering::Acquire), MAX_WAITERS);

        drop(slots.pop());
        assert_eq!(live.load(Ordering::Acquire), MAX_WAITERS - 1);
        let again = WaiterSlot::reserve(&live);
        assert!(again.is_some());
        assert_eq!(live.load(Ordering::Acquire), MAX_WAITERS);
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
