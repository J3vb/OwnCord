//! The process's stderr, kept on disk for the next start (Linux).
//!
//! Native libraries say their last words on stderr: GDK prints the Wayland
//! or X error it exits on, libwebrtc and GLib print a fatal check, PipeWire
//! its errors. A desktop-launched app's stderr goes nowhere we can read, and
//! an `_exit()` from such a library leaves no signal, no core dump and no
//! kernel line. So stderr is pointed at `stderr-<pid>.log` in the log
//! directory, written straight through by the kernel (it survives any
//! ending), and a start that finds a run that ended without a word copies
//! that run's last lines into the native log. The file is not part of the
//! support bundle: only the copied lines are, with the home directory as `~`.
//!
//! A terminal's stderr is left alone, so a developer still sees it live.
//!
//! The capture starts in `main`, before GTK: GLib picks the journal or stderr
//! for its messages at its first one and keeps that choice, so a capture made
//! after GLib had logged once left GDK's last words in the journal.
use std::ffi::{CString, OsStr};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

const PREFIX: &str = "stderr-";
const SUFFIX: &str = ".log";
/// Size past which the file is emptied on a heartbeat; what matters is the
/// end, and a chatty library must not fill the disk.
const MAX_BYTES: i64 = 2 * 1024 * 1024;
/// How much of the end of a run's file is read for its report.
const TAIL_BYTES: u64 = 16 * 1024;
/// Lines of it copied into the log.
const TAIL_LINES: usize = 40;
/// Longest copied line, in characters.
const LINE_CHARS: usize = 300;

/// Set once stderr points at our file: [`trim`] never touches a file someone
/// else redirected stderr to.
static CAPTURED: AtomicBool = AtomicBool::new(false);

/// What the capture at launch did, and in which directory, for [`start`] to
/// log once the logger exists.
static AT_LAUNCH: OnceLock<(PathBuf, Outcome)> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    Captured,
    Terminal,
    LauncherFile,
    /// The errno of the failed open or dup.
    Failed(Option<i32>),
}

fn path_for(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("{PREFIX}{pid}{SUFFIX}"))
}

fn file_pid(path: &Path) -> Option<u32> {
    path.file_name()?
        .to_str()?
        .strip_prefix(PREFIX)?
        .strip_suffix(SUFFIX)?
        .parse()
        .ok()
}

/// Capture stderr first thing in `main`, before GTK or GLib start. Nothing is
/// logged yet (there is no logger); [`start`] reports the outcome.
pub fn start_at_launch() {
    let Some(dir) = crate::launch_env::log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let outcome = capture(&dir);
    let _ = AT_LAUNCH.set((dir, outcome));
}

/// Point this process's stderr at its file in `dir`, unless stderr is a
/// terminal or a file the launcher chose; a no-op beyond logging when the
/// capture at launch already decided.
pub fn start(dir: &Path) {
    let outcome = match AT_LAUNCH.get() {
        Some((at, outcome)) if at == dir => *outcome,
        // The launch had no directory, or a different one: capture here.
        _ => capture(dir),
    };
    match outcome {
        Outcome::Captured => log::info!("[exit] stderr kept for the next start's report"),
        Outcome::Terminal | Outcome::LauncherFile => {
            log::info!("[exit] stderr already goes to a terminal or file; not captured");
        }
        Outcome::Failed(errno) => log::warn!(
            "[exit] stderr not captured: {}",
            errno.map_or_else(
                || "unknown error".to_string(),
                |e| std::io::Error::from_raw_os_error(e).to_string()
            )
        ),
    }
}

fn capture(dir: &Path) -> Outcome {
    // SAFETY: isatty(3) and fstat(2) on a file descriptor number, into a
    // zeroed struct.
    let (tty, file) = unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        let file = libc::fstat(libc::STDERR_FILENO, &mut stat) == 0
            && (stat.st_mode & libc::S_IFMT) == libc::S_IFREG;
        (libc::isatty(libc::STDERR_FILENO) == 1, file)
    };
    if tty {
        return Outcome::Terminal;
    }
    if file && !CAPTURED.load(Ordering::Acquire) && !stderr_is_own_file(dir) {
        return Outcome::LauncherFile;
    }
    let path = path_for(dir, std::process::id());
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return Outcome::Failed(None);
    };
    // SAFETY: open(2) on a valid C path, then dup2(2) onto stderr and close
    // of the now-duplicated descriptor.
    let done = unsafe {
        let fd = libc::open(
            c_path.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND | libc::O_CLOEXEC,
            0o600,
        );
        if fd < 0 {
            false
        } else {
            let ok = libc::dup2(fd, libc::STDERR_FILENO) >= 0;
            // A stderr closed at launch makes open(2) return 2 itself.
            if fd != libc::STDERR_FILENO {
                libc::close(fd);
            }
            ok
        }
    };
    if done {
        CAPTURED.store(true, Ordering::Release);
        Outcome::Captured
    } else {
        Outcome::Failed(std::io::Error::last_os_error().raw_os_error())
    }
}

