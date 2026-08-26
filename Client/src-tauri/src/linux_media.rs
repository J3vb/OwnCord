//! Linux-only WebKitGTK media capture support.
//!
//! On Windows and macOS the webview grants media capture itself (wry's
//! WKWebView delegate auto-grants; WebView2 prompts). WebKitGTK does
//! neither: `enable-media-stream` and `enable-webrtc` default to off, and
//! any `permission-request` signal without a handler is denied. The result
//! is that `navigator.mediaDevices.getUserMedia` fails and
//! `enumerateDevices` returns nothing — no microphones or cameras are ever
//! detected on Linux without this hook.
//!
//! Only media-related permission requests are granted here; everything else
//! (geolocation, web notifications, …) falls through to WebKit's default
//! deny so this hook does not widen the webview's surface beyond capture.

use tauri::{AppHandle, Manager};

/// Enable media streams / WebRTC on the main window's WebKitGTK webview and
/// auto-grant its microphone/camera permission requests.
pub fn enable_media_capture(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("linux_media: main window not found; media capture stays unavailable");
        return;
    };
    let result = window.with_webview(|webview| {
        use webkit2gtk::glib::prelude::Cast;
        use webkit2gtk::{
            DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt,
            UserMediaPermissionRequest, WebViewExt,
        };

        let webview = webview.inner();
        if let Some(settings) = webview.settings() {
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
        } else {
            log::error!("linux_media: webview has no settings object");
        }
        webview.connect_permission_request(|_, request| {
            // UserMediaPermissionRequest covers getUserMedia (mic/camera);
            // DeviceInfoPermissionRequest covers enumerateDevices labels.
            let is_media = request
                .downcast_ref::<UserMediaPermissionRequest>()
                .is_some()
                || request
                    .downcast_ref::<DeviceInfoPermissionRequest>()
                    .is_some();
            if is_media {
                request.allow();
                return true;
            }
            // Unhandled — WebKit applies its default (deny).
            false
        });
    });
    if let Err(e) = result {
        log::error!("linux_media: failed to configure webview media capture: {e}");
    }
}
