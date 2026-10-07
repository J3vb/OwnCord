//! Last words for a native crash (Linux).
//!
//! A panic reaches the log through `diagnostics::install_panic_hook`, but a
//! crash in C or C++ code does not: a fatal signal from libwebrtc or a capture
//! library, `abort()`, `g_error`'s trap, or GDK's handler for an X error,
//! which prints to stderr and calls `_exit(1)`. A release build's stderr goes
//! nowhere, so until now such a crash left a log that simply stopped.
//!
//! [`install`] adds two things, after the log plugin and GTK are up:
//!
//! - A handler for the fatal signals that writes one line to the native log,
//!   in the log plugin's format, then hands the signal back to whatever
//!   handled it before (Rust's stack-overflow handler, or the default action),
//!   so core dumps, `coredumpctl` and the exit status are unchanged. It runs
//!   in signal context, so it only formats into a stack buffer and calls
//!   async-signal-safe functions: the file is opened by path at that moment,
//!   which also follows the log plugin's rotation.
//! - Xlib error and I/O-error handlers that log the error and then call the
//!   handler they replaced (GDK's). Xlib is not linked here: the setters are
//!   looked up at runtime, and skipped when the process has no Xlib.
use std::ffi::{c_int, c_void, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

const SIGNALS: [(c_int, &str); 6] = [
    (libc::SIGSEGV, "SIGSEGV"),
    (libc::SIGBUS, "SIGBUS"),
    (libc::SIGILL, "SIGILL"),
    (libc::SIGFPE, "SIGFPE"),
    (libc::SIGABRT, "SIGABRT"),
    // `g_error` ends in a breakpoint trap.
    (libc::SIGTRAP, "SIGTRAP"),
];

/// The native log file, as a C path for `open(2)` in signal context.
static LOG_FILE: OnceLock<CString> = OnceLock::new();
/// The action each of [`SIGNALS`] had before ours, by index.
static PREVIOUS: [OnceLock<libc::sigaction>; SIGNALS.len()] =
    [const { OnceLock::new() }; SIGNALS.len()];

/// Install the signal and X error handlers. Once per process; `log_file` is
/// the log plugin's file.
pub fn install(log_file: &Path) {
    let Ok(path) = CString::new(log_file.as_os_str().as_bytes()) else {
        return;
    };
    if LOG_FILE.set(path).is_err() {
        return;
    }
    for (i, (signal, _)) in SIGNALS.iter().enumerate() {
        // SAFETY: plain sigaction(2) calls on zeroed structs; the handler only
        // calls async-signal-safe functions.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction =
                on_fatal_signal as extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) as usize;
            action.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
            libc::sigemptyset(&mut action.sa_mask);
            let mut previous: libc::sigaction = std::mem::zeroed();
            if libc::sigaction(*signal, &action, &mut previous) == 0 {
                let _ = PREVIOUS[i].set(previous);
            }
        }
    }
    install_x_handlers();
}

extern "C" fn on_fatal_signal(signal: c_int, info: *mut libc::siginfo_t, _: *mut c_void) {
    let mut thread = [0u8; 16];
    // SAFETY: PR_GET_NAME writes at most 16 bytes, NUL included.
    unsafe { libc::prctl(libc::PR_GET_NAME, thread.as_mut_ptr()) };
    let name_len = thread.iter().position(|&b| b == 0).unwrap_or(thread.len());
    let mut now: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: clock_gettime is async-signal-safe.
    unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut now) };
    let mut line = [0u8; 256];
    let len = format_line(&mut line, now.tv_sec, signal, &thread[..name_len]);
    if let Some(path) = LOG_FILE.get() {
        // SAFETY: open/write/close are async-signal-safe.
        unsafe {
            let fd = libc::open(
                path.as_ptr(),
                libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT | libc::O_CLOEXEC,
                0o644,
            );
            if fd >= 0 {
                libc::write(fd, line.as_ptr().cast(), len);
                libc::close(fd);
            }
        }
    }
    let index = SIGNALS.iter().position(|(s, _)| *s == signal);
    let previous = index.and_then(|i| PREVIOUS[i].get());
    // SAFETY: restoring the action this signal had before `install`.
    unsafe {
        match previous {
            Some(previous) => libc::sigaction(signal, previous, std::ptr::null_mut()),
            None => libc::signal(signal, libc::SIG_DFL) as c_int,
        };
    }
    // A fault the kernel raised repeats when the faulting instruction runs
    // again on return, now reaching the previous handler. A sent signal
    // (abort, raise, kill) or a breakpoint trap does not repeat: send it
    // again, to be delivered as soon as this handler returns.
    let code = if info.is_null() {
        0
    } else {
        unsafe { (*info).si_code }
    };
    let repeats = code > 0 && code != libc::SI_KERNEL && signal != libc::SIGTRAP;
    if !repeats {
        // SAFETY: raise(3) is async-signal-safe.
        unsafe { libc::raise(signal) };
    }
}

