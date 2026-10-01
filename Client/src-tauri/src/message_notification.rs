//! Message notifications that open their message when clicked.
//!
//! `tauri-plugin-notification`'s desktop backend drops the click/action
//! callback — only its mobile backend emits one — so the popup that tells you a
//! message arrived cannot take you to it. This module takes over that popup.
//!
//! Two mechanisms, by platform:
//!
//! * **Windows** — a WinRT toast with `activationType="protocol"` whose launch
//!   URI is `owncord://message/<channel>/<message>?host=<server>` (or, for a
//!   call notification, `owncord://channel/<channel>?host=<server>`). Clicking it
//!   anywhere, including from Action Center after the banner has timed out,
//!   makes Windows launch the registered `owncord://` handler; the app's
//!   existing deep-link path turns that into the jump. (The `notify-rust`
//!   approach below cannot do this: its `Activated` handler only fires while
//!   the banner is on screen, so a later Action Center click merely raised the
//!   window.)
//! * **macOS / Linux** — `notify-rust` directly (the same crate the plugin's
//!   desktop backend uses), which waits for the activation on a dedicated
//!   thread, then focuses the window and emits `notification-click`.
//!
//! The renderer turns either signal into `jumpToMessage`, and the host in the
//! target keeps a click from another server from opening the wrong message.
//!
//! Only message notifications go through here; the plain `show` path (a
//! notification with no target) stays on the plugin.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

#[cfg(not(windows))]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(not(windows))]
use notify_rust::NotificationResponse;

// Only the notify-rust path emits an event; the Windows protocol activation is
// delivered by the OS through the deep-link plugin instead.
#[cfg(not(windows))]
use tauri::Emitter;

// ponytail: at most 16 notifications wait for a click at once; past that a
// popup is shown without a click action. Reuse one handle per channel if
// dropping the click on a busy day matters. Windows needs none of this — a
// protocol activation is delivered by the OS, not by a thread we hold.
#[cfg(not(windows))]
const MAX_WAITERS: usize = 16;

#[cfg(not(windows))]
static LIVE_WAITERS: AtomicUsize = AtomicUsize::new(0);

/// One live click waiter, counted in its `AtomicUsize` until dropped.
#[cfg(not(windows))]
struct WaiterSlot<'a>(&'a AtomicUsize);

#[cfg(not(windows))]
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

#[cfg(not(windows))]
impl Drop for WaiterSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The message a clicked notification should open, or with no `message_id` the
/// channel itself: a call notification opens its DM.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTarget {
    pub host: String,
    pub channel_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
}

/// Show a notification that opens `channel_id`/`message_id` (or just the
/// channel, when there is no message id) when clicked.
/// Async so showing it never blocks the UI thread on the notification server.
#[tauri::command(async)]
pub fn notify_message<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    host: String,
    channel_id: i64,
    message_id: Option<i64>,
) -> Result<(), String> {
    show_message_notification(
        &app,
        &title,
        &body,
        MessageTarget {
            host,
            channel_id,
            message_id,
        },
    )
}

/// The launch URI a Windows toast carries: the registered `owncord://` handler
/// is launched with it on activation, and the app's deep-link path parses it
/// back (the same `owncord://message/…?host=` and `owncord://channel/…?host=`
/// shapes `lib/deep-link.ts` reads). The host is percent-encoded so a value
/// with `&` or `#` cannot forge extra query parameters or a fragment; the ids
/// are integers, so they need none.
#[cfg_attr(not(windows), allow(dead_code))]
fn message_launch_uri(target: &MessageTarget) -> String {
    let host = url::form_urlencoded::byte_serialize(target.host.as_bytes()).collect::<String>();
    match target.message_id {
        Some(message_id) => format!(
            "owncord://message/{}/{message_id}?host={host}",
            target.channel_id
        ),
        None => format!("owncord://channel/{}?host={host}", target.channel_id),
    }
}

/// The toast's XML: a protocol-activation toast whose title and body are the
/// notification text and whose launch URI opens the message. `<audio
/// silent="true"/>` keeps the OS from adding its own chime — the app plays its
/// own (`lib/notificationSound.ts`), the same as the notify-rust path did.
#[cfg_attr(not(windows), allow(dead_code))]
fn toast_xml(title: &str, body: &str, target: &MessageTarget) -> String {
    format!(
        "<toast activationType=\"protocol\" launch=\"{}\">\
         <visual><binding template=\"ToastGeneric\">\
         <text id=\"1\">{}</text><text id=\"2\">{}</text>\
         </binding></visual><audio silent=\"true\"/></toast>",
        xml_escape(&message_launch_uri(target)),
        xml_escape(title),
        xml_escape(body),
    )
}

/// Escape the five XML metacharacters. `&` first, so an escaped entity is not
/// escaped again.
#[cfg_attr(not(windows), allow(dead_code))]
fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// The AppUserModelID the toast is attributed to. Installed builds use the
/// bundle identifier the installer registered (so the toast and its Action
/// Center entry are OwnCord's); a dev build under `target/` is not registered,
/// so it falls back to PowerShell's ID — the same choice the notification
/// plugin's desktop backend and `notify-rust` make, and the toast still shows.
#[cfg(windows)]
fn toast_app_id<R: Runtime>(app: &AppHandle<R>) -> String {
    let installed = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.display().to_string()))
        .map(|dir| {
            let sep = std::path::MAIN_SEPARATOR;
            !(dir.ends_with(&format!("{sep}target{sep}debug"))
                || dir.ends_with(&format!("{sep}target{sep}release")))
        })
        .unwrap_or(false);
    if installed {
        app.config().identifier.clone()
    } else {
        POWERSHELL_APP_ID.to_string()
    }
}

