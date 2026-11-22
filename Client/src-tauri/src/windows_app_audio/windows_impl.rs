use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use windows::core::Interface as _;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient,
    IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::Foundation::{FILETIME, INVALID_HANDLE_VALUE, LPARAM};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible,
};

use super::*;

pub use super::windows_music::{list_apps, resolve_music_pid};

/// How long COM may take to activate the process loopback client.
const ACTIVATION_TIMEOUT_MS: u32 = 5_000;

// -- availability and window resolution ---------------------------------

pub fn available() -> bool {
    // SAFETY: OSVERSIONINFOW is plain data; RtlGetVersion fills it when
    // dwOSVersionInfoSize is set and never fails for this structure.
    let build = unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        if RtlGetVersion(&mut info) != 0 {
            return false;
        }
        info.dwBuildNumber
    };
    build_supports_process_loopback(build)
}

/// The process that owns a window; 0 when the handle is dead.
fn window_owner(hwnd: *mut c_void) -> u32 {
    let mut pid = 0u32;
    // SAFETY: GetWindowThreadProcessId accepts any handle value and leaves
    // `pid`, a valid out pointer, at 0 for a dead one.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid
}

/// A window's class name; empty when it cannot be read.
fn window_class(hwnd: *mut c_void) -> String {
    // A class name has at most 256 characters.
    let mut buf = [0u16; 257];
    // SAFETY: the buffer's length is passed with it; a dead handle gives 0.
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..len.clamp(0, 256) as usize])
}

unsafe extern "system" fn collect_child(
    hwnd: *mut c_void,
    lparam: LPARAM,
) -> windows_sys::core::BOOL {
    // SAFETY: lparam is the &mut Vec that child_windows passes for the
    // duration of its EnumChildWindows call.
    let children = unsafe { &mut *(lparam as *mut Vec<(String, u32)>) };
    children.push((window_class(hwnd), window_owner(hwnd)));
    1
}

/// Every window inside `hwnd`, as (class name, owner pid).
fn child_windows(hwnd: *mut c_void) -> Vec<(String, u32)> {
    let mut children = Vec::new();
    // SAFETY: `collect_child` uses `children` only through lparam while
    // EnumChildWindows runs.
    unsafe {
        EnumChildWindows(
            hwnd,
            Some(collect_child),
            &mut children as *mut Vec<(String, u32)> as LPARAM,
        );
    }
    children
}

/// The process whose sound window `hwnd` (owned by `pid`) plays: see
/// [`window_sound_pid`].
fn sound_pid(hwnd: *mut c_void, pid: u32) -> Option<u32> {
    window_sound_pid(&window_class(hwnd), pid, || child_windows(hwnd))
}

/// The process whose sound a live window handle plays.
fn hwnd_pid(hwnd: u64) -> Option<u32> {
    let handle = usize::try_from(hwnd).ok()? as *mut c_void;
    // SAFETY: IsWindow accepts any handle value and reports a dead one as 0.
    if unsafe { IsWindow(handle) } == 0 {
        return None;
    }
    match window_owner(handle) {
        0 => None,
        pid => sound_pid(handle, pid),
    }
}

unsafe extern "system" fn collect_window(
    hwnd: *mut c_void,
    lparam: LPARAM,
) -> windows_sys::core::BOOL {
    // SAFETY: lparam is the &mut Vec that enumerate_windows passes for the
    // duration of its EnumWindows call.
    let windows = unsafe { &mut *(lparam as *mut Vec<WindowInfo>) };
    // A Store app's frame whose app is not found is left out, so a title
    // match on it reports the app as not found.
    let Some(pid) = sound_pid(hwnd, window_owner(hwnd)) else {
        return 1;
    };
    // SAFETY: plain Win32 queries on a handle EnumWindows just gave us.
    // The buffer is sized from the title length plus the terminator and
    // its length is passed alongside it, so a long title is not cut.
    let (visible, buf, len) = unsafe {
        let want = GetWindowTextLengthW(hwnd).clamp(0, 32_768) as usize;
        let mut buf = vec![0u16; want + 1];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        (IsWindowVisible(hwnd) != 0, buf, len)
    };
    windows.push(WindowInfo {
        hwnd: hwnd as usize as u64,
        pid,
        title: String::from_utf16_lossy(&buf[..len.max(0) as usize]),
        visible,
    });
    1
}

