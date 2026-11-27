//! Why the process ended (Linux and Windows), for the support bundle.
//!
//! `crash_log` (Linux) and `exception_log` (Windows) catch what can be caught
//! in-process: panics, crash signals or exceptions, terminate and hang-up
//! signals, X errors. Some endings leave nothing: a `SIGKILL` (the
//! out-of-memory killer, or a desktop killing a window it judged frozen), End
//! task in Task Manager, a crash Windows ends with a fast fail, or an exit
//! through a path that skips the event loop. This module makes those visible
//! on the next start, and logs what precedes them:
//!
//! - A run file per process (`run-<pid>.state` in the log directory),
//!   rewritten every [`HEARTBEAT`] with the time, memory, thread count and
//!   whether the main thread and the webview answer. A normal exit
//!   ([`note_exit`]) deletes it. At startup, a run file left by a process that
//!   is gone is logged with its last contents, so a silent ending reads as
//!   "last seen at T, 1.8 GB, main thread frozen 40 s".
//! - A main-thread watchdog: the event loop is pinged every second, and a
//!   ping unanswered for [`HANG_AFTER`] is logged, then its recovery. A frozen
//!   main thread is what makes a desktop offer to kill a window, and what
//!   Windows calls "Not responding".
//! - The webview's helper processes: their end (crash, memory limit; on
//!   Windows also the GPU and utility processes, such as video capture) and
//!   the page's responsiveness, which the webview reports separately from ours.
//! - Memory: a line each time the resident size crosses another 512 MB.
//! - The session at startup (Linux: X11 or Wayland, desktop, AppImage, kernel,
//!   RAM; Windows: build, RAM, WebView2 version).
//! - For a run that ended without a word, what the system recorded of it
//!   (`system_crash_report`): the kernel and systemd-coredump on Linux, the
//!   Application event log on Windows. On Linux also the run's last stderr
//!   lines (`stderr_capture`), where a library that calls `_exit()` says why.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

use crate::crash_line::utc;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(any(windows, test))]
mod webview_failure;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;

const HEARTBEAT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(1);
const HANG_AFTER: Duration = Duration::from_secs(5);
const MEMORY_STEP_MB: u64 = 512;
/// The run file's state while an update installer takes over.
const UPDATE_STATE: &str = "handing over to an update installer";
/// Seconds after which an unanswered webview probe no longer holds back the
/// next one.
const PROBE_GIVE_UP_SECS: i64 = 30;
const RUN_FILE_PREFIX: &str = "run-";
const RUN_FILE_SUFFIX: &str = ".state";

/// State the watchdog thread, the main thread and the exit path share.
struct Watch {
    run_file: PathBuf,
    started: i64,
    version: String,
    /// Monotonic second ([`mono`]) of the last answered main-thread ping.
    /// Windows' monotonic clock counts the time the machine sleeps, so the
    /// watchdog moves this and the other times below past a sleep it notices
    /// ([`MainCheck::tick`]): a resume is no freeze.
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
    /// Asks a webview that stopped answering whether it answers again, where
    /// the webview reports only the stop (WebView2). Set once by
    /// [`watch_webview`].
    webview_probe: OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// Monotonic second the probe in flight was sent; -1 when none is. A
    /// probe whose answer never comes (its page replaced) stops blocking the
    /// next one after [`PROBE_GIVE_UP_SECS`].
    webview_probe_sent: AtomicI64,
}

impl Watch {
    fn new(run_file: PathBuf, version: &str) -> Self {
        Self {
            run_file,
            started: now(),
            version: version.to_string(),
            main_answered: AtomicI64::new(mono()),
            ping_pending: AtomicBool::new(false),
            webview_unresponsive_since: AtomicI64::new(-1),
            exited: AtomicBool::new(false),
            run_file_lock: Mutex::new(()),
            memory_logged_mb: AtomicU64::new(0),
            webview_probe: OnceLock::new(),
            webview_probe_sent: AtomicI64::new(-1),
        }
    }
}

static WATCH: OnceLock<Arc<Watch>> = OnceLock::new();

