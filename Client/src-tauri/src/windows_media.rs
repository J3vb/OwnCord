//! Windows-only WebView2 media permission.
//!
//! `--auto-accept-camera-and-microphone-capture` (tauri.conf.json) lets
//! getUserMedia through without a prompt but records no permission, so
//! WebView2 treats the app as never granted: `enumerateDevices` hides every
//! device id and name, and `setSinkId` cannot find a saved speaker. Recording
//! microphone and camera as allowed for the app's own origin in the profile
//! restores both. Screen capture is a separate permission and keeps its picker.

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::SetPermissionStateCompletedHandler;
use windows_core::{Interface, HSTRING};

/// Allow microphone and camera for the window's own origin in its profile.
pub fn allow_media_capture<R: Runtime>(window: &WebviewWindow<R>) {
    let origin = match window.url() {
        Ok(url) => url.origin().ascii_serialization(),
        Err(e) => {
            log::warn!("windows_media: no window URL, device names stay hidden: {e}");
            return;
        }
    };
    let result = window.with_webview(move |webview| {
        // SAFETY: COM calls on the live controller, on the webview's own thread.
        let set = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_13>())
                .and_then(|core| core.Profile())
                .and_then(|profile| profile.cast::<ICoreWebView2Profile4>())
                .and_then(|profile| {
                    for kind in [
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                    ] {
                        let done = SetPermissionStateCompletedHandler::create(Box::new(|hr| {
                            if let Err(e) = hr {
                                log::warn!("windows_media: permission not saved: {e}");
                            }
                            Ok(())
                        }));
                        profile.SetPermissionState(
                            kind,
                            &HSTRING::from(origin.as_str()),
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                            &done,
                        )?;
                    }
                    Ok(())
                })
        };
        if let Err(e) = set {
            log::warn!("windows_media: device names stay hidden: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("windows_media: device names stay hidden: {e}");
    }
}