fn enumerate_windows() -> Vec<WindowInfo> {
    let mut windows = Vec::new();
    // SAFETY: `collect_window` uses `windows` only through lparam while
    // EnumWindows runs.
    unsafe {
        EnumWindows(
            Some(collect_window),
            &mut windows as *mut Vec<WindowInfo> as LPARAM,
        );
    }
    windows
}

/// pid -> parent pid for every process, from a Toolhelp snapshot.
pub(super) fn parent_map() -> Result<HashMap<u32, u32>, String> {
    // SAFETY: the snapshot handle is checked, used only by the two
    // Process32 calls below with a correctly sized entry, and closed.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return Err("internal".into());
        }
        let mut parents = HashMap::new();
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        windows_sys::Win32::Foundation::CloseHandle(snapshot);
        Ok(parents)
    }
}

/// When process `pid` was created, in FILETIME ticks; `None` when it cannot
/// be opened (gone, or protected).
fn process_created(pid: u32) -> Option<u64> {
    // SAFETY: the handle is checked, used for one query with valid out
    // pointers, and closed.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let read = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        windows_sys::Win32::Foundation::CloseHandle(process);
        read.then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

/// OwnCord's own process tree and the processes it descends from, by
/// `parents`. Creation times are read only for the processes the two walks
/// reach, each once.
pub(super) fn own_family(parents: &HashMap<u32, u32>) -> (HashSet<u32>, HashSet<u32>) {
    let read: RefCell<HashMap<u32, Option<u64>>> = RefCell::default();
    let created = |pid: u32| {
        *read
            .borrow_mut()
            .entry(pid)
            .or_insert_with(|| process_created(pid))
    };
    let me = std::process::id();
    (
        own_process_tree(me, parents, created),
        own_process_ancestors(me, parents, created),
    )
}

/// The process to capture for a shared window's label.
pub fn resolve_pid(label: &str) -> Result<u32, String> {
    let (own, ancestors) = own_family(&parent_map()?);
    pick_target_pid(label, hwnd_pid, &enumerate_windows(), &own, &ancestors)
        .map_err(|e| e.code().to_string())
}

// -- process loopback activation -----------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum Wait {
    Signalled,
    TimedOut,
    Failed,
}

/// A Win32 event handle, closed on drop. Event handles are usable from any
/// thread.
struct OwnedEvent(HANDLE);

// SAFETY: a kernel event handle carries no thread affinity.
unsafe impl Send for OwnedEvent {}
// SAFETY: as above; Set/Wait on it are thread-safe.
unsafe impl Sync for OwnedEvent {}

impl OwnedEvent {
    fn new() -> Result<Self, String> {
        // SAFETY: an unnamed, auto-reset, initially unsignalled event.
        unsafe { CreateEventW(None, false, false, None) }
            .map(Self)
            .map_err(|e| format!("CreateEventW: {e}"))
    }

    /// Wait up to `ms`.
    fn wait(&self, ms: u32) -> Wait {
        // SAFETY: the handle is a live event owned by `self`.
        let result = unsafe { WaitForSingleObject(self.0, ms) };
        if result == WAIT_OBJECT_0 {
            Wait::Signalled
        } else if result == WAIT_TIMEOUT {
            Wait::TimedOut
        } else {
            Wait::Failed
        }
    }
}

