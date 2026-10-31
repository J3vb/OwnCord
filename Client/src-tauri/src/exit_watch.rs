//! Why the process ended (Linux), for the support bundle.
//!
//! `crash_log` catches what can be caught in-process: panics, crash signals,
//! terminate and hang-up signals, X errors. Some endings leave nothing: a
//! `SIGKILL` (the out-of-memory killer, or a desktop killing a window it judged
//! frozen), or an exit through a path that skips the event loop. This module
//! makes those visible on the next start, and logs what precedes them:
//!
//! - A run file per process (`run-<pid>.state` in the log directory),
//!   rewritten every [`HEARTBEAT`] with the time, memory, thread count and
//!   whether the main thread and the webview answer. A normal exit
//!   ([`note_exit`]) deletes it. At startup, a run file left by a process that
//!   is gone is logged with its last contents, so a silent ending reads as
//!   "last seen at T, 1.8 GB, main thread frozen 40 s".
//! - A main-thread watchdog: the GTK main loop is pinged every second, and a
//!   ping unanswered for [`HANG_AFTER`] is logged, then its recovery. A frozen
//!   main thread is what makes a desktop offer to kill a window.
//! - The webview's web process: its termination (crash, memory limit) and
//!   its responsiveness, which WebKitGTK reports separately from ours.
//! - Memory: a line each time the resident size crosses another 512 MB.
//! - The session at startup: X11 or Wayland, desktop, AppImage, kernel, RAM.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

use crate::crash_log::utc;

const HEARTBEAT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(1);
const HANG_AFTER: Duration = Duration::from_secs(5);
const MEMORY_STEP_MB: u64 = 512;
const RUN_FILE_PREFIX: &str = "run-";
const RUN_FILE_SUFFIX: &str = ".state";

/// State the watchdog thread, the main thread and the exit path share.
struct Watch {
    run_file: PathBuf,
    started: i64,
    version: String,
    /// Monotonic second ([`mono`]) of the last answered main-thread ping. A
    /// suspended machine does not advance it, so a resume is no freeze.
    main_answered: AtomicI64,
    /// A ping is queued and not yet answered: no second one is queued behind
    /// a frozen main thread.
    ping_pending: AtomicBool,
    /// Monotonic second the webview last went unresponsive; -1 while it
    /// answers.
    webview_unresponsive_since: AtomicI64,
    /// Set by `note_exit`: the thread stops and the run file is gone.
    exited: AtomicBool,
    /// Held across each run-file write and the exit's removal, so a write
    /// in flight cannot bring the file back after a normal exit.
    run_file_lock: Mutex<()>,
    /// Highest memory step logged so far, in MB.
    memory_logged_mb: AtomicU64,
}

static WATCH: OnceLock<Arc<Watch>> = OnceLock::new();

/// Seconds on the monotonic clock since this module first asked.
fn mono() -> i64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    let origin = *ORIGIN.get_or_init(Instant::now);
    i64::try_from(origin.elapsed().as_secs()).unwrap_or(i64::MAX)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Report run files that earlier processes left, log the session, then start
/// this process's run file and watchdog. Once per process.
pub fn start<R: Runtime>(app: &AppHandle<R>, log_dir: &Path, version: &str) {
    log_session();
    report_previous_runs(log_dir, std::process::id());
    let watch = Arc::new(Watch {
        run_file: run_file_path(log_dir, std::process::id()),
        started: now(),
        version: version.to_string(),
        main_answered: AtomicI64::new(mono()),
        ping_pending: AtomicBool::new(false),
        webview_unresponsive_since: AtomicI64::new(-1),
        exited: AtomicBool::new(false),
        run_file_lock: Mutex::new(()),
        memory_logged_mb: AtomicU64::new(0),
    });
    if WATCH.set(watch.clone()).is_err() {
        return;
    }
    // A terminate or hang-up already logs its own line: the handler removes
    // the run file so the next start does not report that run a second time.
    crate::crash_log::set_run_file(&watch.run_file);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("owncord-exit-watch".into())
        .spawn(move || watchdog(&app, &watch));
    if let Err(e) = spawned {
        log::warn!("[exit] watchdog not started: {e}");
    }
}

