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

/// The origin tauri serves the main window from: the dev server in dev, the
/// custom-protocol host in a release build. Taken from config rather than
/// `window.url()`, which reads `about:blank` until the first navigation commits.
fn app_origin(config: &tauri::Config, https: bool) -> Option<String> {
    let url = if tauri::is_dev() {
        config.build.dev_url.clone()?
    } else {
        let scheme = if https { "https" } else { "http" };
        url::Url::parse(&format!("{scheme}://tauri.localhost")).ok()?
    };
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Allow microphone and camera for the app's own origin in the window's profile.
pub fn allow_media_capture<R: Runtime>(
    window: &WebviewWindow<R>,
    config: &tauri::Config,
    https: bool,
) {
    let Some(origin) = app_origin(config, https) else {
        log::warn!("windows_media: no app origin, device names stay hidden");
        return;
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
