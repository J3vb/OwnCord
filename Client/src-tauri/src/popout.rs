//! Stream pop-out windows (Discord-style). The client opens one with
//! `window.open("about:blank#owncord-popout-<tile>")` and moves the tile's own
//! `<video>` into it (`src/components/video-grid/popout.ts`), so the window
//! must share the main webview's process: `window_features` carries the
//! opener's WebView2 environment / WebKitGTK related view. No capability names
//! these windows, so they have no IPC.
//!
//! Every other `window.open` is denied, as it was before this handler existed
//! (wry denies new windows when a webview has no handler).

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

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
            #[cfg(target_os = "linux")]
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

#[cfg(test)]
mod tests {
    use super::popout_label;
    use tauri::Url;

    fn label(url: &str) -> Option<String> {
        popout_label(&Url::parse(url).unwrap()).map(str::to_owned)
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
