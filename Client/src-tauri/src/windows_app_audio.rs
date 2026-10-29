//! Windows per-app share audio (WP 6.7a): capture one application's sound with
//! WASAPI process loopback and stream it to the webview.
//!
//! WebView2 gives a shared *window* no sound (only a whole screen has system
//! loopback), so after the page learns which window the user picked it asks
//! this module to find the owning process, capture that process tree's audio
//! and serve it as 10 ms frames over a per-capture loopback WebSocket, the same
//! shape as the Linux frame socket (`native_voice/video.rs`): a random 256-bit
//! token in the path, one client, closed with the capture. Tauri IPC never
//! carries audio.
//!
//! The three commands exist on every target, so the TypeScript contract has one
//! shape: off Windows `app_audio_available` is `false` and `start_app_audio`
//! is `Err("unavailable")`. The pure parts (label parsing, picking the target
//! process, frame packing, the backlog policy, the socket server) build and are
//! tested everywhere; only the Win32/COM capture is `cfg(windows)`.
//!
//! Error codes of `start_app_audio`: `unavailable`, `not_window`,
//! `own_window`, `ancestor`, `not_found`, `ambiguous`, `activation_failed`,
//! `superseded` (a newer start or a stop overtook this one), `internal`.
//!
//! Unverified on real hardware (no Windows machine in the build environment):
//! which label WebView2 gives a window, and process-loopback activation on
//! every Windows build. See docs/plans/design/6.7-design.md.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

/// Frames are 10 ms of 48 kHz stereo: 480 sample frames, 960 f32 values.
pub const FRAME_FRAMES: usize = 480;
pub const CHANNELS: usize = 2;
pub const SAMPLE_RATE: u32 = 48_000;
const FRAME_SAMPLES: usize = FRAME_FRAMES * CHANNELS;
/// One message on the socket: interleaved little-endian f32.
pub const FRAME_BYTES: usize = FRAME_SAMPLES * 4;
/// The backlog the socket may hold before the oldest frame is dropped: 200 ms.
pub const MAX_BACKLOG_FRAMES: usize = 20;
/// The first Windows build with `PROCESS_LOOPBACK` (Windows 10 2004).
const MIN_BUILD: u32 = 19041;
/// The capture thread looks at its stop flag at least this often.
const STOP_POLL: Duration = Duration::from_millis(100);
/// A capture whose page never connects is stopped after this long.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------------------
// Pure, cross-platform logic
// ---------------------------------------------------------------------------

/// Whether a Windows build number has process loopback capture.
pub fn build_supports_process_loopback(build: u32) -> bool {
    build >= MIN_BUILD
}

/// `window:<n>:<m>` (Chromium's window source id) -> `n`, the HWND.
pub fn parse_window_label(label: &str) -> Option<u64> {
    let mut parts = label.strip_prefix("window:")?.split(':');
    let (hwnd, id) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if hwnd.is_empty() || !hwnd.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    hwnd.parse().ok()
}

/// One top-level window as `EnumWindows` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: u64,
    pub pid: u32,
    pub title: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveError {
    /// The window belongs to OwnCord's own process tree.
    OwnWindow,
    /// The window belongs to a process that OwnCord descends from (explorer,
    /// a terminal, a launcher). Its process tree contains OwnCord and the
    /// WebView2 renderer, so capturing it would echo the call to viewers.
    Ancestor,
    NotFound,
    /// Several windows share the title in different processes.
    Ambiguous,
}

impl ResolveError {
    pub fn code(self) -> &'static str {
        match self {
            Self::OwnWindow => "own_window",
            Self::Ancestor => "ancestor",
            Self::NotFound => "not_found",
            Self::Ambiguous => "ambiguous",
        }
    }
}

