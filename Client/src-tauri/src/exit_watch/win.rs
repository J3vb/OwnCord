//! The Windows side of `exit_watch`: memory and threads from the process
//! itself, WebView2's helper processes, the session, and the Application
//! event log for a run that ended without a word.
use tauri::Runtime;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
    ICoreWebView2ProcessFailedEventArgs3, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_REASON,
};
use webview2_com::{ExecuteScriptCompletedHandler, ProcessFailedEventHandler};
use windows_core::{Interface, PWSTR};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::webview_failure::{
    failure_text, Failure, RENDER_PROCESS_EXITED, RENDER_PROCESS_UNRESPONSIVE,
};

/// What can end a run without a word on Windows, for the next start's report.
pub(super) const SILENT_ENDINGS: &str =
    "End task in Task Manager, Windows closing a window it judged not responding, \
     a crash that skipped the crash filter, sign-out or shutdown";

/// Ask the Application event log about runs that ended silently.
pub(super) fn report_ended(runs: Vec<crate::system_crash_report::EndedRun>) {
    crate::system_crash_report::report(runs);
}

/// Windows captures run inside WebView2, whose failures are logged as they
/// happen: the run file has no capture line here.
pub(super) fn captures_text() -> Option<String> {
    None
}

/// Whether `pid` is a live process with this process's image name.
pub(super) fn is_owncord_running(pid: u32) -> bool {
    let (Some(theirs), Some(ours)) = (image_name(pid), own_image_name()) else {
        return false;
    };
    theirs.eq_ignore_ascii_case(&ours)
}

fn own_image_name() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.file_name()?.to_string_lossy().into_owned())
}

/// The image file name of live process `pid`, or `None` when it is gone or
/// cannot be opened.
fn image_name(pid: u32) -> Option<String> {
    // SAFETY: plain Win32 calls on a handle this function opens and closes.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut code = 0u32;
        let alive = GetExitCodeProcess(process, &mut code) != 0 && code == STILL_ACTIVE as u32;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(process);
        if !alive || !named {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(str::to_string)
    }
}

/// Working set, its peak, committed memory and threads of this process.
pub(super) fn memory_text() -> String {
    let counters = memory_counters();
    format_memory(
        counters.map(|c| c.WorkingSetSize as u64),
        counters.map(|c| c.PeakWorkingSetSize as u64),
        counters.map(|c| c.PagefileUsage as u64),
        own_thread_count(),
    )
}

fn format_memory(
    working: Option<u64>,
    peak: Option<u64>,
    commit: Option<u64>,
    threads: Option<u32>,
) -> String {
    let mb =
        |bytes: Option<u64>| bytes.map_or("unknown".to_string(), |b| format!("{} MB", b >> 20));
    format!(
        "memory={}, memory_peak={}, commit={}, threads={}",
        mb(working),
        mb(peak),
        mb(commit),
        threads.map_or("unknown".to_string(), |t| t.to_string())
    )
}

pub(super) fn resident_mb() -> Option<u64> {
    memory_counters().map(|c| c.WorkingSetSize as u64 >> 20)
}

fn memory_counters() -> Option<PROCESS_MEMORY_COUNTERS> {
    // SAFETY: the counters struct is plain data sized by `cb`; the
    // pseudo-handle of the current process needs no closing.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        counters.cb = size;
        (K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) != 0).then_some(counters)
    }
}

/// This process's thread count, from a process snapshot.
fn own_thread_count() -> Option<u32> {
    let own = std::process::id();
    // SAFETY: Toolhelp snapshot walk over a handle this function closes.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ProcessID == own {
                found = Some(entry.cntThreads);
                break;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        found
    }
}

