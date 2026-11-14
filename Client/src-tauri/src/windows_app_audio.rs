//! Windows per-app share audio: capture one application's sound with
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

/// The process whose sound a shared window carries.
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

/// Tauri state: at most one screen-share capture at a time.
#[derive(Default)]
pub struct AppAudioState(Mutex<Slot<Capture>>);

impl AppAudioState {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&self) -> &Mutex<Slot<Capture>> {
        &self.0
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
    let url = start_in_slot(state.slot(), move || platform::resolve_pid(&label)).await?;
    Ok(StartedAppAudio { url })
}

/// Stop the running capture, if any.
#[tauri::command]
pub async fn stop_app_audio(state: State<'_, AppAudioState>) -> Result<(), String> {
    let old = crate::sync::lock(state.slot()).cancel();
    stop_capture(old).await;
    Ok(())
}

/// Start a capture in `slot` for the pid `resolve` finds, and return the
/// loopback socket URL. The slot's running capture is stopped first, and any
/// start still in flight on the same slot is superseded. Other slots are not
/// touched.
async fn start_in_slot(
    slot: &Mutex<Slot<Capture>>,
    resolve: impl FnOnce() -> Result<u32, String> + Send + 'static,
) -> Result<String, String> {
    // A fast change of source: the old capture and its socket go first.
    let (epoch, old) = crate::sync::lock(slot).begin();
    stop_capture(old).await;
    let pid = tauri::async_runtime::spawn_blocking(resolve)
        .await
        .map_err(|_| "internal".to_string())??;
    if !crate::sync::lock(slot).is_current(epoch) {
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
    let installed = crate::sync::lock(slot).install(epoch, capture);
    match installed {
        Ok(previous) => {
            stop_capture(previous).await;
            Ok(url)
        }
        Err(superseded) => {
            stop_capture(Some(superseded)).await;
            Err("superseded".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Music share: list the apps with sound, capture one by process
// ---------------------------------------------------------------------------

/// One app with an audio session on the default output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    /// Opaque id the page hands back to start a music capture.
    pub id: String,
    /// Display name ("Spotify", "foobar2000").
    pub name: String,
    /// Small PNG data URL (<= 32x32) or None.
    pub icon: Option<String>,
    /// Sound is playing right now (not only an open session).
    pub playing: bool,
}

/// The id of the app whose topmost process is `pid`.
pub fn app_id(pid: u32) -> String {
    format!("pid:{pid}")
}

/// `pid:<n>` -> `n`. Only the canonical spelling [`app_id`] writes is
/// accepted: no sign, spaces, leading zeros or pid 0.
pub fn parse_app_id(id: &str) -> Option<u32> {
    let pid: u32 = id.strip_prefix("pid:")?.parse().ok()?;
    (pid != 0 && app_id(pid) == id).then_some(pid)
}

/// One audio session on the default output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSession {
    pub pid: u32,
    pub playing: bool,
}

/// One app: the topmost process of its tree that has sessions below it, and
/// whether any of them is playing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppGroup {
    pub root_pid: u32,
    pub playing: bool,
}

/// The executable's file name, lowercased, from a Windows or POSIX path.
pub fn exe_file_name(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?;
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// The file name without its extension, as written.
pub fn exe_stem(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?;
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    (!stem.is_empty()).then(|| stem.to_string())
}

/// Group sessions into apps, one per process tree.
///
/// A session's app root is its topmost ancestor that runs the same
/// executable (Spotify, Chrome and every Electron app play from a child of
/// their main process). The climb stops at a parent that runs something else,
/// that is gone, or that is OwnCord's own tree or one OwnCord descends from.
/// System sounds (pid 0), OwnCord's own processes and its ancestors (a
/// capture of those would contain this app) are left out. `exe_of` gives a
/// pid's lowercased executable name; a process it cannot name is never
/// climbed from.
pub fn group_sessions(
    sessions: &[AudioSession],
    parent_of: &HashMap<u32, u32>,
    exe_of: impl Fn(u32) -> Option<String>,
    own: &HashSet<u32>,
    ancestors: &HashSet<u32>,
) -> Vec<AppGroup> {
    let mut groups: Vec<AppGroup> = Vec::new();
    for session in sessions {
        let pid = session.pid;
        if pid == 0 || own.contains(&pid) || ancestors.contains(&pid) {
            continue;
        }
        let mut root = pid;
        let exe = exe_of(pid);
        for _ in 0..64 {
            let Some(&parent) = parent_of.get(&root) else {
                break;
            };
            let same_family = exe.is_some() && exe_of(parent) == exe;
            if parent == 0
                || parent == root
                || own.contains(&parent)
                || ancestors.contains(&parent)
                || !same_family
            {
                break;
            }
            root = parent;
        }
        match groups.iter_mut().find(|g| g.root_pid == root) {
            Some(group) => group.playing |= session.playing,
            None => groups.push(AppGroup {
                root_pid: root,
                playing: session.playing,
            }),
        }
    }
    groups
}

/// Playing apps first, then by name (case-insensitive), then by id.
pub fn sort_apps(apps: &mut [AudioApp]) {
    apps.sort_by(|a, b| {
        b.playing
            .cmp(&a.playing)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// Turn groups into the rows the page shows. `describe` gives a root
/// process's display name and icon.
pub fn assemble_apps(
    groups: &[AppGroup],
    describe: impl Fn(u32) -> (String, Option<String>),
) -> Vec<AudioApp> {
    let mut apps: Vec<AudioApp> = groups
        .iter()
        .map(|group| {
            let (name, icon) = describe(group.root_pid);
            AudioApp {
                id: app_id(group.root_pid),
                name,
                icon,
                playing: group.playing,
            }
        })
        .collect();
    sort_apps(&mut apps);
    apps
}

/// Whether `pid` may be captured as music: a live process outside OwnCord's
/// own tree and outside the processes OwnCord descends from (their trees
/// contain this app, so the capture would carry the call back to viewers).
/// The error is the `start_music_audio` code.
pub fn check_music_target(
    pid: u32,
    parent_of: &HashMap<u32, u32>,
    own: &HashSet<u32>,
    ancestors: &HashSet<u32>,
) -> Result<u32, &'static str> {
    if pid == 0 || !parent_of.contains_key(&pid) || own.contains(&pid) || ancestors.contains(&pid) {
        return Err("not_found");
    }
    Ok(pid)
}

/// The side of the icon a row shows.
const ICON_SIDE: usize = 32;

/// Turn the top-down BGRA pixels of an icon's colour bitmap into RGBA. Icons
/// without an alpha channel come back with all alpha zero; then the AND mask
/// (`mask_bgra`, same size, a set pixel is transparent) decides, so the icon
/// is not drawn invisible. `None` when a buffer does not match `w * h`.
pub fn icon_rgba(w: usize, h: usize, bgra: &[u8], mask_bgra: Option<&[u8]>) -> Option<Vec<u8>> {
    let len = w.checked_mul(h)?.checked_mul(4)?;
    if len == 0 || bgra.len() != len || mask_bgra.is_some_and(|m| m.len() != len) {
        return None;
    }
    let has_alpha = bgra.as_chunks::<4>().0.iter().any(|px| px[3] != 0);
    let mut out = Vec::with_capacity(len);
    for (i, px) in bgra.as_chunks::<4>().0.iter().enumerate() {
        let alpha = if has_alpha {
            px[3]
        } else if mask_bgra.is_some_and(|m| m[i * 4] != 0 || m[i * 4 + 1] != 0) {
            0
        } else {
            255
        };
        out.extend_from_slice(&[px[2], px[1], px[0], alpha]);
    }
    Some(out)
}

/// `rgba` (`w` x `h`) as a `ICON_SIDE` square by nearest-neighbour sampling,
/// so an icon the system hands back larger than 32x32 (high DPI) still fits.
pub fn fit_icon(w: usize, h: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || rgba.len() != w.checked_mul(h)?.checked_mul(4)? {
        return None;
    }
    if w == ICON_SIDE && h == ICON_SIDE {
        return Some(rgba.to_vec());
    }
    let mut out = Vec::with_capacity(ICON_SIDE * ICON_SIDE * 4);
    for y in 0..ICON_SIDE {
        let sy = y * h / ICON_SIDE;
        for x in 0..ICON_SIDE {
            let sx = x * w / ICON_SIDE;
            let at = (sy * w + sx) * 4;
            out.extend_from_slice(&rgba[at..at + 4]);
        }
    }
    Some(out)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

/// An 8-bit RGBA PNG of `w` x `h` pixels, deflate "stored" (uncompressed):
/// an icon is a few KB and this needs no compression crate. `None` when
/// `rgba` is not `w * h * 4` bytes or the image is empty.
pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let row = (w as usize).checked_mul(4)?;
    if w == 0 || h == 0 || rgba.len() != row.checked_mul(h as usize)? {
        return None;
    }
    // Each scanline is a filter byte (0, none) and the pixels.
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for line in rgba.chunks_exact(row) {
        raw.push(0);
        raw.extend_from_slice(line);
    }
    // zlib: header, stored blocks of at most 65535 bytes, Adler-32.
    let mut z = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65_535).peekable();
    while let Some(block) = blocks.next() {
        z.push(u8::from(blocks.peek().is_none()));
        z.extend_from_slice(&(block.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png_chunk(&mut out, b"IHDR", &ihdr);
    png_chunk(&mut out, b"IDAT", &z);
    png_chunk(&mut out, b"IEND", &[]);
    Some(out)
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ABC[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ABC[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A 32x32 PNG data URL for an icon's colour pixels (top-down BGRA, `w` x
/// `h`) and optional AND mask, or `None` when they do not describe an image.
pub fn icon_data_url(w: usize, h: usize, bgra: &[u8], mask_bgra: Option<&[u8]>) -> Option<String> {
    let rgba = fit_icon(w, h, &icon_rgba(w, h, bgra, mask_bgra)?)?;
    let png = encode_png(ICON_SIDE as u32, ICON_SIDE as u32, &rgba)?;
    Some(format!("data:image/png;base64,{}", base64(&png)))
}

/// Tauri state: the music capture, a slot of its own so it never touches a
/// running screen-share audio capture, nor the other way round.
#[derive(Default)]
pub struct MusicAudioState(Mutex<Slot<Capture>>);

impl MusicAudioState {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&self) -> &Mutex<Slot<Capture>> {
        &self.0
    }
}

/// List the apps with an audio session on the default output, one row per
/// app, playing ones first. OwnCord itself is left out.
#[tauri::command]
pub async fn list_audio_apps() -> Result<Vec<AudioApp>, String> {
    if !platform::available() {
        return Err("unavailable".into());
    }
    tauri::async_runtime::spawn_blocking(platform::list_apps)
        .await
        .map_err(|_| "internal".to_string())?
}

/// Start capturing the app `app_id` (from `list_audio_apps`) as music and
/// return the loopback socket URL, same frame format as `start_app_audio`.
/// A running music capture is replaced; a screen-share capture is not touched.
/// Codes: `unavailable`, `not_found`, `activation_failed`, `superseded`,
/// `internal`.
#[tauri::command]
pub async fn start_music_audio(
    state: State<'_, MusicAudioState>,
    app_id: String,
) -> Result<String, String> {
    if !platform::available() {
        return Err("unavailable".into());
    }
    let pid = parse_app_id(&app_id).ok_or_else(|| "not_found".to_string())?;
    start_in_slot(state.slot(), move || platform::resolve_music_pid(pid)).await
}

/// Stop the music capture, if any. The screen-share capture keeps running.
#[tauri::command]
pub async fn stop_music_audio(state: State<'_, MusicAudioState>) -> Result<(), String> {
    let old = crate::sync::lock(state.slot()).cancel();
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

    pub fn resolve_music_pid(_pid: u32) -> Result<u32, String> {
        Err("unavailable".into())
    }

    pub fn list_apps() -> Result<Vec<AudioApp>, String> {
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
        eMultimedia, eRender, AudioSessionStateActive, AudioSessionStateExpired,
        IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient,
        IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
        AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, LPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Shell::ExtractIconExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, EnumWindows, GetIconInfo, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, HICON, ICONINFO,
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

    /// The process to capture for a shared window's label.
    pub fn resolve_pid(label: &str) -> Result<u32, String> {
        let parents = parent_map()?;
        let me = std::process::id();
        let own = own_process_tree(me, &parents);
        let ancestors = own_process_ancestors(me, &parents);
        pick_target_pid(label, hwnd_pid, &enumerate_windows(), &own, &ancestors)
            .map_err(|e| e.code().to_string())
    }

    // -- music share: sessions, names, icons ----------------------------------

    /// Balances a successful `CoInitializeEx` on this thread. A thread that
    /// already has a different apartment (`RPC_E_CHANGED_MODE`) still has
    /// COM, so that case is not an error and is not uninitialised.
    struct ComGuard(bool);

    impl ComGuard {
        fn init() -> Self {
            // SAFETY: balanced by CoUninitialize in Drop when it succeeded.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self(hr.is_ok())
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: matches the successful CoInitializeEx in `init`.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Every live session on the default render endpoint. Expired sessions
    /// (no stream left) and system sounds are left out.
    fn enumerate_sessions() -> windows::core::Result<Vec<AudioSession>> {
        // SAFETY: COM calls on interfaces this thread created; each result
        // is checked and every interface is released on drop.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let sessions = manager.GetSessionEnumerator()?;
            let count = sessions.GetCount()?;
            let mut out = Vec::new();
            for index in 0..count {
                // One session that fails to answer must not hide the rest.
                let Ok(control) = sessions.GetSession(index) else {
                    continue;
                };
                let Ok(state) = control.GetState() else {
                    continue;
                };
                if state == AudioSessionStateExpired {
                    continue;
                }
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(pid) = control2.GetProcessId() else {
                    continue;
                };
                out.push(AudioSession {
                    pid,
                    playing: state == AudioSessionStateActive,
                });
            }
            Ok(out)
        }
    }

    fn to_wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The full image path of a process, if it can be opened for query.
    fn exe_path(pid: u32) -> Option<String> {
        // SAFETY: the handle is checked, used for one query with a buffer
        // whose length is passed, and closed.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 32_768];
            let mut len = buf.len() as u32;
            let named = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len) != 0;
            windows_sys::Win32::Foundation::CloseHandle(process);
            named.then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// One string of the version resource, e.g. `FileDescription`.
    fn version_string(block: &[u8], lang: u16, codepage: u16, key: &str) -> Option<String> {
        let sub = to_wide(&format!(
            "\\StringFileInfo\\{lang:04x}{codepage:04x}\\{key}"
        ));
        let mut value: *mut c_void = std::ptr::null_mut();
        let mut chars = 0u32;
        // SAFETY: `block` is a version block filled by GetFileVersionInfoW;
        // the returned pointer, when set, points into it for `chars` UTF-16
        // units and is copied before `block` goes away.
        let found = unsafe {
            VerQueryValueW(block.as_ptr().cast(), sub.as_ptr(), &mut value, &mut chars) != 0
        };
        if !found || value.is_null() || chars == 0 {
            return None;
        }
        // SAFETY: see above; the unit count includes the terminator.
        let units = unsafe { std::slice::from_raw_parts(value as *const u16, chars as usize) };
        let end = units.iter().position(|&c| c == 0).unwrap_or(units.len());
        let text = String::from_utf16_lossy(&units[..end]).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    /// The exe's `FileDescription`, if it has one.
    fn file_description(path: &str) -> Option<String> {
        let wide = to_wide(path);
        let mut handle = 0u32;
        // SAFETY: plain queries on a NUL-terminated path; the buffer is sized
        // by the first call and passed with its length to the second.
        let block = unsafe {
            let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
            if size == 0 || size > 4 * 1024 * 1024 {
                return None;
            }
            let mut block = vec![0u8; size as usize];
            if GetFileVersionInfoW(wide.as_ptr(), 0, size, block.as_mut_ptr().cast()) == 0 {
                return None;
            }
            block
        };
        // The file's own (language, codepage) pairs first, then the two the
        // common toolchains write.
        let mut pairs: Vec<(u16, u16)> = Vec::new();
        let sub = to_wide("\\VarFileInfo\\Translation");
        let mut value: *mut c_void = std::ptr::null_mut();
        let mut bytes = 0u32;
        // SAFETY: as in `version_string`; the translation table is `bytes`
        // bytes of (u16, u16) pairs, read unaligned.
        unsafe {
            if VerQueryValueW(block.as_ptr().cast(), sub.as_ptr(), &mut value, &mut bytes) != 0
                && !value.is_null()
            {
                let raw = std::slice::from_raw_parts(value as *const u8, bytes as usize);
                for pair in raw.as_chunks::<4>().0 {
                    pairs.push((
                        u16::from_le_bytes([pair[0], pair[1]]),
                        u16::from_le_bytes([pair[2], pair[3]]),
                    ));
                }
            }
        }
        pairs.extend([(0x0409, 0x04B0), (0x0409, 0x04E4)]);
        pairs
            .into_iter()
            .find_map(|(lang, cp)| version_string(&block, lang, cp, "FileDescription"))
    }

    /// Pixels of one bitmap as top-down 32-bit BGRA.
    ///
    /// # Safety
    /// `hdc` and `bitmap` must be live GDI handles.
    unsafe fn bitmap_bgra(hdc: HDC, bitmap: HBITMAP, w: usize, h: usize) -> Option<Vec<u8>> {
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w as i32;
        info.bmiHeader.biHeight = -(h as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut buf = vec![0u8; w * h * 4];
        // SAFETY: `buf` holds w*h 32-bit pixels, the size `info` describes.
        let lines = unsafe {
            GetDIBits(
                hdc,
                bitmap,
                0,
                h as u32,
                buf.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        (lines == h as i32).then_some(buf)
    }

    /// The exe's first icon at the system's large size (32x32, more at high
    /// DPI), as a 32x32 PNG data URL. Best effort: `None` on any failure.
    fn icon_url(path: &str) -> Option<String> {
        let wide = to_wide(path);
        let mut large: HICON = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; `large` is a valid out pointer
        // for the one icon asked for; the icon is destroyed below.
        let got = unsafe { ExtractIconExW(wide.as_ptr(), 0, &mut large, std::ptr::null_mut(), 1) };
        if got == 0 || large.is_null() {
            return None;
        }
        let url = icon_pixels(large)
            .and_then(|(w, h, color, mask)| icon_data_url(w, h, &color, mask.as_deref()));
        // SAFETY: destroying the icon ExtractIconExW created, once.
        unsafe {
            DestroyIcon(large);
        }
        url
    }

    /// Width, height, colour pixels and, when present, mask pixels of an icon.
    type IconPixels = (usize, usize, Vec<u8>, Option<Vec<u8>>);

    fn icon_pixels(icon: HICON) -> Option<IconPixels> {
        // SAFETY: GDI calls on handles GetIconInfo gave us, all released
        // before returning; the screen DC is released too.
        unsafe {
            let mut info: ICONINFO = std::mem::zeroed();
            if GetIconInfo(icon, &mut info) == 0 {
                return None;
            }
            let result = (|| {
                if info.hbmColor.is_null() {
                    return None;
                }
                let mut bmp: BITMAP = std::mem::zeroed();
                let size = std::mem::size_of::<BITMAP>() as i32;
                if GetObjectW(info.hbmColor, size, (&mut bmp as *mut BITMAP).cast()) == 0 {
                    return None;
                }
                let (w, h) = (bmp.bmWidth as usize, bmp.bmHeight as usize);
                if w == 0 || h == 0 || w > 256 || h > 256 {
                    return None;
                }
                let hdc = GetDC(std::ptr::null_mut());
                if hdc.is_null() {
                    return None;
                }
                let color = bitmap_bgra(hdc, info.hbmColor, w, h);
                let mask = if info.hbmMask.is_null() {
                    None
                } else {
                    bitmap_bgra(hdc, info.hbmMask, w, h)
                };
                ReleaseDC(std::ptr::null_mut(), hdc);
                Some((w, h, color?, mask))
            })();
            DeleteObject(info.hbmColor);
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
            result
        }
    }

    /// A root process's display name and icon.
    fn describe(pid: u32) -> (String, Option<String>) {
        let path = exe_path(pid);
        let name = path
            .as_deref()
            .and_then(file_description)
            .or_else(|| path.as_deref().and_then(exe_stem))
            .unwrap_or_else(|| format!("Process {pid}"));
        (name, path.as_deref().and_then(icon_url))
    }

    /// The apps with a session on the default output, one row per app.
    pub fn list_apps() -> Result<Vec<AudioApp>, String> {
        let _com = ComGuard::init();
        let sessions = enumerate_sessions().map_err(|e| {
            log::warn!("[app_audio] listing audio sessions: {e}");
            "internal".to_string()
        })?;
        let parents = parent_map()?;
        let me = std::process::id();
        let own = own_process_tree(me, &parents);
        let ancestors = own_process_ancestors(me, &parents);
        let groups = group_sessions(
            &sessions,
            &parents,
            |pid| exe_path(pid).as_deref().and_then(exe_file_name),
            &own,
            &ancestors,
        );
        Ok(assemble_apps(&groups, describe))
    }

    /// Check a picked app's root pid is still there and is not OwnCord.
    pub fn resolve_music_pid(pid: u32) -> Result<u32, String> {
        let parents = parent_map()?;
        let me = std::process::id();
        let own = own_process_tree(me, &parents);
        let ancestors = own_process_ancestors(me, &parents);
        check_music_target(pid, &parents, &own, &ancestors).map_err(str::to_string)
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

    // -- music share -------------------------------------------------------

    #[test]
    fn parses_app_ids() {
        assert_eq!(parse_app_id("pid:4242"), Some(4242));
        assert_eq!(app_id(7), "pid:7");
        for bad in [
            "",
            "pid:",
            "pid:0",
            "pid:-1",
            "pid:+5",
            "pid:007",
            "pid: 5",
            "pid:5 ",
            "PID:5",
            "pid:5:6",
            "5",
            "window:5:0",
            "pid:99999999999999999999",
        ] {
            assert_eq!(parse_app_id(bad), None, "{bad:?}");
        }
    }

    fn exes(map: &[(u32, &str)]) -> impl Fn(u32) -> Option<String> {
        let map: HashMap<u32, String> = map.iter().map(|(p, e)| (*p, e.to_lowercase())).collect();
        move |pid| map.get(&pid).cloned()
    }

    fn session(pid: u32, playing: bool) -> AudioSession {
        AudioSession { pid, playing }
    }

    #[test]
    fn child_sessions_group_under_the_topmost_same_exe_ancestor() {
        // explorer(1) > spotify(10) > spotify(11) > spotify(12); chrome(20) > chrome(21)
        let parents = HashMap::from([(10, 1), (11, 10), (12, 11), (20, 1), (21, 20), (1, 0)]);
        let exe = exes(&[
            (1, "explorer.exe"),
            (10, "spotify.exe"),
            (11, "Spotify.exe"),
            (12, "spotify.exe"),
            (20, "chrome.exe"),
            (21, "chrome.exe"),
        ]);
        let groups = group_sessions(
            &[
                session(12, false),
                session(11, true),
                session(21, false),
                session(20, false),
            ],
            &parents,
            exe,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(
            groups,
            vec![
                AppGroup {
                    root_pid: 10,
                    playing: true
                },
                AppGroup {
                    root_pid: 20,
                    playing: false
                },
            ]
        );
    }

    #[test]
    fn grouping_skips_system_sounds_own_tree_and_ancestors() {
        let parents = HashMap::from([(5, 1), (6, 5), (7, 6), (30, 5), (1, 0)]);
        let exe = exes(&[
            (5, "x.exe"),
            (6, "owncord.exe"),
            (7, "owncord.exe"),
            (30, "app.exe"),
        ]);
        let own = HashSet::from([6, 7]);
        let ancestors = HashSet::from([5]);
        let groups = group_sessions(
            &[
                session(0, true),
                session(7, true),
                session(5, true),
                session(30, true),
            ],
            &parents,
            exe,
            &own,
            &ancestors,
        );
        assert_eq!(
            groups,
            vec![AppGroup {
                root_pid: 30,
                playing: true
            }]
        );
    }

    #[test]
    fn grouping_does_not_climb_into_other_exes_or_unknown_or_cycles() {
        let parents = HashMap::from([(2, 1), (3, 2), (8, 9), (9, 8)]);
        // 3 -> 2 differs; 8 and 9 are the same exe but a stale cycle.
        let exe = exes(&[
            (2, "launcher.exe"),
            (3, "game.exe"),
            (8, "a.exe"),
            (9, "a.exe"),
        ]);
        let groups = group_sessions(
            &[session(3, true), session(42, false), session(8, false)],
            &parents,
            exe,
            &HashSet::new(),
            &HashSet::new(),
        );
        let roots: HashSet<u32> = groups.iter().map(|g| g.root_pid).collect();
        assert!(roots.contains(&3) && roots.contains(&42));
        assert_eq!(groups.len(), 3);
        assert!(groups.iter().all(|g| g.root_pid != 2));
    }

    #[test]
    fn rows_sort_playing_first_then_name() {
        let groups = [
            AppGroup {
                root_pid: 1,
                playing: false,
            },
            AppGroup {
                root_pid: 2,
                playing: true,
            },
            AppGroup {
                root_pid: 3,
                playing: false,
            },
            AppGroup {
                root_pid: 4,
                playing: true,
            },
        ];
        let rows = assemble_apps(&groups, |pid| {
            let name = match pid {
                1 => "Zed",
                2 => "spotify",
                3 => "Audacity",
                _ => "Foobar2000",
            };
            (name.to_string(), None)
        });
        let order: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(order, ["Foobar2000", "spotify", "Audacity", "Zed"]);
        assert_eq!(rows[0].id, "pid:4");
        assert!(rows[0].playing && !rows[3].playing);
    }

    #[test]
    fn rows_serialize_camel_case() {
        let row = AudioApp {
            id: "pid:1".into(),
            name: "A".into(),
            icon: None,
            playing: true,
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "pid:1", "name": "A", "icon": null, "playing": true})
        );
    }

    #[test]
    fn exe_names_from_paths() {
        assert_eq!(
            exe_file_name(r"C:\Users\a\Spotify.EXE").as_deref(),
            Some("spotify.exe")
        );
        assert_eq!(
            exe_stem(r"C:\Program Files\foobar2000\foobar2000.exe").as_deref(),
            Some("foobar2000")
        );
        assert_eq!(exe_stem("noext").as_deref(), Some("noext"));
        assert_eq!(exe_file_name(r"C:\dir\"), None);
    }

    #[test]
    fn music_target_refuses_own_ancestors_and_dead() {
        let parents = HashMap::from([(10, 1), (11, 10), (50, 1), (1, 0)]);
        let own = HashSet::from([10, 11]);
        let ancestors = HashSet::from([1]);
        assert_eq!(check_music_target(50, &parents, &own, &ancestors), Ok(50));
        for pid in [0, 10, 11, 1, 99] {
            assert_eq!(
                check_music_target(pid, &parents, &own, &ancestors),
                Err("not_found")
            );
        }
    }

    #[test]
    fn icon_alpha_comes_from_the_mask_when_the_bitmap_has_none() {
        // two pixels, BGRA, no alpha; the second is masked out
        let bgra = [1, 2, 3, 0, 4, 5, 6, 0];
        let mask = [0, 0, 0, 0, 255, 255, 255, 0];
        assert_eq!(
            icon_rgba(2, 1, &bgra, Some(&mask)),
            Some(vec![3, 2, 1, 255, 6, 5, 4, 0])
        );
        // with real alpha the mask is ignored
        let bgra = [1, 2, 3, 128, 4, 5, 6, 0];
        assert_eq!(
            icon_rgba(2, 1, &bgra, Some(&mask)),
            Some(vec![3, 2, 1, 128, 6, 5, 4, 0])
        );
        assert_eq!(icon_rgba(2, 1, &bgra[..7], None), None);
        assert_eq!(icon_rgba(0, 0, &[], None), None);
    }

    #[test]
    fn icons_are_fitted_to_32_square() {
        let big = vec![7u8; 64 * 64 * 4];
        assert_eq!(fit_icon(64, 64, &big).map(|v| v.len()), Some(32 * 32 * 4));
        let small = vec![9u8; 16 * 16 * 4];
        assert_eq!(fit_icon(16, 16, &small).map(|v| v.len()), Some(32 * 32 * 4));
        assert_eq!(fit_icon(2, 2, &[0; 3]), None);
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (raw, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(raw.as_bytes()), want);
        }
    }

    #[test]
    fn checksums_match_known_values() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn png_has_the_right_structure() {
        let rgba: Vec<u8> = (0..32 * 32 * 4).map(|i| (i % 251) as u8).collect();
        let png = encode_png(32, 32, &rgba).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        // IEND's CRC is the well-known constant
        assert_eq!(&png[png.len() - 4..], &[0xAE, 0x42, 0x60, 0x82]);
        assert_eq!(encode_png(2, 2, &[0; 15]), None);
        assert_eq!(encode_png(0, 2, &[]), None);
        let url = icon_data_url(32, 32, &vec![255u8; 32 * 32 * 4], None).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }

    // The two slots are independent: a stop or start of one never touches
    // the other's running capture or its in-flight starts.
    #[test]
    fn music_and_screen_slots_interleave_independently() {
        let mut screen: Slot<&str> = Slot::default();
        let mut music: Slot<&str> = Slot::default();
        let (s1, _) = screen.begin();
        assert!(screen.install(s1, "screen-1").is_ok());
        let (m1, _) = music.begin();
        assert!(music.install(m1, "music-1").is_ok());

        // a screen stop takes the screen capture only
        assert_eq!(screen.cancel(), Some("screen-1"));
        assert!(music.is_current(m1));

        // a music restart replaces music; screen is not involved
        let (m2, old) = music.begin();
        assert_eq!(old, Some("music-1"));
        let (s2, _) = screen.begin();
        // a music stop while a screen start is in flight leaves that start valid
        assert_eq!(music.cancel(), None);
        assert!(screen.is_current(s2));
        // the music start the stop overtook is rejected, the screen one lands
        assert_eq!(music.install(m2, "music-2"), Err("music-2"));
        assert_eq!(screen.install(s2, "screen-2"), Ok(None));
        assert_eq!(screen.cancel(), Some("screen-2"));
    }

    #[test]
    fn a_new_music_start_supersedes_the_one_in_flight() {
        let mut music: Slot<&str> = Slot::default();
        let (first, _) = music.begin();
        let (second, _) = music.begin();
        assert_eq!(music.install(first, "a"), Err("a"));
        assert_eq!(music.install(second, "b"), Ok(None));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn off_windows_the_music_commands_are_unavailable() {
        assert_eq!(list_audio_apps().await, Err("unavailable".to_string()));
        assert_eq!(platform::list_apps(), Err("unavailable".to_string()));
        assert_eq!(
            platform::resolve_music_pid(1),
            Err("unavailable".to_string())
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_host_is_unavailable() {
        assert!(!app_audio_available());
        assert_eq!(platform::resolve_pid("x"), Err("unavailable".to_string()));
    }
}