impl Drop for OwnedEvent {
    fn drop(&mut self) {
        // SAFETY: closing the handle this value owns, once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// `windows` 0.58 has no `_Impl` trait for the activation completion
// handler, and its `implement` macro would bind to this crate's `windows-core`
// (0.62) anyway. So the handler is declared with `windows-core` 0.62's own
// `interface` and `implement`, then handed over as a raw COM pointer: the
// IID and vtable layout are the Windows ones, so the call below cannot
// tell the difference.
#[windows_core::interface("41d949ab-9862-444a-80f6-c261334da5eb")]
unsafe trait IActivateCompletion: windows_core::IUnknown {
    unsafe fn ActivateCompleted(&self, operation: *mut c_void) -> windows_core::HRESULT;
}

// ActivateAudioInterfaceAsync calls the handler on an MTA thread and
// refuses one that does not answer QueryInterface(IAgileObject).
#[windows_core::interface("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")]
unsafe trait IAgile: windows_core::IUnknown {}

#[windows_core::implement(IActivateCompletion, IAgile)]
struct CompletionHandler {
    event: Arc<OwnedEvent>,
}

impl IActivateCompletion_Impl for CompletionHandler_Impl {
    unsafe fn ActivateCompleted(&self, _operation: *mut c_void) -> windows_core::HRESULT {
        // SAFETY: the event outlives the activation: the waiter holds the
        // other Arc until it has read the result.
        match unsafe { SetEvent(self.event.0) } {
            Ok(()) => windows_core::HRESULT(0),
            Err(e) => windows_core::HRESULT(e.code().0),
        }
    }
}

impl IAgile_Impl for CompletionHandler_Impl {}

/// A PROPVARIANT of type VT_BLOB, laid out as the C struct. Built by hand
/// because `windows` offers no safe blob constructor, and the blob points at
/// our own stack bytes, which nothing may hand to PropVariantClear.
#[repr(C)]
struct BlobPropVariant {
    vt: u16,
    reserved: [u16; 3],
    cb_size: u32,
    blob: *mut u8,
}

// The hand-built blob must be exactly the size of the real PROPVARIANT.
const _: () = assert!(std::mem::size_of::<BlobPropVariant>() == std::mem::size_of::<PROPVARIANT>());

struct Client {
    audio: IAudioClient,
    capture: IAudioCaptureClient,
    ready: OwnedEvent,
}

fn wave_format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * CHANNELS as u32 * 4,
        nBlockAlign: CHANNELS as u16 * 4,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

/// Activate the process loopback client for `pid`'s process tree and
/// start it. Must run on an MTA thread.
fn open_client(pid: u32) -> Result<Client, String> {
    let done = Arc::new(OwnedEvent::new()?);
    let handler: IActivateCompletion = CompletionHandler {
        event: done.clone(),
    }
    .into();
    // SAFETY: `into_raw` hands over one reference, which the windows-typed
    // wrapper now owns and releases; the interface is the same COM one.
    let handler = unsafe {
        IActivateAudioInterfaceCompletionHandler::from_raw(windows_core::Interface::into_raw(
            handler,
        ))
    };
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let blob = BlobPropVariant {
        vt: VT_BLOB.0,
        reserved: [0; 3],
        cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        blob: &mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS as *mut u8,
    };
    // SAFETY: `blob` has the PROPVARIANT layout and, with `params`, lives
    // past the call; the handler is a live agile COM object.
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&blob as *const BlobPropVariant as *const PROPVARIANT),
            &handler,
        )
    }
    .map_err(|e| activation_failed("ActivateAudioInterfaceAsync", &e))?;
    // A completion that arrives after this timeout is expected and
    // harmless: the handler only sets `done`, which it keeps alive through
    // its own Arc, and nothing reads the operation any more.
    let waited = done.wait(ACTIVATION_TIMEOUT_MS);
    if waited != Wait::Signalled {
        log::warn!("[app_audio] activation did not complete: {waited:?}");
        return Err("activation_failed".into());
    }
    let mut result = windows::core::HRESULT(0);
    let mut unknown = None;
    // SAFETY: the operation completed (the event fired), and both out
    // pointers are valid for the call.
    unsafe { operation.GetActivateResult(&mut result, &mut unknown) }
        .map_err(|e| activation_failed("GetActivateResult", &e))?;
    result
        .ok()
        .map_err(|e| activation_failed("activation result", &e))?;
    let audio: IAudioClient = unknown
        .ok_or_else(|| "activation_failed".to_string())?
        .cast()
        .map_err(|e| activation_failed("IAudioClient cast", &e))?;

    let format = wave_format();
    // SAFETY: `format` is a valid WAVEFORMATEX for the call. The client is
    // new and un-initialised. GetMixFormat is not implemented for a
    // process loopback client, hence the explicit format.
    unsafe {
        audio.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            1_000_000, // 100 ms in 100 ns units
            0,
            &format,
            None,
        )
    }
    .map_err(|e| activation_failed("Initialize", &e))?;
    let ready = OwnedEvent::new()?;
    // SAFETY: the event is live and outlives the client (both in `Client`).
    unsafe { audio.SetEventHandle(ready.0) }
        .map_err(|e| activation_failed("SetEventHandle", &e))?;
    // SAFETY: the client is initialised.
    let capture: IAudioCaptureClient =
        unsafe { audio.GetService() }.map_err(|e| activation_failed("GetService", &e))?;
    // SAFETY: the client is initialised and has its event.
    unsafe { audio.Start() }.map_err(|e| activation_failed("Start", &e))?;
    Ok(Client {
        audio,
        capture,
        ready,
    })
}