/// `tauri-winrt-notification`'s (and the plugin's) unregistered-app fallback.
#[cfg(windows)]
const POWERSHELL_APP_ID: &str =
    r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";

/// Windows: show a protocol-activation toast. No waiter thread is needed — the
/// OS launches the registered `owncord://` handler on activation, wherever the
/// click comes from, and the existing deep-link path opens the message.
#[cfg(windows)]
fn show_message_notification<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    target: MessageTarget,
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    log::debug!(
        "[notify] showing protocol-activation toast (channel {}, message {:?})",
        target.channel_id,
        target.message_id
    );

    let document = XmlDocument::new().map_err(|e| format!("create toast xml: {e}"))?;
    document
        .LoadXml(&HSTRING::from(toast_xml(title, body, &target)))
        .map_err(|e| format!("load toast xml: {e}"))?;
    let toast = ToastNotification::CreateToastNotification(&document)
        .map_err(|e| format!("create toast: {e}"))?;

    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(toast_app_id(app)))
            .map_err(|e| format!("create toast notifier: {e}"))?;
    notifier
        .Show(&toast)
        .map_err(|e| format!("show toast: {e}"))?;
    Ok(())
}

/// macOS / Linux: show through `notify-rust` and wait for the activation on a
/// dedicated thread, then focus the window and emit `notification-click`.
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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

    // The notify-rust activation decision and its waiter cap exist only off
    // Windows; Windows activates through the OS protocol handler instead.
    #[cfg(not(windows))]
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

    #[cfg(not(windows))]
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
            host: "chat.example:8443".into(),
            channel_id: 7,
            message_id: Some(42),
        };
        let json = serde_json::to_value(target).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "host": "chat.example:8443", "channelId": 7, "messageId": 42 })
        );
    }

    fn target(host: &str, channel_id: i64, message_id: i64) -> MessageTarget {
        MessageTarget {
            host: host.into(),
            channel_id,
            message_id: Some(message_id),
        }
    }

    #[test]
    fn the_launch_uri_names_the_message_and_the_server_it_came_from() {
        // The Windows toast's `launch` attribute. The deep-link path parses it
        // back with the same shape `owncord://message/<channel>/<message>?host=`
        // links use (Client/src/lib/deep-link.ts).
        assert_eq!(
            message_launch_uri(&target("chat.example:8443", 7, 42)),
            "owncord://message/7/42?host=chat.example%3A8443"
        );
    }

    #[test]
    fn a_call_target_launch_uri_names_the_dm_and_the_server_it_came_from() {
        // A call notification has no message: it opens the DM. The deep-link
        // path parses `owncord://channel/<channel>?host=` back with the same
        // id and host validation as a message link (Client/src/lib/deep-link.ts).
        let call = MessageTarget {
            host: "chat.example:8443".into(),
            channel_id: 7,
            message_id: None,
        };
        assert_eq!(
            message_launch_uri(&call),
            "owncord://channel/7?host=chat.example%3A8443"
        );
        let forged = MessageTarget {
            host: "evil.example&x=1#y".into(),
            channel_id: 1,
            message_id: None,
        };
        assert_eq!(
            message_launch_uri(&forged),
            "owncord://channel/1?host=evil.example%26x%3D1%23y"
        );
    }

    #[test]
    fn a_call_target_toast_escapes_its_text_and_launch_attribute() {
        let call = MessageTarget {
            host: "a&b".into(),
            channel_id: 1,
            message_id: None,
        };
        let xml = toast_xml("<Al> is calling you", "Voice \"call\"", &call);
        assert!(
            xml.contains("launch=\"owncord://channel/1?host=a%26b\""),
            "{xml}"
        );
        assert!(
            xml.contains("<text id=\"1\">&lt;Al&gt; is calling you</text>"),
            "{xml}"
        );
        assert!(
            xml.contains("<text id=\"2\">Voice &quot;call&quot;</text>"),
            "{xml}"
        );
    }

    #[test]
    fn a_call_target_serializes_without_a_message_id() {
        let call = MessageTarget {
            host: "h".into(),
            channel_id: 7,
            message_id: None,
        };
        assert_eq!(
            serde_json::to_value(call).expect("serialize"),
            serde_json::json!({ "host": "h", "channelId": 7 })
        );
    }

    #[test]
    fn the_launch_uri_percent_encodes_a_host_that_could_break_the_query() {
        // A host is user-supplied, so `&`, `#` and friends must be encoded:
        // otherwise `host=evil&x=1#frag` would forge a second query parameter
        // and a fragment, and the parser would not read the host back whole.
        assert_eq!(
            message_launch_uri(&target("evil.example&x=1#y", 1, 2)),
            "owncord://message/1/2?host=evil.example%26x%3D1%23y"
        );
    }

    #[test]
    fn toast_xml_escapes_the_text_and_the_launch_attribute() {
        let xml = toast_xml("A <B>", "c\"d", &target("a&b", 1, 2));
        assert!(xml.contains("activationType=\"protocol\""), "{xml}");
        // The host is percent-encoded first, so `&` is `%26` here — the XML
        // escape must not double-encode it.
        assert!(
            xml.contains("launch=\"owncord://message/1/2?host=a%26b\""),
            "{xml}"
        );
        assert!(xml.contains("<text id=\"1\">A &lt;B&gt;</text>"), "{xml}");
        assert!(xml.contains("<text id=\"2\">c&quot;d</text>"), "{xml}");
        // The app plays its own chime; the toast must not add the OS one.
        assert!(xml.contains("<audio silent=\"true\"/>"), "{xml}");
    }
}