/// The Windows build, installed RAM and WebView2 runtime, once at startup.
pub(super) fn log_session() {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::{
        GlobalMemoryStatusEx, MEMORYSTATUSEX, OSVERSIONINFOW,
    };
    // SAFETY: both structs are plain data, sized before the call.
    let (version, ram) = unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        let version = (RtlGetVersion(&mut info) == 0).then(|| {
            format!(
                "{}.{}.{}",
                info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
            )
        });
        let mut memory: MEMORYSTATUSEX = std::mem::zeroed();
        memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        let filled = GlobalMemoryStatusEx(&mut memory) != 0;
        let ram = filled.then_some(memory.ullTotalPhys >> 20);
        (version, ram)
    };
    log::info!(
        "[startup] session: Windows {}, RAM={}, WebView2 {}",
        version.unwrap_or_else(|| "unknown".into()),
        ram.map_or("unknown".to_string(), |mb| format!("{mb} MB")),
        webview2_version().unwrap_or_else(|| "unknown".into()),
    );
}

/// The installed WebView2 runtime's version.
fn webview2_version() -> Option<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    let mut version = PWSTR::null();
    // SAFETY: a null folder asks for the installed runtime; the string it
    // returns is CoTaskMem-allocated and freed by `take_pwstr`.
    unsafe {
        GetAvailableCoreWebView2BrowserVersionString(windows_core::PCWSTR::null(), &mut version)
            .ok()?;
    }
    if version.is_null() {
        return None;
    }
    Some(webview2_com::take_pwstr(version))
}

/// Log WebView2's helper process failures, and probe the page while it does
/// not answer.
pub(super) fn watch_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let watched = window.with_webview(|webview| {
        let handler = ProcessFailedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                on_process_failed(&args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: COM calls on the live controller, on the webview's own thread.
        let added = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.add_ProcessFailed(&handler, &mut token))
        };
        if let Err(e) = added {
            log::warn!("[exit] webview processes not watched: {e}");
        }
    });
    if let Err(e) = watched {
        log::warn!("[exit] webview processes not watched: {e}");
        return;
    }
    let probed = window.clone();
    super::set_webview_probe(Box::new(move || probe(&probed)));
}

fn on_process_failed(args: &ICoreWebView2ProcessFailedEventArgs) {
    let failure = read_failure(args);
    if failure.kind == RENDER_PROCESS_UNRESPONSIVE {
        super::webview_stopped_answering("WebView2 reports the page script busy or stuck");
        return;
    }
    if failure.kind == RENDER_PROCESS_EXITED {
        // The page is gone with its process: whatever hang it had is over.
        super::webview_answers();
    }
    log::error!("{}", failure_text(&failure));
    log::logger().flush();
}

fn read_failure(args: &ICoreWebView2ProcessFailedEventArgs) -> Failure {
    let mut failure = Failure::default();
    // SAFETY: COM getters on the event's live arguments, on the webview's
    // thread; strings are CoTaskMem-allocated and freed by `take_pwstr`.
    unsafe {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
        if args.ProcessFailedKind(&mut kind).is_ok() {
            failure.kind = kind.0;
        }
        if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(-1);
            failure.reason = args2.Reason(&mut reason).ok().map(|()| reason.0);
            let mut code = 0i32;
            failure.exit_code = args2.ExitCode(&mut code).ok().map(|()| code);
            failure.description = owned_string(|p| args2.ProcessDescription(p));
        }
        if let Ok(args3) = args.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
            failure.module = owned_string(|p| args3.FailureSourceModulePath(p));
        }
    }
    failure
}

/// A string a WebView2 getter allocates, or empty when it fails.
fn owned_string(get: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> String {
    let mut text = PWSTR::null();
    if get(&mut text).is_err() || text.is_null() {
        return String::new();
    }
    webview2_com::take_pwstr(text)
}

/// Ask the page to run an empty script: its answer means it runs scripts
/// again.
fn probe<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let asked = window.with_webview(|webview| {
        let done = ExecuteScriptCompletedHandler::create(Box::new(|result, _| {
            super::webview_probe_done(result.is_ok());
            Ok(())
        }));
        // SAFETY: COM calls on the live controller, on the webview's own thread.
        let sent = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.ExecuteScript(&windows_core::HSTRING::from("0"), &done))
        };
        if sent.is_err() {
            super::webview_probe_done(false);
        }
    });
    if asked.is_err() {
        super::webview_probe_done(false);
    }
}