/// The process whose sound a shared window carries (design decision 1).
///
/// 1. A `window:<n>:<m>` label names HWND `n`: if `hwnd_pid(n)` finds a live
///    window, that is the answer, even when it turns out to be our own.
/// 2. Otherwise the label is a title: an exact match among visible windows
///    (a minimised window is still visible). One process wins even with
///    several windows; windows in different processes are ambiguous and we
///    give up rather than capture the wrong app.
///
/// The result is never in `own` (OwnCord's own process tree) nor in
/// `ancestors` (the processes OwnCord descends from): process loopback
/// includes the target's whole tree, which for an ancestor contains us.
pub fn pick_target_pid(
    label: &str,
    hwnd_pid: impl Fn(u64) -> Option<u32>,
    windows: &[WindowInfo],
    own: &HashSet<u32>,
    ancestors: &HashSet<u32>,
) -> Result<u32, ResolveError> {
    let checked = |pid: u32| {
        if own.contains(&pid) {
            Err(ResolveError::OwnWindow)
        } else if ancestors.contains(&pid) {
            Err(ResolveError::Ancestor)
        } else {
            Ok(pid)
        }
    };
    if let Some(pid) = parse_window_label(label).and_then(hwnd_pid) {
        return checked(pid);
    }
    if label.is_empty() {
        return Err(ResolveError::NotFound);
    }
    let mut pids = windows
        .iter()
        .filter(|w| w.visible && w.title == label)
        .map(|w| w.pid);
    let first = pids.next().ok_or(ResolveError::NotFound)?;
    if pids.any(|pid| pid != first) {
        return Err(ResolveError::Ambiguous);
    }
    checked(first)
}

/// The processes `own_pid` descends from (parent, grandparent, ...), not
/// `own_pid` itself. Hop-capped and cycle-safe like [`own_process_tree`].
pub fn own_process_ancestors(own_pid: u32, parent_of: &HashMap<u32, u32>) -> HashSet<u32> {
    let mut ancestors = HashSet::new();
    let mut current = own_pid;
    for _ in 0..64 {
        match parent_of.get(&current) {
            Some(&parent)
                if parent != 0
                    && parent != own_pid
                    && parent != current
                    && ancestors.insert(parent) =>
            {
                current = parent;
            }
            _ => break,
        }
    }
    ancestors
}

/// `own_pid` and every process descended from it, given a pid -> parent pid
/// map (a Toolhelp snapshot on Windows). Chains are walked upward with a hop
/// cap, so a stale parent id that closes a cycle cannot loop.
pub fn own_process_tree(own_pid: u32, parent_of: &HashMap<u32, u32>) -> HashSet<u32> {
    let mut tree = HashSet::from([own_pid]);
    for &start in parent_of.keys() {
        let mut chain = Vec::new();
        let mut current = start;
        loop {
            if tree.contains(&current) {
                tree.extend(chain);
                break;
            }
            chain.push(current);
            match parent_of.get(&current) {
                Some(&parent) if parent != current && chain.len() < 64 => current = parent,
                _ => break,
            }
        }
    }
    tree
}

/// One 10 ms frame (480 stereo f32 frames, interleaved) as a socket message,
/// or `None` when `samples` is not exactly 960 values.
pub fn pack_frame(samples: &[f32]) -> Option<Vec<u8>> {
    if samples.len() != FRAME_SAMPLES {
        return None;
    }
    let mut out = Vec::with_capacity(FRAME_BYTES);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    Some(out)
}

/// Cuts the capture client's arbitrarily sized packets into 10 ms frames.
#[derive(Default)]
pub struct Framer {
    pending: Vec<f32>,
}

impl Framer {
    /// Add interleaved stereo samples; `emit` gets each completed frame.
    pub fn push(&mut self, samples: &[f32], mut emit: impl FnMut(Vec<u8>)) {
        self.pending.extend_from_slice(samples);
        let mut done = 0;
        while self.pending.len() - done >= FRAME_SAMPLES {
            if let Some(frame) = pack_frame(&self.pending[done..done + FRAME_SAMPLES]) {
                emit(frame);
            }
            done += FRAME_SAMPLES;
        }
        self.pending.drain(..done);
    }

    /// `frames` sample frames of silence (a packet flagged SILENT).
    pub fn push_silence(&mut self, frames: usize, emit: impl FnMut(Vec<u8>)) {
        self.push(&vec![0.0; frames * CHANNELS], emit);
    }
}

/// Frames waiting for the socket. Past 200 ms the oldest are dropped, so a
/// slow page loses sound from the past instead of delaying all that follows.
#[derive(Default)]
pub struct Backlog {
    frames: VecDeque<Vec<u8>>,
}