/// Log how the process is leaving and delete its run file. Called from the
/// event loop's exit; later calls are no-ops.
pub fn note_exit(how: &str) {
    let Some(watch) = WATCH.get() else { return };
    let _writing = crate::sync::lock(&watch.run_file_lock);
    if watch.exited.swap(true, Ordering::SeqCst) {
        return;
    }
    let uptime = now() - watch.started;
    log::info!("[exit] {how}; normal exit after {}", duration_text(uptime));
    log::logger().flush();
    if let Err(e) = std::fs::remove_file(&watch.run_file) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[exit] run file not removed: {e}");
        }
    }
}

/// Record an update installer launch in the run file, so a next start that
/// finds it reads it as the update handoff rather than an unexplained end.
pub fn note_update_handoff() {
    if let Some(watch) = WATCH.get() {
        write_run_file(watch);
    }
}

fn watchdog<R: Runtime>(app: &AppHandle<R>, watch: &Arc<Watch>) {
    // The first beat writes the run file at once, off the main thread.
    let mut last_beat = i64::MIN / 2;
    let mut hang_logged_at: Option<i64> = None;
    while !watch.exited.load(Ordering::SeqCst) {
        if !watch.ping_pending.swap(true, Ordering::SeqCst) {
            let answered = watch.clone();
            let ping = app.run_on_main_thread(move || {
                answered.main_answered.store(mono(), Ordering::SeqCst);
                answered.ping_pending.store(false, Ordering::SeqCst);
            });
            if ping.is_err() {
                // The event loop is gone: the process is exiting.
                return;
            }
        }
        std::thread::sleep(PING_EVERY);
        let t = mono();
        let silent_for = t - watch.main_answered.load(Ordering::SeqCst);
        let hang_secs = i64::try_from(HANG_AFTER.as_secs()).unwrap_or(5);
        match hang_logged_at {
            None if silent_for >= hang_secs => {
                log::warn!(
                    "[hang] main thread has not answered for {silent_for} s (window frozen); {}",
                    memory_text()
                );
                log::logger().flush();
                hang_logged_at = Some(t - silent_for);
                write_run_file(watch);
            }
            Some(since) if silent_for < hang_secs => {
                log::warn!(
                    "[hang] main thread answers again after {}",
                    duration_text(t - since)
                );
                hang_logged_at = None;
            }
            _ => {}
        }
        if t - last_beat >= i64::try_from(HEARTBEAT.as_secs()).unwrap_or(10) {
            last_beat = t;
            log_memory_step(watch);
            write_run_file(watch);
        }
    }
}

/// Watch the webview's web process: log its end and its responsiveness.
pub fn watch_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) {
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
            let Some(watch) = WATCH.get() else { return };
            if view.is_web_process_responsive() {
                let since = watch.webview_unresponsive_since.swap(-1, Ordering::SeqCst);
                if since >= 0 {
                    log::warn!(
                        "[hang] webview answers again after {}",
                        duration_text(mono() - since)
                    );
                }
            } else {
                watch
                    .webview_unresponsive_since
                    .store(mono(), Ordering::SeqCst);
                log::warn!(
                    "[hang] webview stopped answering (page script busy or stuck); {}",
                    memory_text()
                );
                log::logger().flush();
            }
            // The run file picks this up on the watchdog's next beat: no
            // disk write on the main thread.
        });
    });
    if let Err(e) = result {
        log::warn!("[exit] webview not watched: {e}");
    }
}

fn run_file_path(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("{RUN_FILE_PREFIX}{pid}{RUN_FILE_SUFFIX}"))
}

