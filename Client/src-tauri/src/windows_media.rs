//! WebView2 media permissions.
//!
//! The window used to pass `--use-fake-ui-for-media-stream` so mic and camera
//! needed no prompt, but that flag also makes `getDisplayMedia` skip the
//! screen/window picker and share the primary screen. Without it WebView2
//! asks for every permission, so this handler answers only the two the app
//! needs silently; everything else, display capture included, keeps the
//! default (the picker for screen share, a prompt for the rest).

/// What a WebView2 permission request asks for, as far as the decision cares.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Microphone,
    Camera,
    Other,
}

/// True when the request is mic/camera from the app's own origin, the only
/// case that is allowed without asking.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn auto_allow(kind: Kind, uri: &str) -> bool {
    matches!(kind, Kind::Microphone | Kind::Camera) && is_app_origin(uri)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_app_origin(uri: &str) -> bool {
    let Ok(url) = url::Url::parse(uri) else {
        return false;
    };
    let host_ok = url.host_str() == Some("tauri.localhost");
    #[cfg(debug_assertions)]
    let host_ok = host_ok || (url.host_str() == Some("localhost") && url.port() == Some(1420));
    matches!(url.scheme(), "http" | "https") && host_ok
}

#[cfg(windows)]
pub fn enable_media_permissions(app: &tauri::AppHandle) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};

    let Some(window) = app.get_webview_window("main") else {
        log::error!("windows_media: main window not found; mic/camera will prompt");
        return;
    };
    let result = window.with_webview(|webview| {
        let mut token = Default::default();
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            let mut uri = Default::default();
            // SAFETY: `args` is the live event args of this callback.
            unsafe {
                args.PermissionKind(&mut kind)?;
                args.Uri(&mut uri)?;
            }
            let kind = match kind {
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => Kind::Microphone,
                COREWEBVIEW2_PERMISSION_KIND_CAMERA => Kind::Camera,
                _ => Kind::Other,
            };
            if auto_allow(kind, &take_pwstr(uri)) {
                // SAFETY: as above.
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
            }
            Ok(())
        }));
        // SAFETY: runs on the webview's UI thread, per `with_webview`.
        let added = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.add_PermissionRequested(&handler, &mut token))
        };
        if let Err(e) = added {
            log::error!("windows_media: could not register permission handler: {e}");
        }
    });
    if let Err(e) = result {
        log::error!("windows_media: failed to configure webview permissions: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_mic_and_camera_from_the_app_origin() {
        assert!(auto_allow(Kind::Microphone, "http://tauri.localhost/"));
        assert!(auto_allow(
            Kind::Camera,
            "https://tauri.localhost/index.html"
        ));
    }

    #[test]
    fn leaves_everything_else_to_the_default() {
        assert!(!auto_allow(Kind::Other, "http://tauri.localhost/"));
    }

    #[test]
    fn refuses_foreign_and_malformed_origins() {
        assert!(!auto_allow(Kind::Microphone, "https://evil.example.com/"));
        assert!(!auto_allow(
            Kind::Camera,
            "http://tauri.localhost.evil.example.com/"
        ));
        assert!(!auto_allow(
            Kind::Camera,
            "http://evil.example.com/tauri.localhost"
        ));
        assert!(!auto_allow(Kind::Microphone, "ftp://tauri.localhost/"));
        assert!(!auto_allow(Kind::Microphone, "not a url"));
        assert!(!auto_allow(Kind::Microphone, ""));
    }
}