/// One log line in the log plugin's format (UTC):
/// `[YYYY-MM-DD][HH:MM:SS][target][ERROR] message`. No allocation: this runs
/// in signal context. Returns the length written.
fn format_line(buf: &mut [u8], unix_secs: i64, signal: c_int, thread: &[u8]) -> usize {
    let name = SIGNALS
        .iter()
        .find(|(s, _)| *s == signal)
        .map_or("signal", |(_, n)| n);
    let (date, time) = (unix_secs.div_euclid(86_400), unix_secs.rem_euclid(86_400));
    let (year, month, day) = civil_from_days(date);
    let mut w = Writer { buf, len: 0 };
    w.put(b"[");
    w.num(year, 4);
    w.put(b"-");
    w.num(month, 2);
    w.put(b"-");
    w.num(day, 2);
    w.put(b"][");
    w.num(time / 3600, 2);
    w.put(b":");
    w.num(time / 60 % 60, 2);
    w.put(b":");
    w.num(time % 60, 2);
    w.put(b"][owncord_client_lib::crash_log][ERROR] [crash] fatal signal ");
    w.put(name.as_bytes());
    w.put(b" (");
    w.num(signal.into(), 1);
    w.put(b") on thread '");
    w.put(thread);
    w.put(b"'\n");
    w.len
}

/// Days since 1970-01-01 to a proleptic Gregorian (year, month, day).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Appends to a fixed buffer, silently truncating.
struct Writer<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl Writer<'_> {
    fn put(&mut self, bytes: &[u8]) {
        let n = bytes.len().min(self.buf.len() - self.len);
        self.buf[self.len..self.len + n].copy_from_slice(&bytes[..n]);
        self.len += n;
    }

    /// `value` in decimal, zero-padded to `width` digits.
    fn num(&mut self, value: i64, width: usize) {
        let mut digits = [0u8; 20];
        let mut v = value.unsigned_abs();
        let mut n = 0;
        while v > 0 || n < width {
            digits[n] = b'0' + (v % 10) as u8;
            v /= 10;
            n += 1;
        }
        if value < 0 {
            self.put(b"-");
        }
        digits[..n].reverse();
        self.put(&digits[..n]);
    }
}

/// Xlib's `XErrorEvent`.
#[repr(C)]
struct XErrorEvent {
    kind: c_int,
    display: *mut c_void,
    resource_id: libc::c_ulong,
    serial: libc::c_ulong,
    error_code: u8,
    request_code: u8,
    minor_code: u8,
}

type XErrorHandler = unsafe extern "C" fn(*mut c_void, *mut XErrorEvent) -> c_int;
type XIoErrorHandler = unsafe extern "C" fn(*mut c_void) -> c_int;
type SetErrorHandler = unsafe extern "C" fn(Option<XErrorHandler>) -> Option<XErrorHandler>;
type SetIoErrorHandler = unsafe extern "C" fn(Option<XIoErrorHandler>) -> Option<XIoErrorHandler>;

/// The handlers ours replaced, as function addresses (0: none).
static PREVIOUS_X_ERROR: AtomicUsize = AtomicUsize::new(0);
static PREVIOUS_X_IO_ERROR: AtomicUsize = AtomicUsize::new(0);
/// X errors logged so far: GDK traps expected ones, so a session can see a
/// few; only the first ones are worth a line each.
static X_ERRORS_LOGGED: AtomicUsize = AtomicUsize::new(0);
const X_ERRORS_LOGGED_MAX: usize = 20;

fn install_x_handlers() {
    // SAFETY: dlsym on the global scope; the symbols, when present, are
    // Xlib's, with the signatures declared above.
    unsafe {
        let set_error = libc::dlsym(libc::RTLD_DEFAULT, c"XSetErrorHandler".as_ptr());
        let set_io_error = libc::dlsym(libc::RTLD_DEFAULT, c"XSetIOErrorHandler".as_ptr());
        if set_error.is_null() || set_io_error.is_null() {
            log::info!("[crash] no Xlib in this process; X error logging off");
            return;
        }
        let set_error: SetErrorHandler = std::mem::transmute(set_error);
        let set_io_error: SetIoErrorHandler = std::mem::transmute(set_io_error);
        let previous = set_error(Some(on_x_error));
        PREVIOUS_X_ERROR.store(previous.map_or(0, |f| f as usize), Ordering::Release);
        let previous = set_io_error(Some(on_x_io_error));
        PREVIOUS_X_IO_ERROR.store(previous.map_or(0, |f| f as usize), Ordering::Release);
    }
}