fn write_run_file(watch: &Watch) {
    // Kept on every heartbeat while the installer runs, so a process the
    // installer ends reads as the update handoff, not an unexplained end.
    let state = if crate::update_commands::installer_launching() {
        "handing over to an update installer"
    } else {
        "running"
    };
    let _writing = crate::sync::lock(&watch.run_file_lock);
    if watch.exited.load(Ordering::SeqCst) {
        return;
    }
    let t = now();
    let m = mono();
    let main_silent = m - watch.main_answered.load(Ordering::SeqCst);
    let main = if main_silent >= i64::try_from(HANG_AFTER.as_secs()).unwrap_or(5) {
        format!("not answering for {}", duration_text(main_silent))
    } else {
        "answering".to_string()
    };
    let webview = match watch.webview_unresponsive_since.load(Ordering::SeqCst) {
        since if since < 0 => "answering".to_string(),
        since => format!("not answering for {}", duration_text(m - since)),
    };
    // Which native captures were running: a crash that leaves no signal line
    // (a thread whose stack was gone, an `exit()` inside a library) is read
    // on the next start, and "camera and screen capturing" is the lead.
    let body = format!(
        "version={}\nstarted={}\nlast_seen={}\nstate={state}\n{}\nmain_thread={main}\nwebview={webview}\ncaptures=camera:{} screen:{}\n",
        watch.version,
        utc(watch.started),
        utc(t),
        memory_text().replace(", ", "\n"),
        crate::native_voice::camera::active_captures(),
        crate::native_voice::screen::active_captures(),
    );
    if let Err(e) = crate::json_store::write_atomic(&watch.run_file, body.as_bytes()) {
        log::debug!("[exit] run file not written: {e}");
    }
}

/// Log each run file a process that is no longer running left behind, then
/// delete it. A file of another live OwnCord process (an update handoff
/// overlaps two) is left alone. This process has written none yet, so a file
/// with its own pid is an earlier run's whose pid was reused.
fn report_previous_runs(dir: &Path, own_pid: u32) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(pid) = run_file_tmp_pid(&path) {
            if !still_running(pid, own_pid, is_owncord_running) {
                std::fs::remove_file(&path).ok();
            }
            continue;
        }
        let Some(pid) = run_file_pid(&path) else {
            continue;
        };
        if still_running(pid, own_pid, is_owncord_running) {
            continue;
        }
        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        log::warn!("{}", previous_run_report(pid, &contents));
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("[exit] stale run file not removed: {e}");
        }
    }
}

/// Whether a run file's process is another OwnCord that is still running.
fn still_running(pid: u32, own_pid: u32, running: impl Fn(u32) -> bool) -> bool {
    pid != own_pid && running(pid)
}

/// The pid of a temp file an interrupted run-file write left.
fn run_file_tmp_pid(path: &Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?.strip_suffix(".tmp")?;
    run_file_pid(Path::new(name))
}

fn run_file_pid(path: &Path) -> Option<u32> {
    path.file_name()?
        .to_str()?
        .strip_prefix(RUN_FILE_PREFIX)?
        .strip_suffix(RUN_FILE_SUFFIX)?
        .parse()
        .ok()
}

/// Whether `pid` is a running process (not a thread of one) with this
/// process's name.
fn is_owncord_running(pid: u32) -> bool {
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

fn previous_run_report(pid: u32, contents: &str) -> String {
    let fields: Vec<&str> = contents.lines().filter(|l| !l.trim().is_empty()).collect();
    let detail = if fields.is_empty() {
        "no details recorded".to_string()
    } else {
        fields.join(", ")
    };
    format!(
        "[exit] the previous run (pid {pid}) ended without a normal exit or a logged signal: \
         a SIGKILL (the out-of-memory killer, or the desktop after a freeze), a power loss, \
         or a crash logged before this line. Its last record: {detail}"
    )
}

/// Resident and peak memory and thread count, from `/proc/self/status`.
fn memory_text() -> String {
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

fn resident_mb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse::<u64>().ok())
        .map(|kb| kb / 1024)
}

fn log_memory_step(watch: &Watch) {
    let Some(mb) = resident_mb() else { return };
    let step = mb / MEMORY_STEP_MB * MEMORY_STEP_MB;
    if step >= MEMORY_STEP_MB && step > watch.memory_logged_mb.fetch_max(step, Ordering::SeqCst) {
        log::info!("[resource] {}", memory_text());
    }
}

fn duration_text(secs: i64) -> String {
    let secs = secs.max(0);
    if secs < 120 {
        format!("{secs} s")
    } else if secs < 7200 {
        format!("{} min", secs / 60)
    } else {
        format!("{} h {} min", secs / 3600, secs / 60 % 60)
    }
}

