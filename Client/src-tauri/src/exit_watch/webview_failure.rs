//! The log line for a WebView2 helper process that failed (Windows).
//!
//! WebView2 runs the page, the GPU and services such as video capture in
//! their own processes and restarts most of them on its own. A restart is
//! short but visible: a GPU process restart pauses every video for a few
//! seconds, and a video capture restart stops the camera until it is opened
//! again. The line names the process, why it ended and what the user saw,
//! with the module that failed by file name only (its path holds the user's
//! home folder for a per-user install).

/// What one `ProcessFailed` event said. Kinds and reasons are WebView2's
/// `COREWEBVIEW2_PROCESS_FAILED_KIND` and `_REASON` values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Failure {
    pub kind: i32,
    pub reason: Option<i32>,
    pub exit_code: Option<i32>,
    pub description: String,
    pub module: String,
}

const BROWSER_PROCESS_EXITED: i32 = 0;
pub(super) const RENDER_PROCESS_EXITED: i32 = 1;
pub(super) const RENDER_PROCESS_UNRESPONSIVE: i32 = 2;
const FRAME_RENDER_PROCESS_EXITED: i32 = 3;
const UTILITY_PROCESS_EXITED: i32 = 4;
const SANDBOX_HELPER_PROCESS_EXITED: i32 = 5;
const GPU_PROCESS_EXITED: i32 = 6;

/// The process a kind names, in the event catalogue's words.
fn process(kind: i32) -> &'static str {
    match kind {
        BROWSER_PROCESS_EXITED => "browser",
        RENDER_PROCESS_EXITED | RENDER_PROCESS_UNRESPONSIVE | FRAME_RENDER_PROCESS_EXITED => {
            "renderer"
        }
        UTILITY_PROCESS_EXITED | SANDBOX_HELPER_PROCESS_EXITED => "utility",
        GPU_PROCESS_EXITED => "gpu",
        _ => "unknown",
    }
}

fn reason(reason: Option<i32>) -> &'static str {
    match reason {
        Some(0) => "unexpected",
        Some(1) => "unresponsive",
        Some(2) => "terminated",
        Some(3) => "crashed",
        Some(4) => "launch failed",
        Some(5) => "out of memory",
        Some(6) => "profile deleted",
        _ => "unknown",
    }
}

/// What the user saw, by kind.
fn consequence(kind: i32) -> &'static str {
    match kind {
        BROWSER_PROCESS_EXITED => "the window stays blank until OwnCord restarts",
        RENDER_PROCESS_EXITED => "the window shows an error page until it is reloaded",
        FRAME_RENDER_PROCESS_EXITED => "an embedded frame went blank",
        UTILITY_PROCESS_EXITED => {
            "WebView2 restarts the service; a camera, microphone or screen capture it ran stops"
        }
        SANDBOX_HELPER_PROCESS_EXITED => "WebView2 restarts it",
        GPU_PROCESS_EXITED => "WebView2 restarts it; video and the window pause for a few seconds",
        _ => "WebView2 restarts it if it can",
    }
}

/// The log line for `failure`.
pub(super) fn failure_text(failure: &Failure) -> String {
    let mut text = format!(
        "[exit] webview {} process failed: {}",
        process(failure.kind),
        reason(failure.reason)
    );
    let description = failure.description.trim();
    if !description.is_empty() {
        text.push_str(&format!(" ({description})"));
    }
    if let Some(code) = failure.exit_code {
        // Exit codes are mostly NTSTATUS values, read in hex.
        text.push_str(&format!(", exit code {:#010X}", code as u32));
    }
    let module = failure
        .module
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim();
    if !module.is_empty() {
        text.push_str(&format!(", in module '{module}'"));
    }
    text.push_str("; ");
    text.push_str(consequence(failure.kind));
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gpu_crash_names_the_pause_and_the_module_without_its_path() {
        let text = failure_text(&Failure {
            kind: GPU_PROCESS_EXITED,
            reason: Some(3),
            exit_code: Some(0xC000_0005_u32 as i32),
            description: String::new(),
            module: r"C:\Users\jdoe\AppData\Local\x\nvwgf2umx.dll".into(),
        });
        assert_eq!(
            text,
            "[exit] webview gpu process failed: crashed, exit code 0xC0000005, in module \
             'nvwgf2umx.dll'; WebView2 restarts it; video and the window pause for a few seconds"
        );
    }

    #[test]
    fn a_utility_process_carries_its_service_name() {
        let text = failure_text(&Failure {
            kind: UTILITY_PROCESS_EXITED,
            reason: Some(0),
            exit_code: Some(1),
            description: "Video Capture".into(),
            module: String::new(),
        });
        assert!(
            text.starts_with(
                "[exit] webview utility process failed: unexpected (Video Capture), exit code 0x00000001; "
            ) && text.contains("camera"),
            "{text}"
        );
    }

    #[test]
    fn an_old_runtime_without_reasons_still_reads() {
        let text = failure_text(&Failure {
            kind: BROWSER_PROCESS_EXITED,
            ..Failure::default()
        });
        assert_eq!(
            text,
            "[exit] webview browser process failed: unknown; the window stays blank until OwnCord restarts"
        );
        assert!(failure_text(&Failure {
            kind: 42,
            ..Failure::default()
        })
        .starts_with("[exit] webview unknown process failed"));
    }

    #[test]
    fn every_kind_and_reason_has_a_name() {
        for kind in 0..=9 {
            assert!(!consequence(kind).is_empty());
        }
        assert_eq!(process(RENDER_PROCESS_UNRESPONSIVE), "renderer");
        assert_eq!(reason(Some(5)), "out of memory");
        assert_eq!(reason(Some(99)), "unknown");
    }
}
