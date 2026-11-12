//! The Linux side of `exit_watch`: memory from `/proc`, the WebKitGTK web
//! process, the desktop session, and the kernel and systemd for a run that
//! ended without a word.
use tauri::Runtime;

/// What can end a run without a word on Linux, for the next start's report.
pub(super) const SILENT_ENDINGS: &str =
    "a SIGKILL (the out-of-memory killer, or the desktop after a freeze)";

/// Copy the last stderr lines of runs that ended silently, then ask the
/// kernel log and systemd-coredump about them.
pub(super) fn report_ended(dir: &std::path::Path, runs: Vec<crate::system_crash_report::EndedRun>) {
    let pids: Vec<u32> = runs.iter().map(|r| r.pid).collect();
    crate::stderr_capture::report_previous(dir, &pids, is_owncord_running);
    crate::system_crash_report::report(runs);
}

/// Keep this process's stderr on disk for the next start.
pub(super) fn capture_stderr(dir: &std::path::Path) {
    crate::stderr_capture::start(dir);
}

/// Bound the stderr file; on every heartbeat.
pub(super) fn trim_stderr() {
    crate::stderr_capture::trim();
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

/// Watch the webview's web process: log its end and its responsiveness. When
/// it ends, end the call and the page's server connection, then reload.
pub(super) fn watch_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let main = window.clone();
    let result = window.with_webview(move |webview| {
        use webkit2gtk::WebViewExt;
        let view = webview.inner();
        view.connect_web_process_terminated(move |_, reason| {
            log::error!("[exit] webview process ended: {reason:?}; ending the call and reloading");
            log::logger().flush();
            tauri::async_runtime::spawn(recover_dead_page(main.clone()));
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

/// How many reloads after a page-process end a minute may see: a page that
/// ends again on every load stays blank instead of looping.
const RELOADS_PER_MINUTE: usize = 3;

/// The page process ended. Nothing can mute or leave the call any more, so
/// end it and drop the page's server connection first, then give the user a
/// working window back. The reload waits for both: the new page's own
/// connect must not be the one torn down.
async fn recover_dead_page<R: Runtime>(main: tauri::WebviewWindow<R>) {
    let app = tauri::Manager::app_handle(&main).clone();
    // Pop-outs share the dead web process: they would stay open and blank.
    crate::popout::close_all(&app);
    // The server connection does not wait for the SFU to answer the close.
    tokio::join!(
        crate::native_voice::page_gone::end_for_dead_page(&app),
        crate::ws_proxy::drop_for_dead_page(&app),
    );
    let now = std::time::Instant::now();
    let allowed = {
        static RELOADS: std::sync::Mutex<Vec<std::time::Instant>> =
            std::sync::Mutex::new(Vec::new());
        may_reload(&mut crate::sync::lock(&RELOADS), now)
    };
    if !allowed {
        log::error!("[exit] the page process keeps ending; not reloading again this minute");
        return;
    }
    if let Err(e) = main.reload() {
        log::warn!("[exit] page reload failed: {e}");
    }
}

/// Whether one more reload fits in the last minute's budget; records it if so.
fn may_reload(history: &mut Vec<std::time::Instant>, now: std::time::Instant) -> bool {
    let minute = std::time::Duration::from_secs(60);
    history.retain(|t| now.saturating_duration_since(*t) < minute);
    if history.len() >= RELOADS_PER_MINUTE {
        return false;
    }
    history.push(now);
    true
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
    fn a_page_that_keeps_ending_stops_reloading_for_the_rest_of_the_minute() {
        let start = std::time::Instant::now();
        let at = |s: u64| start + std::time::Duration::from_secs(s);
        let mut history = Vec::new();
        assert!(may_reload(&mut history, at(0)));
        assert!(may_reload(&mut history, at(5)));
        assert!(may_reload(&mut history, at(10)));
        assert!(
            !may_reload(&mut history, at(15)),
            "a fourth end in a minute"
        );
        assert!(!may_reload(&mut history, at(59)));
        assert!(
            may_reload(&mut history, at(61)),
            "the first reload aged out"
        );
    }

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
