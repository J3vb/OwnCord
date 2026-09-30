//! Diagnostics for failures that otherwise leave nothing in the Rust log: a
//! panic, and a frontend that never came up (the "blank window" report).

use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

/// Log every panic, with its location and a backtrace, before the default
/// hook runs. Without this a panic in a background task reached only stderr,
/// which a release build has nowhere to send.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".into());
        log::error!(
            "[panic] thread '{}' panicked at {location}: {}\n{}",
            thread.name().unwrap_or("<unnamed>"),
            panic_message(info.payload()),
            std::backtrace::Backtrace::force_capture()
        );
        // The process may abort right after the hook; get the line to disk.
        log::logger().flush();
        default_hook(info);
    }));
}

/// The text a `panic!` carried, when it carried text.
fn panic_message(payload: &dyn Any) -> &str {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s
    } else {
        "<non-string panic payload>"
    }
}

/// How long the frontend has to call `frontend_ready` before the watchdog
/// logs that it did not come up. Warn-only: a slow machine is not an error.
const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether the frontend has reported that it finished starting.
pub struct FrontendReady {
    started: Instant,
    ready: AtomicBool,
}

impl FrontendReady {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            ready: AtomicBool::new(false),
        }
    }

    /// Record readiness; returns the time since start on the first call only.
    fn mark_ready(&self) -> Option<Duration> {
        (!self.ready.swap(true, Ordering::SeqCst)).then(|| self.started.elapsed())
    }
}

/// Called by the frontend once its UI is up.
#[tauri::command]
pub fn frontend_ready(state: tauri::State<'_, FrontendReady>) {
    if let Some(elapsed) = state.mark_ready() {
        log::info!("[startup] frontend ready after {} ms", elapsed.as_millis());
    }
}

/// The warning the watchdog logs when the frontend has not called
/// `frontend_ready` by [`FRONTEND_READY_TIMEOUT`]. Kept as its own function so
/// a unit test can pin the exact wording ("frontend not ready") the support
/// bundle and the docs point at, without a running Tauri app.
fn frontend_not_ready_warning() -> String {
    format!(
        "[startup] frontend not ready {} s after start; the window may be blank \
         (a frontend load or script error). The tray's Open Log Folder shows this log.",
        FRONTEND_READY_TIMEOUT.as_secs()
    )
}

/// Log a warning if the frontend has not called `frontend_ready` in time.
pub fn spawn_frontend_watchdog<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FRONTEND_READY_TIMEOUT).await;
        if !app.state::<FrontendReady>().ready.load(Ordering::SeqCst) {
            log::warn!("{}", frontend_not_ready_warning());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_message_reads_str_and_string_payloads() {
        assert_eq!(panic_message(&"boom"), "boom");
        assert_eq!(panic_message(&String::from("boom")), "boom");
        assert_eq!(panic_message(&42_u8), "<non-string panic payload>");
    }

    #[test]
    fn readiness_is_reported_once() {
        let state = FrontendReady::new();
        assert!(!state.ready.load(Ordering::SeqCst));
        assert!(state.mark_ready().is_some(), "the first call logs");
        assert!(state.mark_ready().is_none(), "a repeat call is silent");
        assert!(state.ready.load(Ordering::SeqCst));
    }

    // The warning names the condition the support bundle's README and the
    // deployment docs point an operator at, so its wording is pinned.
    #[test]
    fn not_ready_warning_names_the_condition() {
        let warning = frontend_not_ready_warning();
        assert!(warning.contains("frontend not ready"), "{warning}");
        assert!(warning.contains("may be blank"), "{warning}");
        assert!(warning.contains("Open Log Folder"), "{warning}");
    }
}