/// Whether stderr is one of our own files, inherited from the run that
/// started this one: an in-app restart (update, Clear & Restart) hands the
/// new process the old one's stderr. That file is ours to replace, deleted or
/// not, unlike a file a launcher chose.
fn stderr_is_own_file(dir: &Path) -> bool {
    std::fs::read_link("/proc/self/fd/2").is_ok_and(|target| is_own_file(&target, dir))
}

/// Whether `target` (a `/proc/self/fd` link, so absolute and resolved) names
/// a capture file in `dir`.
fn is_own_file(target: &Path, dir: &Path) -> bool {
    let bytes = target.as_os_str().as_bytes();
    let path = Path::new(OsStr::from_bytes(
        bytes.strip_suffix(b" (deleted)").unwrap_or(bytes),
    ));
    let Some(parent) = path.parent() else {
        return false;
    };
    file_pid(path).is_some()
        && (parent == dir || std::fs::canonicalize(dir).is_ok_and(|d| d == parent))
}

/// Empty the file once it passes [`MAX_BYTES`]. Writes are appends, so they
/// carry on at the new end.
pub fn trim() {
    if !CAPTURED.load(Ordering::Acquire) {
        return;
    }
    // SAFETY: fstat(2) into a zeroed struct and ftruncate(2) on stderr,
    // which is our own file once captured.
    unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(libc::STDERR_FILENO, &mut stat) == 0
            && (stat.st_mode & libc::S_IFMT) == libc::S_IFREG
            && stat.st_size > MAX_BYTES
        {
            libc::ftruncate(libc::STDERR_FILENO, 0);
        }
    }
}

/// Log the last stderr lines of each run in `ended`, then delete every file
/// left by a process that is gone. `running` says whether a pid is another
/// live OwnCord; its file is kept, as is this process's own, captured at
/// launch.
pub fn report_previous(dir: &Path, ended: &[u32], running: impl Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let own_pid = std::process::id();
    let home = std::env::var("HOME").ok();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(pid) = file_pid(&path) else {
            continue;
        };
        if pid == own_pid || running(pid) {
            continue;
        }
        if ended.contains(&pid) {
            match read_tail(&path) {
                Ok(text) => {
                    let lines = tail_lines(&text, home.as_deref());
                    if lines.is_empty() {
                        log::info!("[exit] stderr of pid {pid} is empty");
                    }
                    for line in lines {
                        log::warn!("[exit] stderr pid {pid}: {line}");
                    }
                }
                Err(e) => log::info!("[exit] stderr of pid {pid} not read: {e}"),
            }
        }
        if let Err(e) = std::fs::remove_file(&path) {
            log::debug!("[exit] stderr file not removed: {e}");
        }
    }
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // A cut start is a partial line: drop it.
    Ok(match (start > 0, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text,
    })
}