/// Seconds on the monotonic clock since this module first asked. On Windows
/// it includes the time the machine sleeps; on Linux it does not.
fn mono() -> i64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    let origin = *ORIGIN.get_or_init(Instant::now);
    i64::try_from(origin.elapsed().as_secs()).unwrap_or(i64::MAX)
}

/// A duration in whole seconds, as [`mono`] counts.
fn secs(d: Duration) -> i64 {
    i64::try_from(d.as_secs()).unwrap_or(i64::MAX)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Report run files that earlier processes left, log the session, then start
/// this process's run file and watchdog. Once per process.
pub fn start<R: Runtime>(app: &AppHandle<R>, log_dir: &Path, version: &str) {
    platform::log_session();
    report_previous_runs(log_dir, std::process::id());
    #[cfg(target_os = "linux")]
    platform::capture_stderr(log_dir);
    let watch = Arc::new(Watch::new(
        run_file_path(log_dir, std::process::id()),
        version,
    ));
    if WATCH.set(watch.clone()).is_err() {
        return;
    }
    // A terminate or hang-up already logs its own line: the handler removes
    // the run file so the next start does not report that run a second time.
    #[cfg(target_os = "linux")]
    platform::set_run_file(&watch.run_file);
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
        write_run_file(watch, mono());
    }
}

fn watchdog<R: Runtime>(app: &AppHandle<R>, watch: &Arc<Watch>) {
    // The first beat writes the run file at once, off the main thread.
    let mut last_beat = i64::MIN / 2;
    let mut check = MainCheck::new(mono());
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
        match check.tick(watch, t) {
            MainVerdict::Hang(silent_for) => {
                log::warn!(
                    "[hang] main thread has not answered for {silent_for} s (window frozen); {}",
                    platform::memory_text()
                );
                log::logger().flush();
                write_run_file(watch, t);
            }
            MainVerdict::Answers(after) => {
                log::warn!(
                    "[hang] main thread answers again after {}",
                    duration_text(after)
                );
            }
            MainVerdict::Unchanged => {}
        }
        probe_webview(watch);
        if t - last_beat >= secs(HEARTBEAT) {
            last_beat = t;
            log_memory_step(watch);
            write_run_file(watch, t);
            #[cfg(target_os = "linux")]
            platform::trim_stderr();
            #[cfg(windows)]
            crate::exception_log::follow_rotation();
        }
    }
}

/// What the watchdog keeps about the main thread from one tick to the next.
struct MainCheck {
    /// Monotonic second of the previous tick.
    prev_tick: i64,
    /// The last answer before the hang that is logged now; `None` while no
    /// hang is.
    hang_since: Option<i64>,
}

/// What one watchdog tick concludes about the main thread.
#[derive(Debug, PartialEq, Eq)]
enum MainVerdict {
    /// Nothing new to log.
    Unchanged,
    /// It has not answered for this many seconds: a hang begins.
    Hang(i64),
    /// It answers again after a hang of this many seconds.
    Answers(i64),
}

impl MainCheck {
    fn new(t: i64) -> Self {
        Self {
            prev_tick: t,
            hang_since: None,
        }
    }

    /// The watchdog's tick at monotonic second `t`.
    ///
    /// The watchdog sleeps with the rest of the machine, so a tick that comes
    /// [`HANG_AFTER`] or more after the previous one, where [`PING_EVERY`] was
    /// due, follows a sleep. The times stored up to the previous tick move
    /// past it, so the main thread and the webview are judged on the seconds
    /// the machine was awake, and a frozen main thread is still frozen after
    /// it. A watchdog held up as long for another reason (a stalled disk
    /// write) is judged the same way. A real freeze still shows, since the
    /// watchdog keeps ticking on time while the main thread is stuck.
    fn tick(&mut self, watch: &Watch, t: i64) -> MainVerdict {
        let prev = self.prev_tick;
        self.prev_tick = t;
        if t - prev >= secs(HANG_AFTER) {
            for stored in [
                &watch.main_answered,
                &watch.webview_unresponsive_since,
                &watch.webview_probe_sent,
            ] {
                // Err: nothing to move.
                let _ = stored.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |since| {
                    past_sleep(since, prev, t)
                });
            }
            self.hang_since = self
                .hang_since
                .map(|since| past_sleep(since, prev, t).unwrap_or(since));
        }
        let silent_for = t - watch.main_answered.load(Ordering::SeqCst);
        match self.hang_since {
            None if silent_for >= secs(HANG_AFTER) => {
                self.hang_since = Some(t - silent_for);
                MainVerdict::Hang(silent_for)
            }
            Some(since) if silent_for < secs(HANG_AFTER) => {
                self.hang_since = None;
                MainVerdict::Answers(t - since)
            }
            _ => MainVerdict::Unchanged,
        }
    }
}

