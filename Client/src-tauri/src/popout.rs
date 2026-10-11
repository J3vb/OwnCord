//! Stream pop-out windows (Discord-style). The client opens one with
//! `window.open("about:blank#owncord-popout-<n>")` and moves the tile's own
//! `<video>` into it (`src/features/voice/popout.ts`), so the window
//! must share the main webview's process: `window_features` carries the
//! opener's WebView2 environment / WebKitGTK related view.
//!
//! Capability and CSP decision: no capability names these windows, on purpose.
//! A window needs none to exist; capabilities only grant IPC, and a pop-out
//! gets none (the main window drives its full screen through its own
//! `core:window:allow-set-fullscreen`, by label). The about:blank popup
//! inherits the opener's CSP (HTML policy-container inheritance).
//!
//! Every other `window.open` is denied, as it was before this handler existed
//! (wry denies new windows when a webview has no handler).

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL_PREFIX: &str = "owncord-popout-";

/// The window label a pop-out request names, or `None` for any other URL.
pub fn popout_label(url: &Url) -> Option<&str> {
    if url.scheme() != "about" || url.path() != "blank" || url.query().is_some() {
        return None;
    }
    let label = url.fragment()?;
    let tile = label.strip_prefix(LABEL_PREFIX)?;
    let digits = !tile.is_empty() && tile.len() <= 10 && tile.bytes().all(|b| b.is_ascii_digit());
    digits.then_some(label)
}

/// Whether a window label names a pop-out window.
pub fn is_popout_window(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Close every open pop-out. The main window's page cannot be relied on to do
/// it (no `pagehide` runs when the window is destroyed), and a pop-out left
/// open keeps the process alive.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if is_popout_window(&label) {
            let _ = window.destroy();
        }
    }
}

/// The main webview's `on_new_window` handler.
pub fn on_new_window<R: Runtime>(
    app: &AppHandle<R>,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<R> {
    let Some(label) = popout_label(&url) else {
        log::warn!("[popout] denied a window.open ({} URL)", url.scheme());
        return NewWindowResponse::Deny;
    };
    let Ok(blank) = Url::parse("about:blank") else {
        return NewWindowResponse::Deny;
    };
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .title("OwnCord")
        .inner_size(960.0, 540.0)
        .min_inner_size(320.0, 180.0)
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .build();
    match built {
        Ok(window) => {
            #[cfg(any(target_os = "linux", windows))]
            close_with_page(&window);
            NewWindowResponse::Create { window }
        }
        Err(e) => {
            log::warn!("[popout] could not open {label}: {e}");
            NewWindowResponse::Deny
        }
    }
}

/// WebKitGTK answers the page's `window.close()` (the client's "Bring back")
/// by destroying only the webview (wry's `close` handler, which runs before
/// any of ours), which would leave an empty window: close the window when its
/// webview goes. When the window closes first this is a no-op.
#[cfg(target_os = "linux")]
fn close_with_page<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let owner = window.clone();
    let result = window.with_webview(move |webview| {
        use webkit2gtk::glib::prelude::ObjectExt;
        webview.inner().connect_local("destroy", false, move |_| {
            let _ = owner.close();
            None
        });
    });
    if let Err(e) = result {
        log::warn!("[popout] window.close() will leave the window open: {e}");
    }
}

/// WebView2 answers the page's `window.close()` (Bring back, or the stream
/// ending) the same way: wry destroys only the webview's child container, so
/// the window stayed open, empty, on screen. Close the window along with it.
#[cfg(windows)]
fn close_with_page<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let owner = window.clone();
    let result = window.with_webview(move |webview| {
        let handler =
            webview2_com::WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                let _ = owner.close();
                Ok(())
            }));
        let mut token = Default::default();
        // SAFETY: COM calls on the live controller, on the webview's own thread.
        let added = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.add_WindowCloseRequested(&handler, &mut token))
        };
        if let Err(e) = added {
            log::warn!("[popout] window.close() will leave the window open: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("[popout] window.close() will leave the window open: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{is_popout_window, popout_label};
    use tauri::Url;

    fn label(url: &str) -> Option<String> {
        popout_label(&Url::parse(url).unwrap()).map(str::to_owned)
    }

    #[test]
    fn recognises_popout_windows_by_label() {
        assert!(is_popout_window("owncord-popout-1000002"));
        assert!(!is_popout_window("main"));
        assert!(!is_popout_window("owncord-popout"));
    }

    #[test]
    fn names_the_window_for_a_popout_url_only() {
        assert_eq!(
            label("about:blank#owncord-popout-1000002").as_deref(),
            Some("owncord-popout-1000002")
        );
        // Anything else stays denied, as every window.open was before.
        for url in [
            "about:blank",
            "about:blank#owncord-popout-",
            "about:blank#owncord-popout-1x",
            "about:blank#owncord-popout-12345678901",
            "about:blank?a=1#owncord-popout-1",
            "about:srcdoc#owncord-popout-1",
            "https://example.com/#owncord-popout-1",
            "tauri://localhost/#owncord-popout-1",
        ] {
            assert_eq!(label(url), None, "{url}");
        }
    }
}