fn tail_lines(text: &str, home: Option<&str>) -> Vec<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(TAIL_LINES)..]
        .iter()
        .map(|l| {
            let l = crate::system_crash_report::private(l, home);
            match l.char_indices().nth(LINE_CHARS) {
                Some((i, _)) => format!("{}…", &l[..i]),
                None => l,
            }
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // the tests plant stderr files directly
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("owncord-stderr-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn files_are_named_by_pid() {
        let path = path_for(Path::new("/logs"), 77);
        assert_eq!(path, Path::new("/logs/stderr-77.log"));
        assert_eq!(file_pid(&path), Some(77));
        assert_eq!(file_pid(Path::new("/logs/owncord-client.log")), None);
        assert_eq!(file_pid(Path::new("/logs/stderr-x.log")), None);
    }

    #[test]
    fn the_tail_is_the_last_lines_capped_with_home_hidden() {
        let mut text = String::new();
        for i in 0..TAIL_LINES + 10 {
            text.push_str(&format!("line {i}\n\n"));
        }
        text.push_str("Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.\n");
        text.push_str("open /home/someone/x failed\n");
        text.push_str(&"y".repeat(LINE_CHARS + 50));
        let lines = tail_lines(&text, Some("/home/someone"));
        assert_eq!(lines.len(), TAIL_LINES);
        assert!(lines[TAIL_LINES - 3].contains("Wayland display"));
        assert_eq!(lines[TAIL_LINES - 2], "open ~/x failed");
        assert_eq!(lines[TAIL_LINES - 1].chars().count(), LINE_CHARS + 1);
    }

    #[test]
    fn a_long_file_is_read_from_its_end_without_a_cut_line() {
        let dir = Dir::new("tail");
        let path = dir.0.join("stderr-5.log");
        let mut text = "z".repeat(usize::try_from(TAIL_BYTES).unwrap());
        text.push_str("\nlast words\n");
        std::fs::write(&path, &text).unwrap();
        let tail = read_tail(&path).unwrap();
        assert_eq!(tail, "last words\n");
    }

    #[test]
    fn ended_runs_are_reported_and_only_live_files_kept() {
        let dir = Dir::new("report");
        let own = std::process::id();
        for pid in [4_194_301, 4_194_302, 4_194_303, own] {
            std::fs::write(path_for(&dir.0, pid), "bye\n").unwrap();
        }
        report_previous(&dir.0, &[4_194_301], |pid| pid == 4_194_303);
        assert!(!path_for(&dir.0, 4_194_301).exists());
        assert!(!path_for(&dir.0, 4_194_302).exists());
        assert!(path_for(&dir.0, 4_194_303).exists());
        assert!(
            path_for(&dir.0, own).exists(),
            "this run's file, captured at launch"
        );
    }

    /// An in-app restart hands the new run the old run's stderr: our own
    /// file, often already deleted by the new run's report. It is captured
    /// anew; a file a launcher chose is not.
    #[test]
    fn an_inherited_capture_file_is_ours_and_a_launcher_file_is_not() {
        let dir = Dir::new("own");
        let old = path_for(&dir.0, 4_194_305);
        assert!(is_own_file(&old, &dir.0));
        let mut deleted = old.clone().into_os_string();
        deleted.push(" (deleted)");
        assert!(is_own_file(Path::new(&deleted), &dir.0));
        assert!(!is_own_file(&dir.0.join("owncord-client.log"), &dir.0));
        assert!(!is_own_file(Path::new("/tmp/stderr-7.log"), &dir.0));
        assert!(!is_own_file(Path::new("/home/u/launcher.log"), &dir.0));
    }

    const CHILD_DIR: &str = "OWNCORD_TEST_STDERR_CAPTURE_DIR";

    /// Runs the capture only as the child process of the test below.
    #[test]
    fn capture_in_child() {
        let Some(dir) = std::env::var_os(CHILD_DIR) else {
            return;
        };
        let outcome = capture(Path::new(&dir));
        println!("outcome: {outcome:?}");
        let _ = std::io::Write::write_all(&mut std::io::stderr(), b"after capture\n");
    }

    /// The capture in a process whose stderr is what an in-app restart
    /// leaves (the old run's file, there or deleted) or a launcher chose.
    #[test]
    fn a_restarts_inherited_file_is_captured_again_and_a_launchers_kept() {
        let dir = Dir::new("child");
        let run = |stderr: std::fs::File| {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "stderr_capture::tests::capture_in_child",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_DIR, &dir.0)
                .stdout(std::process::Stdio::piped())
                .stderr(stderr)
                .spawn()
                .unwrap();
            let pid = child.id();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            (pid, String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let read = |path: &Path| std::fs::read_to_string(path).unwrap_or_default();

        let old = path_for(&dir.0, 4_194_306);
        let (pid, out) = run(std::fs::File::create(&old).unwrap());
        assert!(out.contains("outcome: Captured"), "{out}");
        assert!(read(&path_for(&dir.0, pid)).contains("after capture"));
        assert!(!read(&old).contains("after capture"));

        let deleted = path_for(&dir.0, 4_194_307);
        let file = std::fs::File::create(&deleted).unwrap();
        std::fs::remove_file(&deleted).unwrap();
        let (pid, out) = run(file);
        assert!(out.contains("outcome: Captured"), "{out}");
        assert!(read(&path_for(&dir.0, pid)).contains("after capture"));

        let launcher = dir.0.join("launcher.log");
        let (pid, out) = run(std::fs::File::create(&launcher).unwrap());
        assert!(out.contains("outcome: LauncherFile"), "{out}");
        assert!(read(&launcher).contains("after capture"));
        assert!(!path_for(&dir.0, pid).exists());
    }
}
