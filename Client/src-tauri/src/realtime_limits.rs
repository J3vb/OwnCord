//! Keeps the process's own threads off realtime scheduling (Linux).
//!
//! libwebrtc asks for `SCHED_FIFO` on every thread it starts, the video
//! encoders included, and gets it wherever the session's `RLIMIT_RTPRIO`
//! allows (audio-tuned distributions grant it; most desktops do not). A
//! screen share then loads PipeWire's realtime module into the process, and
//! on a host that grants realtime priority but not the nice level it wants,
//! that module goes through RTKit and caps `RLIMIT_RTTIME` for the whole
//! process at RTKit's 200 ms. From then on the kernel ends the process, with
//! no signal a handler sees, once any realtime thread runs that long without
//! sleeping, which a software encoder under load does.
//!
//! So `main` lowers the soft `RLIMIT_RTPRIO` to 0 while the process has one
//! thread: libwebrtc's request is refused and its threads stay on the normal
//! scheduler, as they are on a default desktop. PipeWire still makes its own
//! data thread realtime through RTKit or the desktop portal, which need no
//! limit here. Only the soft limit moves, so a program started from the app
//! can raise it again.
use std::sync::OnceLock;

/// What [`drop_realtime_priority`] found and did, for the startup log line.
static AT_LAUNCH: OnceLock<Outcome> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    /// The soft limit was already 0: nothing to lower.
    AlreadyOff { hard: libc::rlim_t },
    Lowered {
        soft: libc::rlim_t,
        hard: libc::rlim_t,
    },
    /// The errno of the failed getrlimit or setrlimit.
    Failed(Option<i32>),
}

fn limit(resource: libc::__rlimit_resource_t) -> Result<libc::rlimit, Option<i32>> {
    let mut now = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit(2) fills the struct it is given.
    if unsafe { libc::getrlimit(resource, &mut now) } != 0 {
        return Err(std::io::Error::last_os_error().raw_os_error());
    }
    Ok(now)
}

fn lower() -> Outcome {
    let now = match limit(libc::RLIMIT_RTPRIO) {
        Ok(now) => now,
        Err(errno) => return Outcome::Failed(errno),
    };
    if now.rlim_cur == 0 {
        return Outcome::AlreadyOff { hard: now.rlim_max };
    }
    let next = libc::rlimit {
        rlim_cur: 0,
        rlim_max: now.rlim_max,
    };
    // SAFETY: setrlimit(2) reads the struct; lowering a soft limit needs no
    // privilege.
    if unsafe { libc::setrlimit(libc::RLIMIT_RTPRIO, &next) } != 0 {
        return Outcome::Failed(std::io::Error::last_os_error().raw_os_error());
    }
    Outcome::Lowered {
        soft: now.rlim_cur,
        hard: now.rlim_max,
    }
}

/// Lower the soft realtime-priority limit to 0. Called once from `main`,
/// before any thread exists; a failure leaves the process as it was.
pub(crate) fn drop_realtime_priority() {
    AT_LAUNCH.get_or_init(lower);
}

fn amount(value: libc::rlim_t) -> String {
    if value == libc::RLIM_INFINITY {
        "unlimited".into()
    } else {
        value.to_string()
    }
}

fn describe(outcome: Option<Outcome>, rttime: Result<libc::rlimit, Option<i32>>) -> String {
    let rtprio = match outcome {
        None => "not changed".to_string(),
        Some(Outcome::AlreadyOff { hard }) => format!("0/{}", amount(hard)),
        Some(Outcome::Lowered { soft, hard }) => {
            format!("{}/{} lowered to 0", amount(soft), amount(hard))
        }
        Some(Outcome::Failed(errno)) => format!(
            "unchanged (errno {})",
            errno.map_or("unknown".to_string(), |e| e.to_string())
        ),
    };
    let rttime = match rttime {
        Ok(l) => format!("{}/{}", amount(l.rlim_cur), amount(l.rlim_max)),
        Err(_) => "unknown".into(),
    };
    format!("rtprio={rtprio}, rttime_us={rttime}")
}

/// The realtime limits as `soft/hard`, for the startup session line.
pub(crate) fn summary() -> String {
    describe(AT_LAUNCH.get().copied(), limit(libc::RLIMIT_RTTIME))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rtprio() -> libc::rlimit {
        limit(libc::RLIMIT_RTPRIO).expect("getrlimit")
    }

    #[test]
    fn the_soft_limit_drops_to_zero_and_the_hard_limit_stays() {
        let before = rtprio();
        let first = lower();
        let after = rtprio();
        assert_eq!(after.rlim_cur, 0);
        assert_eq!(after.rlim_max, before.rlim_max);
        if before.rlim_cur == 0 {
            assert_eq!(
                first,
                Outcome::AlreadyOff {
                    hard: before.rlim_max
                }
            );
        } else {
            assert_eq!(
                first,
                Outcome::Lowered {
                    soft: before.rlim_cur,
                    hard: before.rlim_max
                }
            );
        }
        // A second call finds nothing left to lower and changes nothing.
        assert_eq!(
            lower(),
            Outcome::AlreadyOff {
                hard: before.rlim_max
            }
        );
        assert_eq!(rtprio().rlim_max, before.rlim_max);
    }

    #[test]
    fn a_child_process_can_raise_the_limit_again() {
        let before = rtprio();
        lower();
        let raised = libc::rlimit {
            rlim_cur: before.rlim_max,
            rlim_max: before.rlim_max,
        };
        // SAFETY: fork(2) in a test; the child only calls setrlimit and _exit,
        // both async-signal-safe.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // SAFETY: see above.
            unsafe {
                let ok = libc::setrlimit(libc::RLIMIT_RTPRIO, &raised) == 0;
                libc::_exit(if ok { 0 } else { 1 });
            }
        }
        let mut status = 0;
        // SAFETY: waits for the child forked above.
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0);
    }

    #[test]
    fn the_summary_names_what_was_found_and_done() {
        let rttime = |soft, hard| {
            Ok(libc::rlimit {
                rlim_cur: soft,
                rlim_max: hard,
            })
        };
        assert_eq!(
            describe(
                Some(Outcome::Lowered { soft: 99, hard: 99 }),
                rttime(libc::RLIM_INFINITY, libc::RLIM_INFINITY)
            ),
            "rtprio=99/99 lowered to 0, rttime_us=unlimited/unlimited"
        );
        assert_eq!(
            describe(
                Some(Outcome::AlreadyOff { hard: 0 }),
                rttime(200_000, 200_000)
            ),
            "rtprio=0/0, rttime_us=200000/200000"
        );
        assert_eq!(
            describe(Some(Outcome::Failed(Some(1))), Err(None)),
            "rtprio=unchanged (errno 1), rttime_us=unknown"
        );
        assert_eq!(
            describe(None, Err(None)),
            "rtprio=not changed, rttime_us=unknown"
        );
    }
}