impl Backlog {
    /// Queue a frame; returns how many old frames it displaced.
    pub fn push(&mut self, frame: Vec<u8>) -> usize {
        self.frames.push_back(frame);
        let mut dropped = 0;
        while self.frames.len() > MAX_BACKLOG_FRAMES {
            self.frames.pop_front();
            dropped += 1;
        }
        dropped
    }

    pub fn pop(&mut self) -> Option<Vec<u8>> {
        self.frames.pop_front()
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.frames.len()
    }
}

// ---------------------------------------------------------------------------
// The capture session: shared state, loopback socket, Tauri state
// ---------------------------------------------------------------------------

/// What the capture thread and the socket task share.
pub struct Shared {
    stop: AtomicBool,
    backlog: Mutex<Backlog>,
    wake: Notify,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stop: AtomicBool::new(false),
            backlog: Mutex::new(Backlog::default()),
            wake: Notify::new(),
        })
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    /// Called by the capture thread for each finished frame.
    fn push_frame(&self, frame: Vec<u8>) {
        let dropped = crate::sync::lock(&self.backlog).push(frame);
        if dropped > 0 {
            log::debug!("[app_audio] socket backed up, dropped {dropped} old frame(s)");
        }
        self.wake.notify_one();
    }

    fn pop_frame(&self) -> Option<Vec<u8>> {
        crate::sync::lock(&self.backlog).pop()
    }

    fn clear(&self) {
        crate::sync::lock(&self.backlog).clear();
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "no system randomness for the app audio token".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether a request path is `/<token>/app-audio`.
fn route_ok(path: &str, token: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let mut parts = rest.splitn(3, '/');
    let (Some(given), Some(route), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    constant_time_eq(given.as_bytes(), token.as_bytes()) && route == "app-audio"
}

type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

// The handshake callback's error type is tungstenite's `ErrorResponse`, a
// full HTTP response; its size is not ours to choose.
#[allow(clippy::result_large_err)]
async fn handshake(stream: tokio::net::TcpStream, token: &str) -> Option<Ws> {
    let authorize = |req: &Request, resp: Response| {
        if route_ok(req.uri().path(), token) {
            Ok(resp)
        } else {
            let mut refused = ErrorResponse::new(None);
            *refused.status_mut() = StatusCode::FORBIDDEN;
            Err(refused)
        }
    };
    // The path carries the token: never log it.
    match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        tokio_tungstenite::accept_hdr_async(stream, authorize),
    )
    .await
    {
        Ok(Ok(ws)) => Some(ws),
        _ => {
            log::debug!("[app_audio] socket handshake refused");
            None
        }
    }
}

/// Accept the one authorised client, then pump frames to it until it goes
/// away. Either way the capture is told to stop.
async fn serve(listener: TcpListener, token: String, shared: Arc<Shared>) {
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    let ws = loop {
        match tokio::time::timeout_at(deadline, listener.accept()).await {
            Ok(Ok((stream, _))) => {
                if let Some(ws) = handshake(stream, &token).await {
                    break ws;
                }
            }
            Ok(Err(e)) => {
                log::warn!("[app_audio] socket accept: {e}");
                shared.request_stop();
                return;
            }
            Err(_) => {
                log::info!("[app_audio] no client connected, stopping");
                shared.request_stop();
                return;
            }
        }
    };
    // One client only. Frames from before it connected are stale.
    drop(listener);
    shared.clear();
    pump(ws, &shared).await;
    shared.request_stop();
}

async fn pump(ws: Ws, shared: &Shared) {
    let (mut tx, mut rx) = ws.split();
    loop {
        tokio::select! {
            _ = shared.wake.notified() => {}
            msg = rx.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => continue,
            },
            _ = tokio::time::sleep(STOP_POLL) => {}
        }
        if shared.stopped() {
            return;
        }
        while let Some(frame) = shared.pop_frame() {
            if tx.send(Message::Binary(frame.into())).await.is_err() {
                return;
            }
        }
    }
}

/// Bind the loopback listener and serve it. Returns the URL for the webview
/// and the server task.
async fn spawn_server(shared: Arc<Shared>) -> Result<(String, JoinHandle<()>), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("app audio socket bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("app audio socket address: {e}"))?
        .port();
    let token = random_token()?;
    let url = format!("ws://127.0.0.1:{port}/{token}/app-audio");
    let task = tokio::spawn(serve(listener, token, shared));
    Ok((url, task))
}