/// `since`, a monotonic second stored before a sleep that fell between the
/// watchdog's ticks at `prev` and `t`, moved past that sleep (never past
/// `t`). `None` when there is nothing to move: no time (-1), or one stored
/// after the resume, such as a main thread's answer that came first, which
/// is nearer this tick than the previous one.
fn past_sleep(since: i64, prev: i64, t: i64) -> Option<i64> {
    let asleep = t - prev - secs(PING_EVERY);
    (since >= 0 && since - prev < t - since).then(|| (since + asleep).min(t))
}

/// Watch the webview's helper processes: log their end and the page's
/// responsiveness.
pub fn watch_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    platform::watch_webview(window);
}

/// The webview stopped answering (`why`: what the webview said). Logged once
/// per stop; the run file picks it up on the watchdog's next beat, so no disk
/// write lands on the thread that reports it.
fn webview_stopped_answering(why: &str) {
    let Some(watch) = WATCH.get() else { return };
    let started = watch
        .webview_unresponsive_since
        .compare_exchange(-1, mono(), Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if started {
        log::warn!(
            "[hang] webview stopped answering ({why}); {}",
            platform::memory_text()
        );
        log::logger().flush();
    }
}

/// The webview answers again after a stop.
fn webview_answers() {
    let Some(watch) = WATCH.get() else { return };
    let since = watch.webview_unresponsive_since.swap(-1, Ordering::SeqCst);
    if since >= 0 {
        log::warn!(
            "[hang] webview answers again after {}",
            duration_text(mono() - since)
        );
    }
}

/// While the webview is not answering, ask it again through the platform's
/// probe, one question at a time.
fn probe_webview(watch: &Watch) {
    if watch.webview_unresponsive_since.load(Ordering::SeqCst) < 0 {
        return;
    }
    let Some(probe) = watch.webview_probe.get() else {
        return;
    };
    let now = mono();
    let sent = watch.webview_probe_sent.load(Ordering::SeqCst);
    let free = sent < 0 || now - sent >= PROBE_GIVE_UP_SECS;
    if free
        && watch
            .webview_probe_sent
            .compare_exchange(sent, now, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        probe();
    }
}

/// The probe [`probe_webview`] asks with. Set once.
#[cfg(windows)]
fn set_webview_probe(probe: Box<dyn Fn() + Send + Sync>) {
    if let Some(watch) = WATCH.get() {
        let _ = watch.webview_probe.set(probe);
    }
}

/// The probe's question was answered (`answered`) or dropped: either way the
/// next one may go.
#[cfg(windows)]
fn webview_probe_done(answered: bool) {
    if let Some(watch) = WATCH.get() {
        watch.webview_probe_sent.store(-1, Ordering::SeqCst);
    }
    if answered {
        webview_answers();
    }
}

fn run_file_path(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("{RUN_FILE_PREFIX}{pid}{RUN_FILE_SUFFIX}"))
}

