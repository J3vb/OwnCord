//! The Linux side of `exit_watch`: memory from `/proc`, the WebKitGTK web
//! process, the desktop session, and the kernel and systemd for a run that
//! ended without a word.
use tauri::Runtime;

/// What can end a run without a word on Linux, for the next start's report.
pub(super) const SILENT_ENDINGS: &str =
    "a SIGKILL (the out-of-memory killer, or the desktop after a freeze)";

/// Ask the kernel log and systemd-coredump about runs that ended silently.
pub(super) fn report_ended(runs: Vec<crate::system_crash_report::EndedRun>) {
    crate::system_crash_report::report(runs);
}

/// Which native captures were running, for the run file: a crash that leaves
/// no signal line (a thread whose stack was gone, an `exit()` inside a
/// library) is read on the next start, and "camera and screen capturing" is
/// the lead.
pub(super) fn captures_text() -> Option<String> {
    Some(format!(
        "captures=camera:{} screen:{}",
        crate::native_voice::camera::active_captures(),
        crate::native_voice::screen::active_captures(),
    ))
}

/// The run file a terminate or hang-up removes after logging its own line.
pub(super) fn set_run_file(path: &std::path::Path) {
    crate::crash_log::set_run_file(path);
}

/// Watch the webview's web process: log its end and its responsiveness.
pub(super) fn watch_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let result = window.with_webview(|webview| {
        use webkit2gtk::WebViewExt;
        let view = webview.inner();
        view.connect_web_process_terminated(|_, reason| {
            log::error!(
                "[exit] webview process ended: {reason:?}; the window goes blank until reloaded"
            );
            log::logger().flush();
        });
        view.connect_is_web_process_responsive_notify(|view| {
            if view.is_web_process_responsive() {
                super::webview_answers();
            } else {
                super::webview_stopped_answering("page script busy or stuck");
            }
            // The run file picks this up on the watchdog's next beat: no
            // disk write on the main thread.
        });
    });
    if let Err(e) = result {
        log::warn!("[exit] webview not watched: {e}");
    }
}

/// Whether `pid` is a running process (not a thread of one) with this
/// process's name.
pub(super) fn is_owncord_running(pid: u32) -> bool {
    let read = |p: &str| std::fs::read_to_string(format!("/proc/{p}/status")).ok();
    let field = |status: &str, name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .map(|v| v.trim().to_string())
    };
    let (Some(theirs), Some(ours)) = (read(&pid.to_string()), read("self")) else {
        return false;
    };
    field(&theirs, "Tgid:") == Some(pid.to_string())
        && field(&theirs, "Name:").is_some()
        && field(&theirs, "Name:") == field(&ours, "Name:")
}

/// Resident and peak memory and thread count, from `/proc/self/status`.
pub(super) fn memory_text() -> String {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    format_memory(&status)
}

fn format_memory(status: &str) -> String {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<u64>().ok())
    };
    let mb = |kb: Option<u64>| kb.map_or("unknown".to_string(), |kb| format!("{} MB", kb / 1024));
    format!(
        "memory={}, memory_peak={}, threads={}",
        mb(field("VmRSS:")),
        mb(field("VmHWM:")),
        field("Threads:").map_or("unknown".to_string(), |t| t.to_string())
    )
}

pub(super) fn resident_mb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse::<u64>().ok())
        .map(|kb| kb / 1024)
}

/// The desktop session, once at startup: what a "works on my machine"
/// report needs first. No paths, names or identifiers.
pub(super) fn log_session() {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let set = |name: &str| if var(name).is_some() { "set" } else { "unset" };
    let kernel = {
        // SAFETY: uname(2) fills a zeroed struct.
        let mut uts: libc::utsname = unsafe { std::mem::zeroed() };
        if unsafe { libc::uname(&mut uts) } == 0 {
            // SAFETY: uname NUL-terminates `release`.
            unsafe { std::ffi::CStr::from_ptr(uts.release.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        } else {
            "unknown".into()
        }
    };
    let ram = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| {
            m.lines()
                .find_map(|l| l.strip_prefix("MemTotal:"))
                .and_then(|v| v.split_whitespace().next())
                .and_then(|v| v.parse::<u64>().ok())
        })
        .map_or("unknown".to_string(), |kb| format!("{} MB", kb / 1024));
    log::info!(
        "[startup] session: type={}, desktop={}, WAYLAND_DISPLAY {}, DISPLAY {}, GDK_BACKEND={}, AppImage={}, kernel={kernel}, RAM={ram}, WEBKIT_DISABLE_DMABUF_RENDERER={}, WEBKIT_DISABLE_COMPOSITING_MODE={}",
        var("XDG_SESSION_TYPE").unwrap_or_else(|| "unknown".into()),
        var("XDG_CURRENT_DESKTOP").unwrap_or_else(|| "unknown".into()),
        set("WAYLAND_DISPLAY"),
        set("DISPLAY"),
        var("GDK_BACKEND").unwrap_or_else(|| "default".into()),
        if var("APPIMAGE").is_some() { "yes" } else { "no" },
        var("WEBKIT_DISABLE_DMABUF_RENDERER").unwrap_or_else(|| "unset".into()),
        var("WEBKIT_DISABLE_COMPOSITING_MODE").unwrap_or_else(|| "unset".into()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_read_from_proc_status() {
        let status = "Name:\towncord\nVmHWM:\t 1887436 kB\nVmRSS:\t  838860 kB\nThreads:\t56\n";
        assert_eq!(
            format_memory(status),
            "memory=819 MB, memory_peak=1843 MB, threads=56"
        );
        assert_eq!(
            format_memory(""),
            "memory=unknown, memory_peak=unknown, threads=unknown"
        );
        assert!(resident_mb().is_some());
    }

    #[test]
    fn a_running_process_is_recognised_by_name() {
        assert!(is_owncord_running(std::process::id()));
        assert!(!is_owncord_running(4_194_304));
    }
}