/// A running capture: the thread, its shared state and the socket task.
/// Dropping it stops everything; the join waits at most one stop poll.
pub struct Capture {
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
    server: JoinHandle<()>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.request_stop();
        self.server.abort();
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                log::warn!("[app_audio] capture thread panicked");
            }
        }
    }
}

/// The single capture slot with an epoch, so the last *call* wins, not the
/// last start to finish. `begin` and `cancel` bump the epoch; `install` only
/// succeeds for the epoch its start was given, so a slow start that a newer
/// start or a stop overtook is rejected instead of replacing the newer one.
pub struct Slot<T> {
    epoch: u64,
    current: Option<T>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            epoch: 0,
            current: None,
        }
    }
}

impl<T> Slot<T> {
    /// A start begins: supersede everything earlier and take the running
    /// capture, which the caller stops. Returns this start's epoch.
    pub fn begin(&mut self) -> (u64, Option<T>) {
        self.epoch += 1;
        (self.epoch, self.current.take())
    }

    /// A stop: supersede in-flight starts and take the running capture.
    pub fn cancel(&mut self) -> Option<T> {
        self.epoch += 1;
        self.current.take()
    }

    pub fn is_current(&self, epoch: u64) -> bool {
        self.epoch == epoch
    }

    /// Install a finished start. A superseded one gets its item back.
    pub fn install(&mut self, epoch: u64, item: T) -> Result<Option<T>, T> {
        if self.epoch == epoch {
            Ok(self.current.replace(item))
        } else {
            Err(item)
        }
    }
}

/// Tauri state: at most one capture at a time.
#[derive(Default)]
pub struct AppAudioState(Mutex<Slot<Capture>>);

impl AppAudioState {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Slot<Capture>> {
        crate::sync::lock(&self.0)
    }
}

/// Stop a capture off the async runtime: its thread join blocks.
async fn stop_capture(capture: Option<Capture>) {
    if let Some(capture) = capture {
        if tauri::async_runtime::spawn_blocking(move || drop(capture))
            .await
            .is_err()
        {
            log::warn!("[app_audio] stopping a capture failed");
        }
    }
}

#[derive(Debug, Serialize)]
pub struct StartedAppAudio {
    pub url: String,
}

/// Whether this machine can capture one app's sound.
#[tauri::command]
pub fn app_audio_available() -> bool {
    platform::available()
}

/// Start capturing the sound of the app that owns the shared window `label`.
/// A running capture is stopped first. `surface` is the share's
/// `displaySurface`; only `"window"` has an app to capture.
#[tauri::command]
pub async fn start_app_audio(
    state: State<'_, AppAudioState>,
    label: String,
    surface: String,
) -> Result<StartedAppAudio, String> {
    if surface != "window" {
        return Err("not_window".into());
    }
    if !platform::available() {
        return Err("unavailable".into());
    }
    // A fast change of source: the old capture and its socket go first, and
    // any start still in flight is superseded.
    let (epoch, old) = state.slot().begin();
    stop_capture(old).await;
    let pid = tauri::async_runtime::spawn_blocking(move || platform::resolve_pid(&label))
        .await
        .map_err(|_| "internal".to_string())??;
    if !state.slot().is_current(epoch) {
        return Err("superseded".into());
    }
    let shared = Shared::new();
    let (url, server) = spawn_server(shared.clone()).await.map_err(|e| {
        log::warn!("[app_audio] {e}");
        "internal".to_string()
    })?;
    let thread = {
        let shared = shared.clone();
        tauri::async_runtime::spawn_blocking(move || platform::spawn_capture(pid, shared))
            .await
            .map_err(|_| "internal".to_string())
            .and_then(|started| started)
    };
    let thread = match thread {
        Ok(thread) => thread,
        Err(code) => {
            shared.request_stop();
            server.abort();
            return Err(code);
        }
    };
    let capture = Capture {
        shared,
        thread: Some(thread),
        server,
    };
    // Install only if no newer start or stop overtook this one; either way the
    // capture that loses is dropped outside the lock.
    let installed = state.slot().install(epoch, capture);
    match installed {
        Ok(previous) => {
            stop_capture(previous).await;
            Ok(StartedAppAudio { url })
        }
        Err(superseded) => {
            stop_capture(Some(superseded)).await;
            Err("superseded".into())
        }
    }
}