/// The desktop session, once at startup: what a "works on my machine"
/// report needs first. No paths, names or identifiers.
fn log_session() {
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
#[allow(clippy::disallowed_methods)] // tests plant run files directly
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("owncord-exit-watch-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn run_files_are_named_by_pid() {
        let dir = Path::new("/logs");
        let path = run_file_path(dir, 6117);
        assert_eq!(path, Path::new("/logs/run-6117.state"));
        assert_eq!(run_file_pid(&path), Some(6117));
        assert_eq!(run_file_pid(Path::new("/logs/owncord-client.log")), None);
        assert_eq!(run_file_pid(Path::new("/logs/run-x.state")), None);
        assert_eq!(run_file_pid(Path::new("/logs/run-6117.state.tmp")), None);
        assert_eq!(
            run_file_tmp_pid(Path::new("/logs/run-6117.state.tmp")),
            Some(6117)
        );
        assert_eq!(run_file_tmp_pid(&path), None);
    }

    #[test]
    fn a_dead_runs_file_is_reported_and_removed_a_live_one_kept() {
        let dir = TempDir::new("report");
        // Not running: pid_max is at most 2^22 on Linux.
        let dead = run_file_path(&dir.0, 4_194_303 + 1);
        std::fs::write(&dead, "last_seen=x\n").unwrap();
        let torn = dir.0.join("run-4194304.state.tmp");
        std::fs::write(&torn, "last_").unwrap();
        // This test process stands in for a live OwnCord sibling.
        let own = std::process::id();
        let live_sibling = run_file_path(&dir.0, own);
        std::fs::write(&live_sibling, "last_seen=y\n").unwrap();
        report_previous_runs(&dir.0, own.wrapping_add(1));
        assert!(!dead.exists(), "a gone process's run file is consumed");
        assert!(!torn.exists(), "a gone process's temp file is removed");
        assert!(live_sibling.exists(), "a live process's run file is kept");
        // At startup a file with this process's own pid is a reused pid's.
        report_previous_runs(&dir.0, own);
        assert!(
            !live_sibling.exists(),
            "a reused pid's run file is reported"
        );
    }

    #[test]
    fn only_another_live_process_keeps_its_run_file() {
        assert!(still_running(7, 1, |_| true));
        assert!(!still_running(7, 7, |_| true));
        assert!(!still_running(7, 1, |_| false));
    }

    #[test]
    fn no_write_lands_after_a_normal_exit() {
        let dir = TempDir::new("exit");
        let watch = Watch {
            run_file: run_file_path(&dir.0, 1),
            started: now(),
            version: "test".into(),
            main_answered: AtomicI64::new(mono()),
            ping_pending: AtomicBool::new(false),
            webview_unresponsive_since: AtomicI64::new(-1),
            exited: AtomicBool::new(false),
            run_file_lock: Mutex::new(()),
            memory_logged_mb: AtomicU64::new(0),
        };
        write_run_file(&watch);
        assert!(watch.run_file.exists());
        watch.exited.store(true, Ordering::SeqCst);
        std::fs::remove_file(&watch.run_file).unwrap();
        write_run_file(&watch);
        assert!(
            !watch.run_file.exists(),
            "a late heartbeat must not recreate it"
        );
    }

    #[test]
    fn the_report_carries_the_last_record() {
        let text = previous_run_report(
            6117,
            "version=2.3.0\nlast_seen=2026-10-14 18:47:10 UTC\nmain_thread=not answering for 40 s\n",
        );
        assert!(text.contains("pid 6117"), "{text}");
        assert!(
            text.contains("last_seen=2026-10-14 18:47:10 UTC, main_thread=not answering for 40 s"),
            "{text}"
        );
        assert!(previous_run_report(1, "").contains("no details recorded"));
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
    fn durations_read_naturally() {
        assert_eq!(duration_text(-3), "0 s");
        assert_eq!(duration_text(45), "45 s");
        assert_eq!(duration_text(600), "10 min");
        assert_eq!(duration_text(3 * 3600 + 120), "3 h 2 min");
    }

    #[test]
    fn a_running_process_is_recognised_by_name() {
        assert!(is_owncord_running(std::process::id()));
        assert!(!is_owncord_running(4_194_304));
    }
}
