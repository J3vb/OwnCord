//! What the system saw of a run that ended without a word (Linux).
//!
//! A native thread whose stack is gone cannot run our crash handler, so the
//! only witnesses are the kernel and systemd: the kernel logs the faulting
//! thread and library, and systemd-coredump keeps a stack trace. When the
//! next start finds such a run (`exit_watch`), this asks both and copies the
//! answer into our log, so the support bundle names what crashed without the
//! user running anything. Either tool may be missing or refuse (no
//! systemd-coredump, no journal access): that is logged once and skipped.
//!
//! The log is shared in support bundles, so what is copied is kept to the
//! crash: no host or machine ids, other processes only by their crash line,
//! and the home directory written as `~`.
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::external_open::host_command;

/// How long one system query may take: coredumpctl can be slow while it
/// reads a large core.
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
/// Most output read from one query.
const MAX_OUTPUT: u64 = 256 * 1024;
/// Lines of a coredump report kept: the header and the crashing thread's
/// stack come first.
const CORE_LINES: usize = 80;
/// Seconds around the run's last heartbeat searched for kernel lines and
/// core dumps. A heartbeat is every 10 s; a hung process can stop beating
/// a while before it dies.
const WINDOW_SECS: i64 = 300;

/// One ended run to ask about: its pid and the Unix second it was last seen
/// (`None` when unknown: the kernel log is then not searched).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndedRun {
    pub pid: u32,
    pub last_seen: Option<i64>,
}

/// Ask the system about `runs` on a background thread and log what it says.
pub fn report(runs: Vec<EndedRun>) {
    if runs.is_empty() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("owncord-crash-report".into())
        .spawn(move || {
            let home = std::env::var("HOME").ok();
            for run in runs {
                log_coredump(run, home.as_deref());
                log_kernel(run, home.as_deref());
            }
        });
    if let Err(e) = spawned {
        log::warn!("[exit] system crash report not started: {e}");
    }
}

fn log_coredump(run: EndedRun, home: Option<&str>) {
    let pid = run.pid.to_string();
    // Only a dump from around this run: a pid is reused across boots.
    let since = run.last_seen.map(|t| format!("@{}", t - WINDOW_SECS));
    let mut args = vec!["info", "--no-pager"];
    if let Some(since) = since.as_deref() {
        args.extend(["--since", since]);
    }
    args.push(&pid);
    match query("coredumpctl", &args) {
        Ok(answer) => {
            let lines = coredump_lines(&answer.out, home);
            if lines.is_empty() {
                log::info!(
                    "[exit] coredumpctl has no record of pid {pid} ({})",
                    answer.status
                );
                return;
            }
            for line in lines {
                log::warn!("[exit] coredump pid {pid}: {line}");
            }
        }
        Err(e) => log::info!("[exit] coredumpctl not available: {e}"),
    }
}

fn log_kernel(run: EndedRun, home: Option<&str>) {
    let Some(last_seen) = run.last_seen else {
        return;
    };
    let since = format!("@{}", last_seen - WINDOW_SECS);
    let until = format!("@{}", last_seen + WINDOW_SECS);
    let args = [
        "-k",
        "--no-pager",
        "-o",
        "cat",
        "--since",
        &since,
        "--until",
        &until,
    ];
    match query("journalctl", &args) {
        Ok(answer) => {
            let lines = kernel_lines(&answer.out, run.pid, home);
            if lines.is_empty() {
                log::info!(
                    "[exit] kernel log has no crash line near pid {} ({})",
                    run.pid,
                    answer.status
                );
            }
            for line in lines {
                log::warn!("[exit] kernel near pid {}: {line}", run.pid);
            }
        }
        Err(e) => log::info!("[exit] kernel log not readable: {e}"),
    }
}

/// A query's standard output and how it exited (an empty output with a
/// failure status means "could not read", not "nothing happened").
struct Answer {
    out: String,
    status: String,
}

