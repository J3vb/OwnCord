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
use std::ffi::CString;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

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

/// Point this process's stderr at its file in `dir`, unless stderr is a
/// terminal.
pub fn start(dir: &Path) {
    // SAFETY: isatty(3) on a file descriptor number.
    if unsafe { libc::isatty(libc::STDERR_FILENO) } == 1 {
        log::info!("[exit] stderr is a terminal; not captured");
        return;
    }
    let path = path_for(dir, std::process::id());
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return;
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
            libc::close(fd);
            ok
        }
    };
    if done {
        log::info!("[exit] stderr kept for the next start's report");
    } else {
        log::warn!(
            "[exit] stderr not captured: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Empty the file once it passes [`MAX_BYTES`]. Writes are appends, so they
/// carry on at the new end.
pub fn trim() {
    // SAFETY: fstat(2) into a zeroed struct and ftruncate(2) on stderr; on a
    // terminal or pipe both fail or do nothing.
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
/// live OwnCord; its file is kept.
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
        if pid != own_pid && running(pid) {
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
        for pid in [4_194_301, 4_194_302, 4_194_303] {
            std::fs::write(path_for(&dir.0, pid), "bye\n").unwrap();
        }
        report_previous(&dir.0, &[4_194_301], |pid| pid == 4_194_303);
        assert!(!path_for(&dir.0, 4_194_301).exists());
        assert!(!path_for(&dir.0, 4_194_302).exists());
        assert!(path_for(&dir.0, 4_194_303).exists());
    }
}