/// Stop the running capture, if any.
#[tauri::command]
pub async fn stop_app_audio(state: State<'_, AppAudioState>) -> Result<(), String> {
    let old = state.slot().cancel();
    stop_capture(old).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Platform seam
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn available() -> bool {
        false
    }

    pub fn resolve_pid(_label: &str) -> Result<u32, String> {
        Err("unavailable".into())
    }

    pub fn spawn_capture(
        _pid: u32,
        _shared: Arc<Shared>,
    ) -> Result<std::thread::JoinHandle<()>, String> {
        Err("unavailable".into())
    }
}

#[cfg(windows)]
use windows_impl as platform;

// COM method names keep their Win32 spelling (the interface macro takes no
// attributes of its own).
#[cfg(windows)]
#[allow(non_snake_case)]
mod windows_impl {
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::time::Duration;

    use windows::core::{Interface as _, PROPVARIANT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient,
        IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
        AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        IsWindowVisible,
    };

    use super::*;

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

    /// The owner process of a live window handle.
    fn hwnd_pid(hwnd: u64) -> Option<u32> {
        let handle = usize::try_from(hwnd).ok()? as *mut c_void;
        let mut pid = 0u32;
        // SAFETY: IsWindow and GetWindowThreadProcessId accept any handle
        // value and report a dead one as 0; `pid` is a valid out pointer.
        unsafe {
            if IsWindow(handle) == 0 {
                return None;
            }
            GetWindowThreadProcessId(handle, &mut pid);
        }
        (pid != 0).then_some(pid)
    }