/// Write the run file as of monotonic second `m`.
fn write_run_file(watch: &Watch, m: i64) {
    // Kept on every heartbeat while the installer runs, so a process the
    // installer ends reads as the update handoff, not an unexplained end.
    let state = if crate::update_commands::installer_launching() {
        UPDATE_STATE
    } else {
        "running"
    };
    let _writing = crate::sync::lock(&watch.run_file_lock);
    if watch.exited.load(Ordering::SeqCst) {
        return;
    }
    let t = now();
    let main_silent = m - watch.main_answered.load(Ordering::SeqCst);
    let main = if main_silent >= secs(HANG_AFTER) {
        format!("not answering for {}", duration_text(main_silent))
    } else {
        "answering".to_string()
    };
    let webview = match watch.webview_unresponsive_since.load(Ordering::SeqCst) {
        since if since < 0 => "answering".to_string(),
        since => format!("not answering for {}", duration_text(m - since)),
    };
    let mut body = format!(
        "version={}\nstarted={}\nlast_seen={}\nstate={state}\n{}\nmain_thread={main}\nwebview={webview}\n",
        watch.version,
        utc(watch.started),
        utc(t),
        platform::memory_text().replace(", ", "\n"),
    );
    if let Some(captures) = platform::captures_text() {
        body.push_str(&captures);
        body.push('\n');
    }
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
    let mut ended = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(pid) = run_file_tmp_pid(&path) {
            if !still_running(pid, own_pid, platform::is_owncord_running) {
                std::fs::remove_file(&path).ok();
            }
            continue;
        }
        let Some(pid) = run_file_pid(&path) else {
            continue;
        };
        if still_running(pid, own_pid, platform::is_owncord_running) {
            continue;
        }
        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        if handed_to_update(&contents) {
            log::info!("[exit] the previous run (pid {pid}) ended for an update");
        } else {
            log::warn!("{}", previous_run_report(pid, &contents));
            ended.push(crate::system_crash_report::EndedRun {
                pid,
                last_seen: modified_secs(&path),
            });
        }
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("[exit] stale run file not removed: {e}");
        }
    }
    platform::report_ended(dir, ended);
}

/// A file's modification time as a Unix second: a run file's is its last
/// heartbeat.
fn modified_secs(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified.duration_since(UNIX_EPOCH).ok()?.as_secs();
    i64::try_from(secs).ok()
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

/// The installer ends the old process without an event-loop exit, so its
/// run file stays: the state it last wrote says so.
fn handed_to_update(contents: &str) -> bool {
    contents
        .lines()
        .any(|l| l.trim() == format!("state={UPDATE_STATE}"))
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
         {}, a power loss, or a crash logged before this line. Its last record: {detail}",
        platform::SILENT_ENDINGS
    )
}

