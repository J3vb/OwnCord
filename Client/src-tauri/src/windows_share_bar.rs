//! Windows-only: hide WebView2's "<origin> is sharing your screen" bar.
//!
//! WebView2 floats its own Stop sharing / Hide bar over the desktop for every
//! getDisplayMedia capture and offers hosts no switch to turn it off: the
//! ScreenCaptureStarting event can only allow or cancel the capture, and
//! `--use-fake-ui-for-media-stream` (which skips it) breaks screen-share audio
//! (see `src/lib/voice/screenShare.ts`). The app's own stream card already has Stop,
//! so once a capture starts this finds that bar and hides its window, much as
//! the bar's own Hide link does. Viewers never saw it (WebView2 keeps it out
//! of the capture). If the bar is not found, it stays on screen as before and
//! the windows that were looked at are logged.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_27;
use webview2_com::ScreenCaptureStartingEventHandler;
use windows_core::Interface;
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, ShowWindowAsync, SW_HIDE,
};

/// How long to look for the bar after a capture starts: the picker is still
/// open in between, and the bar only appears once the user picks a source.
const WATCH_FOR: Duration = Duration::from_secs(120);
const POLL_EVERY: Duration = Duration::from_millis(150);
/// The bar is one short row; anything taller (the picker) is never it.
/// Physical pixels, so this leaves room for 300% scaling.
const MAX_BAR_HEIGHT: i32 = 240;

/// Whether a top-level window of the WebView2 browser process is the bar.
/// `host` is the origin without its scheme: the bar reads
/// "http://tauri.localhost is sharing…" but drops an `https://`. Some
/// languages put words before the origin, so match it anywhere, but never a
/// DevTools window ("DevTools - http://tauri.localhost/…").
fn is_share_bar(title: &str, height: i32, host: &str) -> bool {
    !host.is_empty()
        && height > 0
        && height <= MAX_BAR_HEIGHT
        && title.contains(host)
        && !title.starts_with("DevTools")
}

/// `http://tauri.localhost` -> `tauri.localhost` (port kept in dev).
fn origin_host(origin: &str) -> &str {
    origin.split_once("://").map_or(origin, |(_, host)| host)
}

struct Search<'a> {
    pid: u32,
    host: &'a str,
    hidden: bool,
    seen: Vec<String>,
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
    // SAFETY: lparam is the &mut Search that hide_share_bar passes for the
    // duration of its EnumWindows call.
    let search = unsafe { &mut *(lparam as *mut Search) };
    let mut pid = 0u32;
    // SAFETY: plain Win32 queries on a window handle EnumWindows just gave us.
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
        // A minimised window reports a bar-sized rect; never touch one.
        if pid != search.pid || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return 1;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        let height = rect.bottom - rect.top;
        if is_share_bar(&title, height, search.host) {
            // Async: a busy browser process must not stall this thread.
            ShowWindowAsync(hwnd, SW_HIDE);
            log::info!("windows_share_bar: hid {title:?} ({height}px)");
            search.hidden = true;
        } else {
            search.seen.push(format!("{title:?} ({height}px)"));
        }
    }
    1
}

/// Hide any visible share bar the browser process `pid` shows for `host`.
/// Returns the other visible windows of that process when none was hidden.
fn hide_share_bar(pid: u32, host: &str) -> Result<(), Vec<String>> {
    let mut search = Search {
        pid,
        host,
        hidden: false,
        seen: Vec::new(),
    };
    // SAFETY: `visit` only uses `search` through lparam while EnumWindows runs.
    unsafe {
        EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
    }
    if search.hidden {
        Ok(())
    } else {
        Err(search.seen)
    }
}

/// Watch the window's captures and hide the bar each one brings up.
pub fn hide_on_capture<R: Runtime>(window: &WebviewWindow<R>, origin: Option<String>) {
    let Some(origin) = origin else {
        log::warn!("windows_share_bar: no app origin, the sharing bar stays");
        return;
    };
    let host = origin_host(&origin).to_owned();
    // A newer capture supersedes an older one's watch.
    let latest = Arc::new(AtomicU64::new(0));
    let result = window.with_webview(move |webview| {
        // SAFETY: COM calls on the live controller, on the webview's own thread.
        let added = unsafe {
            webview.controller().CoreWebView2().and_then(|core| {
                let mut pid = 0u32;
                core.BrowserProcessId(&mut pid)?;
                let core = core.cast::<ICoreWebView2_27>()?;
                let handler = ScreenCaptureStartingEventHandler::create(Box::new(move |_, _| {
                    let watch = latest.fetch_add(1, Ordering::SeqCst) + 1;
                    let latest = Arc::clone(&latest);
                    let host = host.clone();
                    std::thread::spawn(move || {
                        let deadline = Instant::now() + WATCH_FOR;
                        let mut seen = Vec::new();
                        while Instant::now() < deadline && latest.load(Ordering::SeqCst) == watch {
                            match hide_share_bar(pid, &host) {
                                Ok(()) => return,
                                Err(windows) => seen = windows,
                            }
                            std::thread::sleep(POLL_EVERY);
                        }
                        log::info!("windows_share_bar: no sharing bar found among {seen:?}");
                    });
                    Ok(())
                }));
                let mut token = Default::default();
                core.add_ScreenCaptureStarting(&handler, &mut token)
            })
        };
        if let Err(e) = added {
            log::warn!("windows_share_bar: the sharing bar stays: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("windows_share_bar: the sharing bar stays: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{is_share_bar, origin_host};

    const ORIGIN: &str = "tauri.localhost";

    #[test]
    fn host_drops_the_scheme() {
        assert_eq!(origin_host("http://tauri.localhost"), "tauri.localhost");
        assert_eq!(origin_host("https://tauri.localhost"), "tauri.localhost");
        assert_eq!(origin_host("http://localhost:1420"), "localhost:1420");
    }

    #[test]
    fn matches_the_bar() {
        assert!(is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            48,
            ORIGIN
        ));
        assert!(is_share_bar(
            "http://tauri.localhost deelt je scherm.",
            96,
            ORIGIN
        ));
        assert!(is_share_bar(
            "tauri.localhost is sharing your screen.",
            48,
            ORIGIN
        ));
        assert!(is_share_bar(
            "Partage en cours : http://tauri.localhost",
            48,
            ORIGIN
        ));
    }

    #[test]
    fn skips_tall_or_foreign_windows() {
        assert!(!is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            600,
            ORIGIN
        ));
        assert!(!is_share_bar(
            "https://example.com is sharing your screen.",
            48,
            ORIGIN
        ));
        assert!(!is_share_bar("", 48, ORIGIN));
        assert!(!is_share_bar(
            "http://tauri.localhost is sharing",
            0,
            ORIGIN
        ));
        assert!(!is_share_bar("anything", 48, ""));
        assert!(!is_share_bar(
            "DevTools - http://tauri.localhost/",
            120,
            ORIGIN
        ));
    }
}