/// Run a host program with a deadline and return its standard output.
fn query(program: &str, args: &[&str]) -> Result<Answer, String> {
    let mut child = host_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("{program}: no output pipe"));
    };
    let reader = std::thread::Builder::new()
        .name("owncord-crash-query".into())
        .spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.take(MAX_OUTPUT).read_to_end(&mut out);
            out
        });
    let reader = match reader {
        Ok(reader) => reader,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program}: {e}"));
        }
    };
    let deadline = Instant::now() + QUERY_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            outcome => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match outcome {
                    Err(e) => format!("{program}: {e}"),
                    _ => format!("{program}: no answer in {}s", QUERY_TIMEOUT.as_secs()),
                });
            }
        }
    };
    let out = reader
        .join()
        .map_err(|_| format!("{program}: reader failed"))?;
    Ok(Answer {
        out: String::from_utf8_lossy(&out).into_owned(),
        status: status.to_string(),
    })
}

/// `line` with the home directory written as `~`.
fn private(line: &str, home: Option<&str>) -> String {
    match home.filter(|h| h.len() > 1) {
        Some(home) => line.replace(home, "~"),
        None => line.to_string(),
    }
}

/// The useful part of `coredumpctl info`: everything but the lines that
/// identify the machine, capped at [`CORE_LINES`].
fn coredump_lines(out: &str, home: Option<&str>) -> Vec<String> {
    const MACHINE: [&str; 3] = ["Boot ID:", "Machine ID:", "Hostname:"];
    out.lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .filter(|l| !MACHINE.iter().any(|p| l.trim_start().starts_with(p)))
        .take(CORE_LINES)
        .map(|l| private(l, home))
        .collect()
}

/// Kernel lines that report a crash (any process: the line names the
/// faulting thread, which carries no pid of ours) or that killed `pid`.
fn kernel_lines(out: &str, pid: u32, home: Option<&str>) -> Vec<String> {
    const CRASH: [&str; 3] = ["segfault at", "general protection", "traps:"];
    let killed = format!("Killed process {pid} ");
    out.lines()
        .filter(|l| CRASH.iter().any(|m| l.contains(m)) || l.contains(&killed))
        .map(|l| private(l.trim_end(), home))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coredump_report_drops_machine_ids_hides_home_and_is_capped() {
        let out = "           PID: 101272 (owncord-client)\n\
                   Signal: 11 (SEGV)\n\
                   Command Line: /home/someone/Apps/OwnCord.AppImage\n\
                   Boot ID: 1234\n\
                   Machine ID: abcd\n\
                   Hostname: laptop\n\
                   \n\
                   Stack trace of thread 101300:\n\
                   #0  0x00007f libwebrtc (owncord-client + 0x123)\n";
        let lines = coredump_lines(out, Some("/home/someone"));
        assert_eq!(lines.len(), 5);
        assert!(lines.iter().all(|l| !l.contains("Machine ID")
            && !l.contains("Boot ID")
            && !l.contains("Hostname")
            && !l.contains("/home/someone")));
        assert!(lines[2].contains("~/Apps/OwnCord.AppImage"));
        assert!(lines[4].contains("libwebrtc"));
        let long = "line\n".repeat(CORE_LINES + 20);
        assert_eq!(coredump_lines(&long, None).len(), CORE_LINES);
    }

    #[test]
    fn kernel_lines_keep_crashes_and_only_our_own_kill() {
        let out = "wlan0: link up\n\
                   owncord-screen[101300]: segfault at 0 ip 00007f sp 00007f error 4 in libpipewire-0.3.so\n\
                   Out of memory: Killed process 5 (firefox) total-vm:1kB\n\
                   Out of memory: Killed process 101272 (owncord-client) total-vm:1kB\n";
        let lines = kernel_lines(out, 101_272, None);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("owncord-screen"));
        assert!(lines[1].contains("101272"));
    }

    #[test]
    fn a_missing_program_is_an_error_not_a_hang() {
        assert!(query("owncord-no-such-program", &[]).is_err());
    }

    #[test]
    fn a_query_returns_the_programs_output_and_status() {
        let answer = query("echo", &["hello"]).unwrap();
        assert_eq!(answer.out.trim(), "hello");
        assert!(answer.status.contains('0'));
        let failed = query("false", &[]).unwrap();
        assert!(failed.out.is_empty());
        assert!(failed.status.contains('1'));
    }
}