    unsafe extern "system" fn collect_window(
        hwnd: *mut c_void,
        lparam: LPARAM,
    ) -> windows_sys::core::BOOL {
        // SAFETY: lparam is the &mut Vec that enumerate_windows passes for the
        // duration of its EnumWindows call.
        let windows = unsafe { &mut *(lparam as *mut Vec<WindowInfo>) };
        let mut pid = 0u32;
        // SAFETY: plain Win32 queries on a handle EnumWindows just gave us.
        // The buffer is sized from the title length plus the terminator and
        // its length is passed alongside it, so a long title is not cut.
        let (visible, buf, len) = unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
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
    fn parent_map() -> Result<HashMap<u32, u32>, String> {
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

    /// The process to capture for a shared window's label (decision 1).
    pub fn resolve_pid(label: &str) -> Result<u32, String> {
        let parents = parent_map()?;
        let me = std::process::id();
        let own = own_process_tree(me, &parents);
        let ancestors = own_process_ancestors(me, &parents);
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
    /// because `windows` offers no safe blob constructor, and it must not be
    /// a real `PROPVARIANT` (whose drop would CoTaskMemFree our stack bytes).
    #[repr(C)]
    struct BlobPropVariant {
        vt: u16,
        reserved: [u16; 3],
        cb_size: u32,
        blob: *mut u8,
    }

    // The hand-built blob must be exactly the size of the real PROPVARIANT.
    const _: () =
        assert!(std::mem::size_of::<BlobPropVariant>() == std::mem::size_of::<PROPVARIANT>());

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
    /// start it (decision 2). Must run on an MTA thread.
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
    pub fn spawn_capture(
        pid: u32,
        shared: Arc<Shared>,
    ) -> Result<std::thread::JoinHandle<()>, String> {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(hwnd: u64, pid: u32, title: &str, visible: bool) -> WindowInfo {
        WindowInfo {
            hwnd,
            pid,
            title: title.into(),
            visible,
        }
    }

    fn none(_: u64) -> Option<u32> {
        None
    }

    #[test]
    fn parses_window_labels() {
        assert_eq!(parse_window_label("window:263538:0"), Some(263538));
        assert_eq!(parse_window_label("window:1:12"), Some(1));
        for bad in [
            "",
            "window:",
            "window:12",
            "window::0",
            "window:12:",
            "window:x:0",
            "window:12:y",
            "window:12:0:1",
            "screen:1:0",
            "Notepad",
            "window:99999999999999999999999:0",
        ] {
            assert_eq!(parse_window_label(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn hwnd_label_wins_over_title() {
        let windows = [win(10, 100, "window:10:0", true), win(11, 200, "x", true)];
        let own = HashSet::new();
        let pid = pick_target_pid(
            "window:11:0",
            |h| (h == 11).then_some(300),
            &windows,
            &own,
            &HashSet::new(),
        );
        assert_eq!(pid, Ok(300));
    }

    #[test]
    fn dead_hwnd_falls_back_to_title() {
        let windows = [win(10, 100, "window:10:0", true)];
        let pid = pick_target_pid(
            "window:10:0",
            none,
            &windows,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(pid, Ok(100));
    }

    #[test]
    fn unresolved_label_is_not_found() {
        let windows = [win(10, 100, "Notepad", true)];
        let own = HashSet::new();
        assert_eq!(
            pick_target_pid("window:5:0", none, &windows, &own, &HashSet::new()),
            Err(ResolveError::NotFound)
        );
        assert_eq!(
            pick_target_pid("", none, &windows, &own, &HashSet::new()),
            Err(ResolveError::NotFound)
        );
    }

    #[test]
    fn title_must_match_exactly_and_be_visible() {
        let windows = [
            win(1, 100, "Notepad", false),
            win(2, 101, "Notepad - Untitled", true),
            win(3, 102, "notepad", true),
        ];
        assert_eq!(
            pick_target_pid("Notepad", none, &windows, &HashSet::new(), &HashSet::new()),
            Err(ResolveError::NotFound)
        );
    }

    #[test]
    fn same_pid_windows_are_not_ambiguous() {
        let windows = [
            win(1, 100, "Doc", true),
            win(2, 100, "Doc", true),
            win(3, 100, "Doc", false),
        ];
        assert_eq!(
            pick_target_pid("Doc", none, &windows, &HashSet::new(), &HashSet::new()),
            Ok(100)
        );
    }

    #[test]
    fn different_pids_give_up() {
        let windows = [win(1, 100, "Doc", true), win(2, 200, "Doc", true)];
        assert_eq!(
            pick_target_pid("Doc", none, &windows, &HashSet::new(), &HashSet::new()),
            Err(ResolveError::Ambiguous)
        );
    }

    #[test]
    fn a_hidden_twin_does_not_cause_ambiguity() {
        let windows = [win(1, 100, "Doc", true), win(2, 200, "Doc", false)];
        assert_eq!(
            pick_target_pid("Doc", none, &windows, &HashSet::new(), &HashSet::new()),
            Ok(100)
        );
    }

    #[test]
    fn never_the_own_process_tree() {
        let own = HashSet::from([7, 8]);
        let windows = [win(1, 8, "OwnCord", true)];
        assert_eq!(
            pick_target_pid("OwnCord", none, &windows, &own, &HashSet::new()),
            Err(ResolveError::OwnWindow)
        );
        assert_eq!(
            pick_target_pid("window:1:0", |_| Some(7), &windows, &own, &HashSet::new()),
            Err(ResolveError::OwnWindow)
        );
        // An own twin among other processes is ambiguous, never picked.
        let twins = [win(1, 8, "Doc", true), win(2, 200, "Doc", true)];
        assert_eq!(
            pick_target_pid("Doc", none, &twins, &own, &HashSet::new()),
            Err(ResolveError::Ambiguous)
        );
    }

    #[test]
    fn never_an_ancestor_of_ours() {
        // own 7 was launched by explorer 3, itself under 1.
        let parents = HashMap::from([(7, 3), (3, 1), (1, 0), (50, 3)]);
        let ancestors = own_process_ancestors(7, &parents);
        assert_eq!(ancestors, HashSet::from([3, 1]));
        let own = own_process_tree(7, &parents);
        let windows = [win(1, 3, "Explorer", true), win(2, 50, "Sibling", true)];
        assert_eq!(
            pick_target_pid("Explorer", none, &windows, &own, &ancestors),
            Err(ResolveError::Ancestor)
        );
        assert_eq!(
            pick_target_pid("window:1:0", |_| Some(3), &windows, &own, &ancestors),
            Err(ResolveError::Ancestor)
        );
        // A sibling is neither ours nor an ancestor.
        assert_eq!(
            pick_target_pid("Sibling", none, &windows, &own, &ancestors),
            Ok(50)
        );
    }

    #[test]
    fn ancestors_survive_cycles_and_roots() {
        let cyc = HashMap::from([(7, 3), (3, 7)]);
        assert_eq!(own_process_ancestors(7, &cyc), HashSet::from([3]));
        let cyc2 = HashMap::from([(7, 3), (3, 4), (4, 3)]);
        assert_eq!(own_process_ancestors(7, &cyc2), HashSet::from([3, 4]));
        assert!(own_process_ancestors(7, &HashMap::new()).is_empty());
        assert!(own_process_ancestors(7, &HashMap::from([(7, 0)])).is_empty());
    }

    #[test]
    fn a_late_start_does_not_replace_a_newer_one() {
        let mut slot = Slot::<&str>::default();
        let (a, old) = slot.begin();
        assert_eq!(old, None);
        let (b, _) = slot.begin();
        assert!(!slot.is_current(a));
        assert_eq!(slot.install(b, "B"), Ok(None));
        // A finishes late: rejected, B stays.
        assert_eq!(slot.install(a, "A"), Err("A"));
        assert_eq!(slot.begin().1, Some("B"));
    }

    #[test]
    fn a_start_overtaken_by_a_stop_is_superseded() {
        let mut slot = Slot::<&str>::default();
        let (a, _) = slot.begin();
        assert_eq!(slot.cancel(), None);
        assert_eq!(slot.install(a, "A"), Err("A"));
        assert_eq!(slot.cancel(), None);
    }

    #[test]
    fn a_new_start_takes_the_running_capture_to_stop_it() {
        let mut slot = Slot::<&str>::default();
        let (a, _) = slot.begin();
        assert_eq!(slot.install(a, "A"), Ok(None));
        let (b, old) = slot.begin();
        assert_eq!(old, Some("A"));
        assert_eq!(slot.install(b, "B"), Ok(None));
        assert_eq!(slot.cancel(), Some("B"));
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(ResolveError::Ancestor.code(), "ancestor");
        assert_eq!(ResolveError::OwnWindow.code(), "own_window");
        assert_eq!(ResolveError::NotFound.code(), "not_found");
        assert_eq!(ResolveError::Ambiguous.code(), "ambiguous");
    }

    #[test]
    fn process_tree_follows_parent_chains() {
        // 1 -> 2 -> 3 -> 4 descend from 1; 10 -> 11 and 20 do not.
        let parents = HashMap::from([(2, 1), (3, 2), (4, 3), (11, 10), (10, 0), (20, 1000)]);
        let tree = own_process_tree(1, &parents);
        assert_eq!(tree, HashSet::from([1, 2, 3, 4]));
    }

    #[test]
    fn process_tree_survives_cycles_and_self_parents() {
        let parents = HashMap::from([(5, 6), (6, 5), (0, 0), (9, 9), (2, 1)]);
        assert_eq!(own_process_tree(1, &parents), HashSet::from([1, 2]));
    }

    #[test]
    fn packs_a_frame_little_endian() {
        let mut samples = vec![0.0f32; FRAME_SAMPLES];
        samples[0] = 1.0;
        samples[1] = -0.5;
        samples[FRAME_SAMPLES - 1] = 0.25;
        let frame = pack_frame(&samples).unwrap();
        assert_eq!(frame.len(), 3_840);
        assert_eq!(&frame[0..4], &1.0f32.to_le_bytes());
        assert_eq!(&frame[4..8], &(-0.5f32).to_le_bytes());
        assert_eq!(&frame[3_836..], &0.25f32.to_le_bytes());
    }

    #[test]
    fn rejects_frames_of_the_wrong_length() {
        assert!(pack_frame(&[0.0; 959]).is_none());
        assert!(pack_frame(&[0.0; 961]).is_none());
        assert!(pack_frame(&[]).is_none());
    }

    #[test]
    fn framer_cuts_uneven_packets_into_frames() {
        let mut framer = Framer::default();
        let mut frames = Vec::new();
        // 441 sample frames (a 44.1 kHz-style packet) x 3 = 1323: two frames
        // of 480 and 363 left over.
        for _ in 0..3 {
            framer.push(&vec![0.5; 441 * CHANNELS], |f| frames.push(f));
        }
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| f.len() == FRAME_BYTES));
        framer.push_silence(117, |f| frames.push(f));
        assert_eq!(frames.len(), 3);
        // The third frame is 363 audible frames then 117 silent ones.
        let last = &frames[2];
        assert_eq!(&last[..4], &0.5f32.to_le_bytes());
        assert_eq!(&last[FRAME_BYTES - 4..], &0.0f32.to_le_bytes());
    }

    #[test]
    fn backlog_drops_the_oldest_beyond_200_ms() {
        let mut backlog = Backlog::default();
        for i in 0..MAX_BACKLOG_FRAMES {
            assert_eq!(backlog.push(vec![i as u8]), 0);
        }
        assert_eq!(backlog.len(), 20);
        assert_eq!(backlog.push(vec![20]), 1);
        assert_eq!(backlog.push(vec![21]), 1);
        assert_eq!(backlog.len(), 20);
        assert_eq!(backlog.pop(), Some(vec![2]));
    }

    #[test]
    fn availability_needs_build_19041() {
        assert!(!build_supports_process_loopback(19040));
        assert!(build_supports_process_loopback(19041));
        assert!(build_supports_process_loopback(26100));
    }

    #[test]
    fn route_requires_the_token_and_the_route() {
        assert!(route_ok("/abc/app-audio", "abc"));
        assert!(!route_ok("/abd/app-audio", "abc"));
        assert!(!route_ok("/abc/other", "abc"));
        assert!(!route_ok("/abc/app-audio/x", "abc"));
        assert!(!route_ok("/abc", "abc"));
        assert!(!route_ok("abc/app-audio", "abc"));
        assert!(!route_ok("/ab/app-audio", "abc"));
    }

    #[test]
    fn tokens_are_256_bit_and_distinct() {
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    async fn connect(url: &str) -> Option<Ws> {
        let addr = url.strip_prefix("ws://")?.split('/').next()?;
        let stream = tokio::net::TcpStream::connect(addr).await.ok()?;
        tokio_tungstenite::client_async(url, stream)
            .await
            .ok()
            .map(|(ws, _)| ws)
    }

    #[tokio::test]
    async fn socket_refuses_a_wrong_token_and_serves_frames_in_order() {
        let shared = Shared::new();
        let (url, task) = spawn_server(shared.clone()).await.unwrap();
        let mut wrong = url.clone();
        wrong.insert(url.len() - "/app-audio".len(), '0');
        assert!(connect(&wrong).await.is_none());
        assert!(!shared.stopped());

        // Stale frames from before the client connected are discarded.
        shared.push_frame(vec![0; 4]);
        let mut ws = connect(&url).await.expect("authorised client");
        tokio::time::sleep(Duration::from_millis(100)).await;
        for i in 1..=3u8 {
            shared.push_frame(vec![i; FRAME_BYTES]);
        }
        let mut seen = Vec::new();
        while seen.len() < 3 {
            let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("frame in time")
                .unwrap()
                .unwrap();
            if let Message::Binary(bytes) = msg {
                assert_eq!(bytes.len(), FRAME_BYTES);
                seen.push(bytes[0]);
            }
        }
        assert_eq!(seen, [1, 2, 3]);
        task.abort();
    }

    #[tokio::test]
    async fn client_disconnect_stops_the_capture() {
        let shared = Shared::new();
        let (url, task) = spawn_server(shared.clone()).await.unwrap();
        let mut ws = connect(&url).await.expect("authorised client");
        ws.close(None).await.unwrap();
        drop(ws);
        let stopped = tokio::time::timeout(Duration::from_secs(2), async {
            while !shared.stopped() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(stopped.is_ok(), "the stop flag was not raised");
        let _ = task.await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_never_connects_stops_the_capture() {
        let shared = Shared::new();
        let (_url, task) = spawn_server(shared.clone()).await.unwrap();
        tokio::time::sleep(CONNECT_TIMEOUT + Duration::from_secs(1)).await;
        let _ = task.await;
        assert!(shared.stopped());
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_host_is_unavailable() {
        assert!(!app_audio_available());
        assert_eq!(platform::resolve_pid("x"), Err("unavailable".to_string()));
    }
}
