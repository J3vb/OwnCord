//! What the system saw of a run that ended without a word (Linux).
//!
//! A native thread whose stack is gone cannot run our crash handler, so the
//! only witnesses are the kernel and systemd: the kernel logs the faulting
//! thread and library, and systemd-coredump keeps a stack trace. When the
//! next start finds such a run (`exit_watch`), this asks both and copies the
//! answer into our log, so the support bundle names what crashed without the
//! user running anything. Either tool may be missing or refuse (no
//! systemd-coredump, no journal access): that is logged once and skipped.
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::external_open::host_command;

/// How long one system query may take: coredumpctl can be slow while it
/// reads a large core.
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
/// Lines of a coredump report kept: the header and the crashing thread's
/// stack come first.
const CORE_LINES: usize = 80;
/// Seconds around the run's last heartbeat searched for kernel lines.
const KERNEL_WINDOW_SECS: i64 = 120;

/// One ended run to ask about: its pid and the Unix second it was last seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndedRun {
    pub pid: u32,
    pub last_seen: i64,
}

/// Ask the system about `runs` on a background thread and log what it says.
pub fn report(runs: Vec<EndedRun>) {
    if runs.is_empty() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("owncord-crash-report".into())
        .spawn(move || {
            for run in runs {
                log_coredump(run);
                log_kernel(run);
            }
        });
    if let Err(e) = spawned {
        log::warn!("[exit] system crash report not started: {e}");
    }
}

fn log_coredump(run: EndedRun) {
    let pid = run.pid.to_string();
    match query("coredumpctl", &["info", "--no-pager", &pid]) {
        Ok(out) => {
            let lines = coredump_lines(&out);
            if lines.is_empty() {
                log::info!("[exit] coredumpctl has no record of pid {pid}");
                return;
            }
            for line in lines {
                log::warn!("[exit] coredump pid {pid}: {line}");
            }
        }
        Err(e) => log::info!("[exit] coredumpctl not available: {e}"),
    }
}

fn log_kernel(run: EndedRun) {
    let since = format!("@{}", run.last_seen - KERNEL_WINDOW_SECS);
    let until = format!("@{}", run.last_seen + KERNEL_WINDOW_SECS);
    let args = [
        "-k",
        "--no-pager",
        "-o",
        "short-iso",
        "--since",
        &since,
        "--until",
        &until,
    ];
    match query("journalctl", &args) {
        Ok(out) => {
            let lines = kernel_lines(&out);
            if lines.is_empty() {
                log::info!("[exit] kernel log has no crash line near pid {}", run.pid);
            }
            for line in lines {
                log::warn!("[exit] kernel near pid {}: {line}", run.pid);
            }
        }
        Err(e) => log::info!("[exit] kernel log not readable: {e}"),
    }
}

/// Run a host program with a deadline and return its standard output.
fn query(program: &str, args: &[&str]) -> Result<String, String> {
    let mut child = host_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::Builder::new()
        .name("owncord-crash-query".into())
        .spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            out
        })
        .map_err(|e| format!("{program}: {e}"))?;
    let deadline = Instant::now() + QUERY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{program}: no answer in {}s",
                    QUERY_TIMEOUT.as_secs()
                ));
            }
            Err(e) => return Err(format!("{program}: {e}")),
        }
    }
    let out = reader
        .join()
        .map_err(|_| format!("{program}: reader failed"))?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// The useful part of `coredumpctl info`: everything but the lines that
/// identify the machine, capped at [`CORE_LINES`].
fn coredump_lines(out: &str) -> Vec<String> {
    const PRIVATE: [&str; 3] = ["Boot ID:", "Machine ID:", "Hostname:"];
    out.lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .filter(|l| !PRIVATE.iter().any(|p| l.trim_start().starts_with(p)))
        .take(CORE_LINES)
        .map(str::to_string)
        .collect()
}

/// Kernel lines that report a process crash or kill.
fn kernel_lines(out: &str) -> Vec<String> {
    const MARKERS: [&str; 6] = [
        "segfault at",
        "general protection",
        "traps:",
        "Out of memory",
        "oom-kill",
        "Killed process",
    ];
    out.lines()
        .filter(|l| MARKERS.iter().any(|m| l.contains(m)))
        .map(|l| l.trim_end().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coredump_report_drops_machine_ids_and_is_capped() {
        let out = "           PID: 101272 (owncord-client)\n\
                   Signal: 11 (SEGV)\n\
                   Boot ID: 1234\n\
                   Machine ID: abcd\n\
                   Hostname: laptop\n\
                   \n\
                   Stack trace of thread 101300:\n\
                   #0  0x00007f libwebrtc (owncord-client + 0x123)\n";
        let lines = coredump_lines(out);
        assert_eq!(lines.len(), 4);
        assert!(lines.iter().all(|l| !l.contains("Machine ID")
            && !l.contains("Boot ID")
            && !l.contains("Hostname")));
        assert!(lines[3].contains("libwebrtc"));
        let long = "line\n".repeat(CORE_LINES + 20);
        assert_eq!(coredump_lines(&long).len(), CORE_LINES);
    }

    #[test]
    fn kernel_lines_keep_only_crashes_and_kills() {
        let out = "2026-10-31T16:20:18+0100 host kernel: wlan0: link up\n\
                   2026-10-31T16:20:18+0100 host kernel: owncord-screen[101300]: segfault at 0 ip 00007f sp 00007f error 4 in libpipewire-0.3.so\n\
                   2026-10-31T16:20:19+0100 host kernel: Out of memory: Killed process 5 (x)\n";
        let lines = kernel_lines(out);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("owncord-screen"));
    }

    #[test]
    fn a_missing_program_is_an_error_not_a_hang() {
        assert!(query("owncord-no-such-program", &[]).is_err());
    }

    #[test]
    fn a_query_returns_the_programs_output() {
        assert_eq!(query("echo", &["hello"]).unwrap().trim(), "hello");
    }
}