fn log_memory_step(watch: &Watch) {
    let Some(mb) = platform::resident_mb() else {
        return;
    };
    let step = mb / MEMORY_STEP_MB * MEMORY_STEP_MB;
    if step >= MEMORY_STEP_MB && step > watch.memory_logged_mb.fetch_max(step, Ordering::SeqCst) {
        log::info!("[resource] {}", platform::memory_text());
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
        let watch = Watch::new(run_file_path(&dir.0, 1), "test");
        write_run_file(&watch, mono());
        assert!(watch.run_file.exists());
        watch.exited.store(true, Ordering::SeqCst);
        std::fs::remove_file(&watch.run_file).unwrap();
        write_run_file(&watch, mono());
        assert!(
            !watch.run_file.exists(),
            "a late heartbeat must not recreate it"
        );
    }

    /// A watch whose main thread last answered at monotonic second `answered`,
    /// and the watchdog's check with its previous tick at `prev_tick`.
    fn watch_at(dir: &TempDir, answered: i64, prev_tick: i64) -> (Watch, MainCheck) {
        let watch = Watch::new(run_file_path(&dir.0, 1), "test");
        watch.main_answered.store(answered, Ordering::SeqCst);
        (watch, MainCheck::new(prev_tick))
    }

    fn run_file_at(watch: &Watch, t: i64) -> String {
        write_run_file(watch, t);
        std::fs::read_to_string(&watch.run_file).unwrap()
    }

    #[test]
    fn a_tick_after_the_machine_slept_is_no_freeze() {
        let dir = TempDir::new("slept");
        // The tick at 100 pinged the main thread, which answered in that
        // second or the next; the webview stopped answering at 99 and a probe
        // went out. Then the machine sleeps for an hour (Windows' clock
        // counts it), so the next tick comes at 3701.
        for answered in [100, 101] {
            let (watch, mut check) = watch_at(&dir, answered, 100);
            watch.webview_unresponsive_since.store(99, Ordering::SeqCst);
            watch.webview_probe_sent.store(99, Ordering::SeqCst);
            assert_eq!(check.tick(&watch, 3701), MainVerdict::Unchanged);
            let text = run_file_at(&watch, 3701);
            assert!(text.contains("main_thread=answering\n"), "{text}");
            assert!(text.contains("webview=not answering for 2 s\n"), "{text}");
            let probe_age = 3701 - watch.webview_probe_sent.load(Ordering::SeqCst);
            assert!(probe_age < PROBE_GIVE_UP_SECS);
            // The ticks that follow are on time again.
            watch.main_answered.store(3701, Ordering::SeqCst);
            assert_eq!(check.tick(&watch, 3702), MainVerdict::Unchanged);
        }
        // An answer that came after the resume is not moved.
        let (watch, mut check) = watch_at(&dir, 3700, 100);
        assert_eq!(check.tick(&watch, 3701), MainVerdict::Unchanged);
        assert_eq!(watch.main_answered.load(Ordering::SeqCst), 3700);
        assert_eq!(watch.webview_unresponsive_since.load(Ordering::SeqCst), -1);
    }

    #[test]
    fn a_real_freeze_is_logged_after_five_seconds_and_so_is_its_end() {
        let dir = TempDir::new("frozen");
        let (watch, mut check) = watch_at(&dir, 100, 100);
        let verdicts: Vec<MainVerdict> = (101..=106).map(|t| check.tick(&watch, t)).collect();
        assert_eq!(
            verdicts,
            [
                MainVerdict::Unchanged,
                MainVerdict::Unchanged,
                MainVerdict::Unchanged,
                MainVerdict::Unchanged,
                MainVerdict::Hang(5),
                MainVerdict::Unchanged,
            ]
        );
        let text = run_file_at(&watch, 106);
        assert!(
            text.contains("main_thread=not answering for 6 s\n"),
            "{text}"
        );
        assert_eq!(check.tick(&watch, 107), MainVerdict::Unchanged);
        watch.main_answered.store(108, Ordering::SeqCst);
        assert_eq!(check.tick(&watch, 108), MainVerdict::Answers(8));
    }

    #[test]
    fn a_freeze_that_spans_a_sleep_does_not_count_the_sleep() {
        let dir = TempDir::new("frozen-slept");
        let (watch, mut check) = watch_at(&dir, 100, 100);
        for t in 101..=105 {
            check.tick(&watch, t);
        }
        // Still frozen after an hour asleep: no end is logged, and the run
        // file counts awake seconds only: 5 before the sleep, and 1 for the
        // tick it interrupted.
        assert_eq!(check.tick(&watch, 3706), MainVerdict::Unchanged);
        let text = run_file_at(&watch, 3706);
        assert!(
            text.contains("main_thread=not answering for 6 s\n"),
            "{text}"
        );
        watch.main_answered.store(3708, Ordering::SeqCst);
        assert_eq!(check.tick(&watch, 3708), MainVerdict::Answers(8));
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
    fn an_update_handoff_is_not_an_unexplained_end() {
        assert!(handed_to_update(&format!(
            "version=1\nstate={UPDATE_STATE}\n"
        )));
        assert!(!handed_to_update("version=1\nstate=running\n"));
        assert!(!handed_to_update(""));
    }

    #[test]
    fn durations_read_naturally() {
        assert_eq!(duration_text(-3), "0 s");
        assert_eq!(duration_text(45), "45 s");
        assert_eq!(duration_text(600), "10 min");
        assert_eq!(duration_text(3 * 3600 + 120), "3 h 2 min");
    }
}