unsafe extern "C" fn on_x_error(display: *mut c_void, event: *mut XErrorEvent) -> c_int {
    if !event.is_null() && X_ERRORS_LOGGED.fetch_add(1, Ordering::Relaxed) < X_ERRORS_LOGGED_MAX {
        let e = unsafe { &*event };
        log::warn!(
            "[crash] X error {} on request {}.{} (serial {}, resource {:#x}); GDK exits on one it did not expect",
            e.error_code,
            e.request_code,
            e.minor_code,
            e.serial,
            e.resource_id
        );
        log::logger().flush();
    }
    match PREVIOUS_X_ERROR.load(Ordering::Acquire) {
        0 => 0,
        f => unsafe { std::mem::transmute::<usize, XErrorHandler>(f)(display, event) },
    }
}

unsafe extern "C" fn on_x_io_error(display: *mut c_void) -> c_int {
    log::error!("[crash] lost the connection to the X server; the process exits");
    log::logger().flush();
    match PREVIOUS_X_IO_ERROR.load(Ordering::Acquire) {
        0 => 0,
        f => unsafe { std::mem::transmute::<usize, XIoErrorHandler>(f)(display) },
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // the test plants the log file directly
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::Command;

    const CHILD: &str = "OWNCORD_CRASH_LOG_CHILD";

    /// Runs only as the child of `a_fault_is_logged_and_still_kills_the_process`:
    /// install the handlers, then fault the way a native library would.
    #[test]
    fn child_faults_with_handlers_installed() {
        let Some(path) = std::env::var_os(CHILD) else {
            return;
        };
        std::thread::Builder::new()
            .name("owncord-screen".into())
            .spawn(move || {
                install(Path::new(&path));
                // SAFETY: deliberately not safe; this child exists to die of it.
                unsafe { std::ptr::null_mut::<u8>().write_volatile(1) };
            })
            .unwrap()
            .join()
            .ok();
    }

    #[test]
    fn a_fault_is_logged_and_still_kills_the_process() {
        let dir = std::env::temp_dir().join(format!("owncord-crash-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("owncord-client.log");
        std::fs::write(&log, "[2026-10-02][16:27:19][x][INFO] before\n").unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "crash_log::tests::child_faults_with_handlers_installed",
                "--test-threads=1",
            ])
            .env(CHILD, &log)
            .status()
            .unwrap();
        let text = std::fs::read_to_string(&log).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        // The exit status is untouched: the default action still runs, so a
        // core dump and the desktop's crash reporter see the real signal.
        assert_eq!(status.signal(), Some(libc::SIGSEGV), "{status:?}");
        let line = text.lines().nth(1).unwrap_or_default();
        assert!(
            line.contains("[owncord_client_lib::crash_log][ERROR] [crash] fatal signal SIGSEGV")
                && line.contains("thread 'owncord-screen'"),
            "{text}"
        );
    }

    static CHAINED: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn previous(_: *mut c_void, event: *mut XErrorEvent) -> c_int {
        CHAINED.store(unsafe { (*event).error_code }.into(), Ordering::SeqCst);
        7
    }

    /// GDK's handler decides what an X error means (most are trapped and
    /// expected); ours only adds a line, then hands the error on unchanged.
    #[test]
    fn x_errors_chain_to_the_handler_they_replaced() {
        PREVIOUS_X_ERROR.store(previous as XErrorHandler as usize, Ordering::Release);
        let mut event = XErrorEvent {
            kind: 0,
            display: std::ptr::null_mut(),
            resource_id: 0x4200001,
            serial: 99,
            error_code: 3, // BadWindow
            request_code: 20,
            minor_code: 0,
        };
        let result = unsafe { on_x_error(std::ptr::null_mut(), &mut event) };
        PREVIOUS_X_ERROR.store(0, Ordering::Release);
        assert_eq!(result, 7);
        assert_eq!(CHAINED.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn lines_match_the_log_plugins_utc_format() {
        let mut buf = [0u8; 256];
        // 2026-10-02T16:27:19Z
        let n = format_line(&mut buf, 1_790_958_439, libc::SIGABRT, b"owncord-screen");
        assert_eq!(
            std::str::from_utf8(&buf[..n]).unwrap(),
            "[2026-10-02][16:27:19][owncord_client_lib::crash_log][ERROR] [crash] fatal signal SIGABRT (6) on thread 'owncord-screen'\n"
        );
    }
}
