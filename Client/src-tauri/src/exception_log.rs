//! Last words for a native crash (Windows).
//!
//! A panic reaches the log through `diagnostics::install_panic_hook`, but a
//! crash in native code does not: an access violation in a driver or a
//! library, a C++ exception nothing caught, a stack overflow. [`install`]
//! adds an unhandled-exception filter that writes one line to the native log
//! (exception code, faulting module and offset, thread), in the log plugin's
//! format, then hands the exception on to the filter it replaced, or to
//! Windows, so Windows Error Reporting and its Application Error record are
//! unchanged.
//!
//! The filter runs in a crashing process, possibly with a corrupt heap, a
//! held loader lock or little stack left, so it takes no lock and allocates
//! nothing it can avoid: the log file is opened ahead of time (at install,
//! and again by [`follow_rotation`] after the log plugin rotates it), and the
//! filter only formats into a fixed stack buffer and writes once. The faulting module is looked up through the
//! loader except for a stack overflow or heap corruption, where the raw
//! address is logged instead. A crash inside the filter itself cannot loop: a
//! second entry skips straight to the hand-over.
//!
//! A fast fail (`__fastfail`, which `abort` and stack-buffer checks use)
//! skips every filter by design; the next start reads that crash from the
//! event log instead (`system_crash_report`). Setting
//! `OWNCORD_EXCEPTION_LOG=off` leaves the filter out, should it ever clash
//! with another crash handler.
use crate::crash_line::{exception_name, put_timestamp, Writer};

/// One line in the log plugin's format (UTC):
/// `[YYYY-MM-DD][HH:MM:SS][target][ERROR] [crash] …`. No allocation: this
/// runs inside the exception filter. Returns the length written.
fn format_line(
    buf: &mut [u8],
    unix_secs: i64,
    code: u32,
    module: &[u8],
    offset: u64,
    thread: Option<u32>,
) -> usize {
    let mut w = Writer::new(buf);
    put_timestamp(&mut w, unix_secs);
    w.put(b"[owncord_client_lib::exception_log][ERROR] [crash] unhandled exception ");
    w.hex(u64::from(code), 8);
    w.put(b" (");
    w.put(exception_name(code).as_bytes());
    w.put(b") in ");
    if module.is_empty() {
        w.put(b"an unknown module at ");
        w.hex(offset, 1);
    } else {
        w.put(module);
        w.put(b"+");
        w.hex(offset, 1);
    }
    match thread {
        None => w.put(b" on the main thread"),
        Some(id) => {
            w.put(b" on thread ");
            w.num(i64::from(id), 1);
        }
    }
    w.put(b"\n");
    w.len()
}

/// The file name of a module path, as ASCII (anything else as `?`), into
/// `out`; the length written. No allocation.
fn module_file_name(path: &[u16], out: &mut [u8]) -> usize {
    let start = path
        .iter()
        .rposition(|&c| c == u16::from(b'\\') || c == u16::from(b'/'))
        .map_or(0, |i| i + 1);
    let mut n = 0;
    for &c in &path[start..] {
        if n == out.len() {
            break;
        }
        out[n] = u8::try_from(c)
            .ok()
            .filter(u8::is_ascii_graphic)
            .unwrap_or(b'?');
        n += 1;
    }
    n
}

#[cfg(windows)]
pub use filter::{follow_rotation, install};