fn activation_failed(step: &str, error: &windows::core::Error) -> String {
    log::warn!("[app_audio] {step}: {error}");
    "activation_failed".into()
}

// -- capture thread ---------------------------------------------------------

/// Start the capture thread and wait until its client is running (or has
/// failed). The thread is MTA: COM objects never leave it.
pub fn spawn_capture(pid: u32, shared: Arc<Shared>) -> Result<std::thread::JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("app-audio-capture".into())
        .spawn(move || capture_main(pid, &shared, ready_tx))
        .map_err(|e| {
            log::warn!("[app_audio] spawn capture thread: {e}");
            "internal".to_string()
        })?;
    // The activation is bounded, so this wait is too.
    match ready_rx.recv_timeout(Duration::from_millis(
        u64::from(ACTIVATION_TIMEOUT_MS) + 2_000,
    )) {
        Ok(Ok(())) => Ok(thread),
        Ok(Err(code)) => {
            let _ = thread.join();
            Err(code)
        }
        Err(_) => Err("activation_failed".into()),
    }
}

fn capture_main(pid: u32, shared: &Shared, ready: mpsc::Sender<Result<(), String>>) {
    // SAFETY: balanced with CoUninitialize below when it succeeded.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if com.is_err() {
        log::warn!("[app_audio] CoInitializeEx failed: {com:?}");
        let _ = ready.send(Err("internal".into()));
        return;
    }
    match open_client(pid) {
        Ok(client) => {
            let _ = ready.send(Ok(()));
            capture_loop(&client, shared);
            // SAFETY: the client was started above.
            if let Err(e) = unsafe { client.audio.Stop() } {
                log::debug!("[app_audio] Stop: {e}");
            }
        }
        Err(code) => {
            let _ = ready.send(Err(code));
        }
    }
    // SAFETY: matches the successful CoInitializeEx above; every COM
    // object of this thread has been dropped with `client`.
    unsafe { CoUninitialize() };
}

/// Drain the client into 10 ms frames until told to stop. Wakes at least
/// every STOP_POLL, so the stop flag is seen within 100 ms.
fn capture_loop(client: &Client, shared: &Shared) {
    let mut framer = Framer::default();
    while !shared.stopped() {
        match client.ready.wait(STOP_POLL.as_millis() as u32) {
            Wait::Signalled => {}
            Wait::TimedOut => continue,
            Wait::Failed => {
                log::warn!("[app_audio] waiting for audio failed, stopping");
                break;
            }
        }
        if let Err(e) = drain(client, &mut framer, shared) {
            log::warn!("[app_audio] capture ended: {e}");
            break;
        }
    }
    shared.request_stop();
}

fn drain(client: &Client, framer: &mut Framer, shared: &Shared) -> windows::core::Result<()> {
    loop {
        // SAFETY: the capture client belongs to this thread and is started.
        let pending = unsafe { client.capture.GetNextPacketSize() }?;
        if pending == 0 {
            return Ok(());
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        // SAFETY: all out pointers are valid for the call.
        unsafe {
            client
                .capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
        }?;
        let emit = |frame| shared.push_frame(frame);
        if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
            framer.push_silence(frames as usize, emit);
        } else {
            // SAFETY: GetBuffer returned `frames` frames of the 2-channel
            // f32 format we initialised with; the slice is used before
            // ReleaseBuffer and copied out by `push`. WASAPI buffers for
            // 32-bit float are 4-byte aligned.
            let samples = unsafe {
                std::slice::from_raw_parts(data as *const f32, frames as usize * CHANNELS)
            };
            framer.push(samples, emit);
        }
        // SAFETY: releases exactly the frames GetBuffer returned.
        unsafe { client.capture.ReleaseBuffer(frames) }?;
    }
}