#[cfg(windows)]
mod filter {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicUsize, Ordering};
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HANDLE, HMODULE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, WriteFile, BY_HANDLE_FILE_INFORMATION,
        FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_ALWAYS,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetUnhandledExceptionFilter, EXCEPTION_POINTERS, LPTOP_LEVEL_EXCEPTION_FILTER,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;

    use super::{format_line, module_file_name};

    /// Hand the exception on to the next handler, finally Windows Error
    /// Reporting.
    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
    /// FILETIME of 1970-01-01, in 100 ns units since 1601.
    const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

    /// The native log file, opened for appending at install (null: none).
    static LOG_FILE: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
    /// The log file's path, NUL-terminated, to reopen after a rotation.
    static LOG_PATH: OnceLock<Vec<u16>> = OnceLock::new();
    /// Codes whose module lookup could fault or block again: the loader may
    /// need stack or a heap the crash has used up or broken.
    const NO_LOOKUP: [u32; 2] = [0xC000_00FD, 0xC000_0374];
    /// The filter ours replaced, as a function address (0: none).
    static PREVIOUS: AtomicUsize = AtomicUsize::new(0);
    /// Set on the filter's first entry: a second (a crash inside it, or a
    /// second thread crashing at once) only hands on.
    static ENTERED: AtomicBool = AtomicBool::new(false);
    /// The thread that installed the filter: the app's main thread.
    static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);

    /// Install the filter. Once per process, on the main thread; `log_file`
    /// is the log plugin's file.
    pub fn install(log_file: &Path) {
        if std::env::var("OWNCORD_EXCEPTION_LOG").is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
            log::info!("[crash] exception filter off (OWNCORD_EXCEPTION_LOG=off)");
            return;
        }
        if !LOG_FILE.load(Ordering::SeqCst).is_null() {
            return;
        }
        let wide: Vec<u16> = log_file
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let Some(file) = open_append(&wide) else {
            log::warn!("[crash] exception filter off: the log file did not open");
            return;
        };
        let _ = LOG_PATH.set(wide);
        LOG_FILE.store(file, Ordering::SeqCst);
        // SAFETY: plain Win32 calls; the filter only formats into stack
        // buffers.
        unsafe {
            MAIN_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            let previous = SetUnhandledExceptionFilter(Some(on_unhandled_exception));
            PREVIOUS.store(previous.map_or(0, |f| f as usize), Ordering::SeqCst);
        }
    }

    /// `path` (NUL-terminated) opened for appending, shared so the log
    /// plugin can keep writing and rename it.
    fn open_append(path: &[u16]) -> Option<HANDLE> {
        // SAFETY: a NUL-terminated wide path; the handle is checked.
        let file = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_APPEND_DATA,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        (file != INVALID_HANDLE_VALUE).then_some(file)
    }

    /// The volume and file index of an open file: which file it is, whatever
    /// its name now.
    fn identity(file: HANDLE) -> Option<(u32, u32, u32)> {
        // SAFETY: plain data filled by the call for a live handle.
        unsafe {
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            (GetFileInformationByHandle(file, &mut info) != 0).then_some((
                info.dwVolumeSerialNumber,
                info.nFileIndexHigh,
                info.nFileIndexLow,
            ))
        }
    }

    /// After the log plugin rotates the log (renames it and starts a new
    /// file), point the filter at the new file: the old one is deleted after
    /// a few rotations. Called off the crash path, on the exit watchdog's
    /// heartbeat. The replaced handle is left open, not closed, so a filter
    /// writing to it at that moment cannot hit a closed or reused handle; a
    /// rotation happens once per 10 MB of log.
    pub fn follow_rotation() {
        let current = LOG_FILE.load(Ordering::SeqCst);
        let Some(path) = LOG_PATH.get() else { return };
        if current.is_null() {
            return;
        }
        let Some(fresh) = open_append(path) else {
            return;
        };
        if identity(fresh).is_some() && identity(fresh) != identity(current) {
            LOG_FILE.store(fresh, Ordering::SeqCst);
        } else {
            // SAFETY: the probe handle this function opened.
            unsafe { CloseHandle(fresh) };
        }
    }

    unsafe extern "system" fn on_unhandled_exception(info: *const EXCEPTION_POINTERS) -> i32 {
        if !ENTERED.swap(true, Ordering::SeqCst) {
            // SAFETY: Windows passes the live exception record; null-checked.
            unsafe { write_line(info) };
        }
        match PREVIOUS.load(Ordering::SeqCst) {
            0 => EXCEPTION_CONTINUE_SEARCH,
            f => {
                // SAFETY: the address SetUnhandledExceptionFilter returned
                // for the filter ours replaced, with the same signature.
                let previous: LPTOP_LEVEL_EXCEPTION_FILTER =
                    unsafe { std::mem::transmute::<usize, LPTOP_LEVEL_EXCEPTION_FILTER>(f) };
                previous.map_or(EXCEPTION_CONTINUE_SEARCH, |f| unsafe { f(info) })
            }
        }
    }

    unsafe fn write_line(info: *const EXCEPTION_POINTERS) {
        let file = LOG_FILE.load(Ordering::SeqCst);
        if file.is_null() {
            return;
        }
        // SAFETY: every pointer is null-checked; the Win32 calls write only
        // into the stack buffers given.
        unsafe {
            let record = if info.is_null() {
                std::ptr::null()
            } else {
                (*info).ExceptionRecord.cast_const()
            };
            let (code, address) = if record.is_null() {
                (0u32, 0usize)
            } else {
                (
                    (*record).ExceptionCode as u32,
                    (*record).ExceptionAddress as usize,
                )
            };
            let mut module: HMODULE = std::ptr::null_mut();
            let mut name = [0u8; 64];
            let mut name_len = 0;
            let mut offset = address as u64;
            if !NO_LOOKUP.contains(&code)
                && GetModuleHandleExW(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                        | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    address as *const u16,
                    &mut module,
                ) != 0
            {
                let mut wide = [0u16; 260];
                let len = GetModuleFileNameW(module, wide.as_mut_ptr(), wide.len() as u32);
                name_len = module_file_name(&wide[..(len as usize).min(wide.len())], &mut name);
                offset = (address - module as usize) as u64;
            }
            let mut now = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            GetSystemTimeAsFileTime(&mut now);
            let ticks = (u64::from(now.dwHighDateTime) << 32) | u64::from(now.dwLowDateTime);
            let unix_secs = (ticks.saturating_sub(UNIX_EPOCH_FILETIME) / 10_000_000) as i64;
            let thread = GetCurrentThreadId();
            let thread = (thread != MAIN_THREAD.load(Ordering::SeqCst)).then_some(thread);
            let mut line = [0u8; 320];
            let len = format_line(
                &mut line,
                unix_secs,
                code,
                &name[..name_len],
                offset,
                thread,
            );
            let mut written = 0u32;
            WriteFile(
                file,
                line.as_ptr(),
                len as u32,
                &mut written,
                std::ptr::null_mut(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_match_the_log_plugins_utc_format() {
        let mut buf = [0u8; 320];
        // 2026-10-02T16:27:19Z
        let n = format_line(
            &mut buf,
            1_790_958_439,
            0xC000_0005,
            b"nvwgf2umx.dll",
            0x1A_2B3C,
            Some(4242),
        );
        assert_eq!(
            std::str::from_utf8(&buf[..n]).unwrap(),
            "[2026-10-02][16:27:19][owncord_client_lib::exception_log][ERROR] [crash] unhandled \
             exception 0xC0000005 (access violation) in nvwgf2umx.dll+0x1A2B3C on thread 4242\n"
        );
        let n = format_line(&mut buf, 1_790_958_439, 0xE06D_7363, b"", 0x7FF6_0000, None);
        assert!(std::str::from_utf8(&buf[..n]).unwrap().ends_with(
            "unhandled exception 0xE06D7363 (C++ exception) in an unknown module at \
             0x7FF60000 on the main thread\n"
        ));
    }

    #[test]
    fn a_line_never_overruns_its_buffer() {
        let mut buf = [0u8; 40];
        let n = format_line(
            &mut buf,
            0,
            0xC000_00FD,
            &[b'x'; 64],
            u64::MAX,
            Some(u32::MAX),
        );
        assert_eq!(n, 40);
    }

    #[test]
    fn module_names_drop_the_folder_and_non_ascii() {
        let path: Vec<u16> = r"C:\Users\Zoë\AppData\Local\OwnCord\WebView2Loader.dll"
            .encode_utf16()
            .collect();
        let mut out = [0u8; 64];
        let n = module_file_name(&path, &mut out);
        assert_eq!(&out[..n], b"WebView2Loader.dll");
        let odd: Vec<u16> = "dé.dll".encode_utf16().collect();
        let n = module_file_name(&odd, &mut out);
        assert_eq!(&out[..n], b"d?.dll");
        let mut short = [0u8; 4];
        assert_eq!(module_file_name(&odd, &mut short), 4);
    }
}
