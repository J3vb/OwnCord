//! Native LiveKit backend for Linux voice — the Tauri command surface.
//!
//! No mainstream WebKitGTK build ships WebRTC, so the system webview on Linux
//! has no `RTCPeerConnection` and the browser LiveKit path cannot work there.
//! The approved design (`docs/architecture/voice-e2ee.md`) runs the LiveKit
//! Rust SDK in this backend on Linux only, with the webview kept as the UI:
//! `Client/src/features/voice/native/` drives these commands from behind the
//! `livekitSession` facade. The TS E2EE key exchange is unchanged; only the
//! final room key crosses IPC (`native_voice_set_key`), so encryption stays
//! byte-compatible with Windows clients.
//!
//! Sessions are numbered so a superseded join can tear down exactly its own
//! room (`native_voice_disconnect` is a no-op for any other id), mirroring
//! the facade's "cleanup is scoped to the attempt's own room" rule.
//! Room events reach the webview as one Tauri event, `native-voice`, whose
//! payload carries the session id. Video frames do not cross IPC: each
//! session serves them on its own token-authenticated loopback socket
//! (`video.rs`), whose URL the connect result carries. Screen share captures
//! natively (`screen.rs`): the webview picks a source, or leaves the pick to
//! the desktop portal on Wayland, and sees the capture only as a preview on
//! the frame socket. Key material and the frame-socket token are never
//! logged.
pub mod app_sound;
pub mod camera;
pub mod capture;
mod hotplug;
pub mod mic_test;
pub mod playout;
pub mod screen;
pub mod session;
pub mod share_audio;
pub mod stats;
pub mod stream_format;
pub mod video;

use mic_test::{
    level_event, MicTest, MicTestEnvelope, MicTestEvent, MicTestOptions, MicTestUpdate,
    MIC_TEST_EVENT, MIC_TEST_IN_CALL,
};
use serde::Serialize;
use session::{
    AudioOptions, CameraOptions, Event, NativeSession, QualityError, Resources, ScreenOptions,
};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;

/// The Tauri event every room event is delivered on.
pub const EVENT_NAME: &str = "native-voice";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    session: u64,
    event: Event,
}

/// A camera preview outside any room (the settings tab): its own frame socket
/// and a capture, kept alive until stopped or replaced. The socket is dropped
/// (and so closed) with the preview; `Drop` holds it only for that side effect.
struct Standalone {
    #[allow(dead_code)]
    frames: video::FrameServer,
    _capture: camera::CameraCapture,
}

#[derive(Default)]
struct Inner {
    /// Key material for the next/current room. Set before connect by the TS
    /// key exchange, rotated in place, cleared on leave.
    key: Option<Vec<u8>>,
    session: Option<(u64, NativeSession)>,
    /// The out-of-call camera preview (settings tab).
    standalone: Option<Standalone>,
    /// The latest out-of-call camera preview start, so overlapping starts
    /// cannot leave an older capture owning the single slot.
    standalone_generation: u64,
    next_id: u64,
    /// The settings tab's mic test, under the id its events carry. Never
    /// filled while `session` is.
    mic_test: Option<(u64, MicTest)>,
    /// The latest mic test start (or stop), so an overlapping start cannot
    /// leave an older test owning the slot. Equals the slot's id whenever
    /// the slot is filled.
    mic_test_generation: u64,
}

impl Inner {
    fn current(&mut self, id: u64) -> Result<&mut NativeSession, String> {
        match &mut self.session {
            Some((sid, s)) if *sid == id => Ok(s),
            _ => Err(format!("native voice session {id} is not current")),
        }
    }
    /// After an unlocked connect of session `id` with `connected_key`: the
    /// key it must switch to (`Some` when a rotation landed meanwhile), or
    /// an error when a newer connect or a leave (cleared key) superseded it.
    fn key_after_connect(&self, id: u64, connected_key: &[u8]) -> Result<Option<Vec<u8>>, String> {
        match &self.key {
            Some(k) if self.next_id == id => Ok((k.as_slice() != connected_key).then(|| k.clone())),
            _ => Err(format!(
                "native voice session {id} superseded during connect"
            )),
        }
    }
    fn resources(&self) -> Resources {
        match &self.session {
            Some((_, s)) => s.resources(),
            None => Resources {
                threads: session::process_threads(),
                screen_captures: screen::active_captures(),
                camera_captures: camera::active_captures(),
                ..Default::default()
            },
        }
    }
    /// Start a new out-of-call camera preview; returns its generation. A
    /// later [`Inner::standalone_is_latest`] with an older generation is false.
    fn begin_standalone(&mut self) -> u64 {
        self.standalone_generation += 1;
        self.standalone_generation
    }
    /// Whether `generation` is still the latest preview start. A superseded
    /// start must drop its own capture instead of claiming the slot.
    fn standalone_is_latest(&self, generation: u64) -> bool {
        self.standalone_generation == generation
    }
    /// Supersede any in-flight mic test start and take the current test out
    /// (to be released off the lock).
    fn take_mic_test(&mut self) -> Option<(u64, MicTest)> {
        self.mic_test_generation += 1;
        self.mic_test.take()
    }
    fn mic_test_blocked(&self) -> bool {
        mic_test_blocked(self.session.is_some())
    }
    /// Begin a mic test: the old one to release, the new test's id and the
    /// connect count it must still see when it finishes opening.
    #[allow(clippy::type_complexity)]
    fn begin_mic_test(&mut self) -> Result<(Option<(u64, MicTest)>, u64, u64), String> {
        if self.mic_test_blocked() {
            return Err(MIC_TEST_IN_CALL.to_string());
        }
        let old = self.take_mic_test();
        Ok((old, self.mic_test_generation, self.next_id))
    }
    /// Whether the start `id` that saw `connects_seen` connects may claim
    /// the slot: no call began meanwhile and nothing superseded it.
    fn admit_mic_test(&self, id: u64, connects_seen: u64) -> Result<(), String> {
        if self.mic_test_blocked() || self.next_id != connects_seen {
            Err(MIC_TEST_IN_CALL.to_string())
        } else if self.mic_test_generation != id {
            Err("mic test superseded".to_string())
        } else {
            Ok(())
        }
    }
    /// Stop test `id`, unless it is stale.
    fn stop_mic_test(&mut self, id: u64) -> Option<(u64, MicTest)> {
        (id == self.mic_test_generation)
            .then(|| self.take_mic_test())
            .flatten()
    }
    /// The call camera's preview, when a call has its camera running.
    fn call_camera_preview(&self) -> Option<(String, (u32, u32))> {
        self.session.as_ref().and_then(|(_, s)| s.camera_preview())
    }
    /// Supersede any in-flight start and release the current preview.
    fn clear_standalone(&mut self) {
        self.standalone_generation += 1;
        self.standalone = None;
    }
}

/// A mic test never runs during a call. A seam over `Inner::session`, which
/// a unit test cannot build.
fn mic_test_blocked(has_session: bool) -> bool {
    has_session
}

#[derive(Default)]
pub struct NativeVoiceState {
    inner: Mutex<Inner>,
    /// The app-level device watcher, filled once by
    /// `native_voice_watch_devices` and kept for the app's life. A std mutex
    /// held only to test or fill the slot, separate from `inner`, the tokio
    /// mutex held across awaits: the two are never taken together.
    devices_watch: std::sync::Mutex<Option<hotplug::DevicesWatch>>,
}

impl NativeVoiceState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn wipe(key: &mut Option<Vec<u8>>) {
    if let Some(mut k) = key.take() {
        k.iter_mut().for_each(|b| *b = 0);
    }
}

/// Report the native LiveKit SDK version and confirm libwebrtc is linked
/// (phase 0's proof that the prebuilt archive matched the toolchain).
#[tauri::command]
pub fn native_voice_build_info() -> String {
    let probe = livekit::webrtc::native::create_random_uuid();
    format!("livekit {} libwebrtc-ok {probe}", livekit::SDK_VERSION)
}

/// Install or rotate the room key. `key` is the base64 text livekit-client
/// would receive in `ExternalE2EEKeyProvider.setKey`; see
/// `session::shared_key_material` for why it is used as text.
#[tauri::command]
pub async fn native_voice_set_key(
    state: tauri::State<'_, NativeVoiceState>,
    key: String,
) -> Result<(), String> {
    let material = session::shared_key_material(&key);
    let mut inner = state.inner.lock().await;
    if let Some((_, s)) = &inner.session {
        s.set_key(material.clone());
    }
    wipe(&mut inner.key);
    inner.key = Some(material);
    log::debug!("[native_voice] room key installed");
    Ok(())
}

/// Forget the room key (leave). The live room, if any, keeps the key it has
/// until it is closed — the facade closes it in the same teardown.
#[tauri::command]
pub async fn native_voice_clear_key(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<(), String> {
    wipe(&mut state.inner.lock().await.key);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    /// The id the other commands and every `native-voice` event carry.
    session: u64,
    /// Our LiveKit identity (`user-<id>...`), for the participant model.
    identity: String,
    /// The session's frame-socket base URL, token included.
    frames: String,
}

/// Connect a new session, superseding any live one.
///
/// The state lock is held only to take the key, retire the old session and
/// allocate the id — never across the network connect — so a leave, a key
/// rotation or a device switch during a slow join is not blocked behind it.
/// A connect that loses the race to a newer one closes its own room and
/// reports it, the same supersession outcome the facade's checkpoints expect.
#[tauri::command]
pub async fn native_voice_connect<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, NativeVoiceState>,
    url: String,
    token: String,
    audio: AudioOptions,
) -> Result<Connected, String> {
    let (id, key, superseded, test) = {
        let mut inner = state.inner.lock().await;
        let key = inner
            .key
            .clone()
            .ok_or("no E2EE room key installed before connect")?;
        // Take the old session out under the lock but close it after
        // releasing it: close() awaits the SFU, and holding the state lock
        // across that serialised a fast leave→join behind the old teardown
        // (voice #20).
        let superseded = inner.session.take();
        inner.next_id += 1;
        (inner.next_id, key, superseded, inner.take_mic_test())
    };
    // A test and a call never run together.
    end_mic_test(&app, test).await;
    if let Some((old, s)) = superseded {
        log::info!("[native_voice] superseding session {old}");
        s.close().await;
    }
    let sink_app = app.clone();
    let on_event = std::sync::Arc::new(move |event: Event| {
        if let Err(e) = sink_app.emit(EVENT_NAME, Envelope { session: id, event }) {
            log::warn!("[native_voice] event emit failed: {e}");
        }
    });
    let mut connected_key = Some(key.clone());
    let mut session = NativeSession::connect(&url, &token, key, on_event).await?;
    // Playout is needed even for a listen-only join.
    session.enable_audio(audio);
    let identity = session.local_identity();
    let mut inner = state.inner.lock().await;
    let rotated = inner.key_after_connect(id, connected_key.as_deref().unwrap_or_default());
    wipe(&mut connected_key);
    match rotated {
        Err(e) => {
            log::info!("[native_voice] {e}");
            session.close().await;
            return Err(e);
        }
        Ok(Some(k)) => session.set_key(k),
        Ok(None) => {}
    }
    log::info!("[native_voice] session {id} connected as {identity}");
    let frames = session.frames_url().to_string();
    inner.session = Some((id, session));
    // A test start that finished between the two locks.
    let late = inner.take_mic_test();
    drop(inner);
    end_mic_test(&app, late).await;
    Ok(Connected {
        session: id,
        identity,
        frames,
    })
}

/// Tell the webview test `t` ended, then release it off the runtime.
async fn end_mic_test<R: Runtime>(app: &AppHandle<R>, t: Option<(u64, MicTest)>) {
    let Some((test, mic_test)) = t else {
        return;
    };
    let envelope = MicTestEnvelope {
        test,
        event: MicTestEvent::Ended,
    };
    if let Err(e) = app.emit(MIC_TEST_EVENT, envelope) {
        log::warn!("[native_voice] mic test event emit failed: {e}");
    }
    mic_test::release(Some(mic_test)).await;
}

/// Start the settings tab's mic test: the chosen microphone, with the call's
/// processing, gain and gate, played on the chosen output (`monitor`: levels
/// only, no output; the meter and the diagnostics check use it). Replaces a
/// running test or monitor and is refused during a call; a call that joins
/// meanwhile ends it.
/// Resolves with the test's id once the streams are open.
#[tauri::command]
pub async fn native_voice_start_mic_test<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, NativeVoiceState>,
    options: MicTestOptions,
) -> Result<u64, String> {
    let (replaced, id, seen) = state.inner.lock().await.begin_mic_test()?;
    mic_test::release(replaced.map(|(_, t)| t)).await;
    let sink_app = app.clone();
    let on_event: session::EventSink = std::sync::Arc::new(move |event: Event| {
        let Some(event) = level_event(event) else {
            return;
        };
        if let Err(e) = sink_app.emit(MIC_TEST_EVENT, MicTestEnvelope { test: id, event }) {
            log::warn!("[native_voice] mic test event emit failed: {e}");
        }
    });
    let (on_gate, on_level, reports) = session::capture_report_sinks(on_event);
    let test =
        tokio::task::spawn_blocking(move || MicTest::start(options, on_gate, on_level, reports))
            .await
            .map_err(|e| e.to_string())??;
    let mut inner = state.inner.lock().await;
    match inner.admit_mic_test(id, seen) {
        Ok(()) => {
            inner.mic_test = Some((id, test));
            Ok(id)
        }
        Err(e) => {
            drop(inner);
            mic_test::release(Some(test)).await;
            Err(e)
        }
    }
}

/// Apply a live change to mic test `test`. A stale id is a no-op.
#[tauri::command]
pub async fn native_voice_update_mic_test(
    state: tauri::State<'_, NativeVoiceState>,
    test: u64,
    update: MicTestUpdate,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    match &mut inner.mic_test {
        Some((id, t)) if *id == test => t.update(update),
        _ => Ok(()),
    }
}

/// Stop mic test `test`. A stale id is a no-op.
#[tauri::command]
pub async fn native_voice_stop_mic_test(
    state: tauri::State<'_, NativeVoiceState>,
    test: u64,
) -> Result<(), String> {
    let stopped = state.inner.lock().await.stop_mic_test(test);
    mic_test::release(stopped.map(|(_, t)| t)).await;
    Ok(())
}

/// Enumerate the audio host's capture and playout devices, in or out of a
/// call (the settings tab lists devices outside one).
#[tauri::command]
pub async fn native_voice_list_devices() -> Result<session::Devices, String> {
    // Enumerating talks to the sound server and blocks.
    tokio::task::spawn_blocking(session::list_devices)
        .await
        .map_err(|e| e.to_string())
}

/// Start the app-level device watcher if it is not running, then return at
/// once: the watcher thread does the first listing. Every change of the
/// capture or playout lists afterwards is emitted as `native-voice-devices`
/// (a trigger; the webview re-lists). Idempotent, never stopped by the webview.
#[tauri::command]
pub async fn native_voice_watch_devices<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<(), String> {
    hotplug::ensure_watch(&state.devices_watch, || {
        hotplug::DevicesWatch::start(
            hotplug::POLL_EVERY,
            hotplug::host_lister(),
            move |devices| {
                if let Err(e) = app.emit(hotplug::DEVICES_EVENT, devices) {
                    log::warn!("[native_voice] device change event failed: {e}");
                }
            },
        )
    });
    Ok(())
}

/// Play an app sound: synthesize `notes` at `gain` and play them
/// once on output `device_id` (empty or unknown: the default), in or out of a
/// call. Resolves with an id `native_voice_stop_sound` takes; a host failure
/// (no device, open failed) rejects and the webview falls back to Web Audio.
/// The registry is its own managed state, never held with `inner`.
#[tauri::command]
pub async fn native_voice_play_sound(
    sounds: tauri::State<'_, app_sound::AppSounds>,
    notes: Vec<app_sound::ToneNote>,
    device_id: String,
    gain: f32,
) -> Result<u64, String> {
    let sounds = sounds.inner().clone();
    app_sound::play(&sounds, notes, device_id, gain).await
}

/// Cut app sound `id` (a ring burst); an unknown or finished id is a no-op.
#[tauri::command]
pub async fn native_voice_stop_sound(
    sounds: tauri::State<'_, app_sound::AppSounds>,
    id: u64,
) -> Result<(), String> {
    app_sound::stop(&sounds, id);
    Ok(())
}

/// Select the capture (`kind == "audioinput"`) or playout (`"audiooutput"`)
/// device by the id `native_voice_list_devices` reported; an empty id means
/// the platform default.
#[tauri::command]
pub async fn native_voice_set_device(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    kind: String,
    device_id: String,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_device(&kind, &device_id)
}

/// Close session `session` if it is still the live one.
#[tauri::command]
pub async fn native_voice_disconnect(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
) -> Result<Resources, String> {
    let closing = {
        let mut inner = state.inner.lock().await;
        if matches!(&inner.session, Some((id, _)) if *id == session) {
            // Take it out under the lock, close it after releasing: close()
            // awaits the SFU, and holding the lock across it blocked every
            // other command (voice #20).
            inner.session.take()
        } else {
            None
        }
    };
    if let Some((_, s)) = closing {
        s.close().await;
        log::info!("[native_voice] session {session} closed");
    }
    Ok(state.inner.lock().await.resources())
}

#[tauri::command]
pub async fn native_voice_set_microphone(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    enabled: bool,
    bitrate: Option<u64>,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_microphone(enabled, bitrate)
        .await
}

/// Close or open push-to-talk's gate on `session`'s microphone.
#[tauri::command]
pub async fn native_voice_set_ptt_gated(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    gated: bool,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_ptt_gated(gated);
    Ok(())
}

/// Set the input-sensitivity gate on `session`'s microphone: the RMS level
/// (web path's `vadThreshold` scale) that counts as speech, 0 for no gate.
/// `retune` moves the level without restarting the detector, for automatic
/// sensitivity's steps.
#[tauri::command]
pub async fn native_voice_set_voice_gate(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    threshold: f32,
    retune: Option<bool>,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_voice_gate(threshold, retune.unwrap_or(false));
    Ok(())
}

/// Set `session`'s input volume, 0-200 % as the web path's `inputVolume`
/// pref: a linear gain on the processed microphone, before the voice gate.
#[tauri::command]
pub async fn native_voice_set_input_gain(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    percent: f32,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_input_gain(percent / 100.0);
    Ok(())
}

/// Apply `audio` (echo cancellation, noise suppression, automatic gain
/// control, Enhanced Noise Suppression) to `session`'s running call: the
/// capture and the echo canceller's reference switch to it within a few
/// frames, with the microphone unmuted or not.
#[tauri::command]
pub async fn native_voice_set_audio_processing(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    audio: AudioOptions,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_audio_processing(audio);
    Ok(())
}

/// List the GStreamer `Video/Source` cameras (V4L2 and PipeWire), in or out
/// of a call: the ids `native_voice_start_camera` takes.
#[tauri::command]
pub async fn native_voice_list_cameras() -> Result<Vec<camera::CameraDevice>, String> {
    // The monitor runs a discovery pass and blocks.
    tokio::task::spawn_blocking(session::list_cameras)
        .await
        .map_err(|e| e.to_string())
}

/// Whether the host can capture cameras: GStreamer initialises and the capture
/// pipeline's required elements exist. A minimal Linux install without the
/// GStreamer plugin packages reports unavailable with the missing element
/// names, so the webview can say why no camera appears instead of showing an
/// empty list.
#[tauri::command]
pub async fn native_voice_camera_support() -> Result<camera::CameraSupport, String> {
    tokio::task::spawn_blocking(camera::support)
        .await
        .map_err(|e| e.to_string())
}

/// Which video codecs the native engine can encode beyond VP8.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCodecs {
    /// libwebrtc's sender capabilities list `video/H264`: its software
    /// encoder (OpenH264) is built in.
    pub h264: bool,
    /// libwebrtc's sender capabilities list `video/VP9`.
    pub vp9: bool,
    /// The lowercased codec subtypes (`vp8`, `h264`, `vp9`, ...) libwebrtc's
    /// receiver capabilities list, without the rtx, red and fec entries. The
    /// webview intersects it with what it can decrypt before announcing it.
    pub decode: Vec<String>,
}

/// Whether a sender-capability mime type is H.264, ignoring case.
fn is_h264_mime(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("video/H264")
}

/// Whether a sender-capability mime type is VP9, ignoring case.
fn is_vp9_mime(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("video/VP9")
}

/// The codec subtype of a receiver-capability mime type, lowercased, or
/// `None` for the retransmission and redundancy entries that are not codecs.
fn decode_codec_name(mime: &str) -> Option<String> {
    let name = mime.split('/').nth(1)?.to_ascii_lowercase();
    let is_support =
        matches!(name.as_str(), "rtx" | "red" | "ulpfec") || name.starts_with("flexfec");
    if name.is_empty() || is_support {
        None
    } else {
        Some(name)
    }
}

/// The distinct decodable codec names of a receiver-capability mime list, in
/// the order libwebrtc lists them.
fn decode_names<'a>(mimes: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in mimes.filter_map(decode_codec_name) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Ask libwebrtc which video codecs it can send. Synchronous: callers off the
/// async runtime (the interop example) use it directly.
pub fn probe_video_codecs() -> VideoCodecs {
    // Outside a call this makes `LkRuntime::instance()` build the libwebrtc
    // factory just for the probe; acceptable, as the webview asks once (memoised).
    let runtime = livekit::rtc_engine::lk_runtime::LkRuntime::instance();
    let factory = runtime.pc_factory();
    let send = factory.get_rtp_sender_capabilities(livekit::webrtc::MediaType::Video);
    let receive = factory.get_rtp_receiver_capabilities(livekit::webrtc::MediaType::Video);
    VideoCodecs {
        h264: send.codecs.iter().any(|c| is_h264_mime(&c.mime_type)),
        vp9: send.codecs.iter().any(|c| is_vp9_mime(&c.mime_type)),
        decode: decode_names(receive.codecs.iter().map(|c| c.mime_type.as_str())),
    }
}

/// The codecs this build's libwebrtc can send. The picker enables H.264 only
/// when this says so; a probe that fails reads as no H.264 in the webview.
#[tauri::command]
pub async fn native_voice_video_codecs() -> Result<VideoCodecs, String> {
    tokio::task::spawn_blocking(probe_video_codecs)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStarted {
    /// The id `native_voice_publish_camera`, `native_voice_stop_camera` and
    /// the `cameraCaptureEnded` event carry.
    capture: u64,
    width: u32,
    height: u32,
}

/// Start native capture of `source` (a `native_voice_list_cameras` id),
/// replacing any running capture, and resolve once the first frame arrives.
/// Camera capture runs in the host and keeps running while the webview
/// window is hidden. Frames then preview on the frame socket's `camera`
/// route; publishing is `native_voice_publish_camera`.
#[tauri::command]
pub async fn native_voice_start_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    source: String,
    capture: camera::CaptureOptions,
) -> Result<CameraStarted, String> {
    let target = camera::Target::parse(&source)?;
    let (id, started) = {
        let mut inner = state.inner.lock().await;
        inner.current(session)?;
        // The settings preview may hold the device: free it for the call,
        // whose camera the preview then shows.
        inner.clear_standalone();
        inner
            .current(session)?
            .start_camera(target, capture)
            .await?
    };
    let started = started
        .await
        .map_err(|_| "camera capture stopped before it started".to_string())
        .and_then(|r| r);
    let (width, height) = match started {
        Ok(size) => size,
        Err(e) => {
            // A capture that never started must not stay as the call's camera:
            // the settings preview would show its dead socket.
            if let Ok(s) = state.inner.lock().await.current(session) {
                s.stop_camera(id).await;
            }
            return Err(e);
        }
    };
    Ok(CameraStarted {
        capture: id,
        width,
        height,
    })
}

/// Use camera `source` instead under the live camera's publication (its sid
/// and preview socket stay): a new capture starts beside the live one, and
/// only once its first frame arrives does it take the publication over and the
/// old capture stop. Until then, and on any failure (a busy device, a stop or
/// leave meanwhile), the live camera is untouched. Resolves with the new
/// capture's id, which the webview then names to stop it.
#[tauri::command]
pub async fn native_voice_change_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    source: String,
    capture: camera::CaptureOptions,
) -> Result<CameraStarted, String> {
    let target = camera::Target::parse(&source)?;
    let (id, started) = state
        .inner
        .lock()
        .await
        .current(session)?
        .start_camera_change(target, capture)?;
    let started = started
        .await
        .map_err(|_| "camera capture stopped before it started".to_string())
        .and_then(|r| r);
    let mut inner = state.inner.lock().await;
    let s = inner.current(session)?;
    let finished = started.and_then(|size| s.finish_camera_change(id).map(|()| size));
    let (width, height) = match finished {
        Ok(size) => size,
        Err(e) => {
            s.stop_camera(id).await;
            return Err(e);
        }
    };
    Ok(CameraStarted {
        capture: id,
        width,
        height,
    })
}

/// Publish (or replace) running camera capture `capture`; its frames then go
/// to remote peers through the camera's `NativeVideoSource`. Returns the
/// publication sid `native_voice_unpublish_camera` takes.
#[tauri::command]
pub async fn native_voice_publish_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
    options: CameraOptions,
) -> Result<String, String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .publish_camera(capture, options)
        .await
}

/// Unpublish the screen share of running capture `capture`, keeping the
/// capture alive for a republish (a codec change). A stale id is a no-op.
#[tauri::command]
pub async fn native_voice_unpublish_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .unpublish_screen_keep_capture(capture)
        .await;
    Ok(())
}

/// Unpublish camera `sid` if it is still the published one; a stale sid is a
/// no-op. The capture keeps running for the self-view.
#[tauri::command]
pub async fn native_voice_unpublish_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    sid: String,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .unpublish_camera(&sid)
        .await;
    Ok(())
}

/// Unpublish and stop camera capture `capture`, releasing the pipeline and
/// the device; a stale id is a no-op.
#[tauri::command]
pub async fn native_voice_stop_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .stop_camera(capture)
        .await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPreviewStarted {
    width: u32,
    height: u32,
    /// The frame-socket base URL (token included): read `/camera` for the
    /// live preview.
    frames: String,
}

/// Start a camera capture and preview with no room (the settings tab), since
/// WebKitGTK cannot keep a camera alive while the window is hidden. Replaces
/// any earlier preview. Resolves once the first frame arrives; a start a newer
/// one superseded while it started rejects after releasing its own capture.
/// While a call's camera runs, the device is the call's: the preview is that
/// camera's own socket and no second capture starts.
#[tauri::command]
pub async fn native_voice_start_camera_preview(
    state: tauri::State<'_, NativeVoiceState>,
    source: String,
    capture: camera::CaptureOptions,
) -> Result<CameraPreviewStarted, String> {
    let target = camera::Target::parse(&source)?;
    let generation = {
        let mut inner = state.inner.lock().await;
        let generation = inner.begin_standalone();
        if let Some((frames, (width, height))) = inner.call_camera_preview() {
            inner.standalone = None;
            return Ok(CameraPreviewStarted {
                width,
                height,
                frames,
            });
        }
        generation
    };
    let (capturer, started) = camera::CameraCapture::start(target, capture, || {})?;
    let frames = video::FrameServer::bind().await?;
    frames.set_camera(Some(capturer.preview()));
    let url = frames.url().to_string();
    let (width, height) = started
        .await
        .map_err(|_| "camera preview stopped before it started".to_string())??;
    let mut inner = state.inner.lock().await;
    // A newer start or a stop superseded this one while it started: drop the
    // capture here rather than replacing the slot the newer request owns.
    if !inner.standalone_is_latest(generation) {
        return Err("camera preview superseded by a newer request".to_string());
    }
    inner.standalone = Some(Standalone {
        frames,
        _capture: capturer,
    });
    Ok(CameraPreviewStarted {
        width,
        height,
        frames: url,
    })
}

/// Stop the out-of-call camera preview (the settings tab), releasing the
/// pipeline and the device. Also supersedes any start still in flight, so it
/// drops its capture instead of storing it after the stop.
#[tauri::command]
pub async fn native_voice_stop_camera_preview(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<(), String> {
    state.inner.lock().await.clear_standalone();
    Ok(())
}

/// What can be shared: screens and windows with thumbnails on X11, or
/// `portal: true` on Wayland, where the desktop portal's dialog picks.
#[tauri::command]
pub async fn native_voice_screen_sources() -> Result<screen::Sources, String> {
    tauri::async_runtime::spawn_blocking(screen::list_sources)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStarted {
    /// The id `native_voice_publish_screen`, `native_voice_stop_screen` and
    /// the `screenCaptureEnded` event carry.
    capture: u64,
    width: u32,
    height: u32,
}

/// Start capturing `source` (a `native_voice_screen_sources` id, or
/// `portal`), replacing any running capture, and resolve once the first
/// frame arrives: on Wayland that is after the user completed the portal's
/// dialog, and a dialog that ends without one rejects with
/// [`screen::PORTAL_NOT_STARTED`]. The session is released while waiting,
/// so a leave or stop meanwhile ends the wait instead of queueing behind it.
/// Frames then preview on the frame socket's `screen` route.
#[tauri::command]
pub async fn native_voice_start_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    source: String,
    capture: screen::CaptureOptions,
) -> Result<ScreenStarted, String> {
    let target = screen::Target::parse(&source)?;
    let (id, started) = state
        .inner
        .lock()
        .await
        .current(session)?
        .start_screen(target, capture)
        .await?;
    let (width, height) = started
        .await
        .map_err(|_| "screen capture stopped before it started".to_string())??;
    Ok(ScreenStarted {
        capture: id,
        width,
        height,
    })
}

/// Share `source` instead under the live screen share's publication (its sid
/// stays, so viewers keep watching): a new capture starts beside the live
/// one, and only once its first frame arrives does it take the publication
/// over and the old capture stop. Until then, and on any failure (a portal
/// dialog closed without a pick, a stop or leave meanwhile), the live share
/// is untouched. Resolves with the new capture's id, which the webview then
/// names to stop it.
#[tauri::command]
pub async fn native_voice_change_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    source: String,
    capture: screen::CaptureOptions,
) -> Result<ScreenStarted, String> {
    let target = screen::Target::parse(&source)?;
    let (id, started) = state
        .inner
        .lock()
        .await
        .current(session)?
        .start_screen_change(target, capture)?;
    let started = started
        .await
        .map_err(|_| "screen capture stopped before it started".to_string())
        .and_then(|r| r);
    let mut inner = state.inner.lock().await;
    let s = inner.current(session)?;
    let finished = started.and_then(|size| s.finish_screen_change(id).map(|()| size));
    let (width, height) = match finished {
        Ok(size) => size,
        Err(e) => {
            s.stop_screen(id).await;
            return Err(e);
        }
    };
    Ok(ScreenStarted {
        capture: id,
        width,
        height,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenQualitySet {
    /// The new publication's sid; the old one is gone.
    sid: String,
    /// The size the capture now delivers, which the share is published at.
    width: u32,
    height: u32,
}

/// Change the quality of the live, published screen share `capture`: re-size
/// and re-pace its running capture (no new pick, no portal dialog) and
/// publish it again with `publish` at that size, which gives viewers a new
/// sid. The session stays held throughout, so a stop, source change or leave
/// queued behind it releases the new publication and one that came first
/// makes this refuse. Rejects `{stage: "refused"}` with nothing changed
/// (no published share, a stale `capture`, a source change pending) or
/// `{stage: "publish"}` once the screen video is unpublished (the capture
/// and the share audio stay up: stop the screen or retry the publish).
#[tauri::command]
pub async fn native_voice_set_screen_quality(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
    options: screen::CaptureOptions,
    publish: ScreenOptions,
) -> Result<ScreenQualitySet, QualityError> {
    let (sid, width, height) = state
        .inner
        .lock()
        .await
        .current(session)
        .map_err(QualityError::Refused)?
        .set_screen_quality(capture, options, publish)
        .await?;
    Ok(ScreenQualitySet { sid, width, height })
}

/// Publish running capture `capture` as the screen share; returns its sid.
#[tauri::command]
pub async fn native_voice_publish_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
    options: ScreenOptions,
) -> Result<String, String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .publish_screen(capture, options)
        .await
}

/// Publish the other applications' sound as capture `capture`'s audio; the
/// capture lives as long as the publication. Returns the sid.
#[tauri::command]
pub async fn native_voice_publish_screen_audio(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
) -> Result<String, String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .publish_screen_audio(capture)
        .await
}

/// Unpublish screen audio `sid` and end its capture; a stale sid is a no-op.
#[tauri::command]
pub async fn native_voice_unpublish_screen_audio(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    sid: String,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .unpublish_screen_audio(&sid)
        .await;
    Ok(())
}

/// Unpublish and stop capture `capture`, releasing the capturer and any
/// portal session; a stale id is a no-op.
#[tauri::command]
pub async fn native_voice_stop_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .stop_screen(capture)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn native_voice_set_subscribed(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    sid: String,
    subscribed: bool,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_subscribed(&identity, &sid, subscribed)
}

/// Layer control for one remote video: stop it (`enabled` false) or ask for
/// `quality` ("low", "medium" or "high"). The lock is held only for the
/// lookup, not across the settle wait.
#[tauri::command]
pub async fn native_voice_set_video_view(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    sid: String,
    enabled: bool,
    quality: String,
) -> Result<(), String> {
    let quality = session::video_quality(&quality)?;
    let publication = state
        .inner
        .lock()
        .await
        .current(session)?
        .remote_publication(&identity, &sid)?;
    session::set_video_view(&publication, enabled, quality).await;
    Ok(())
}

/// Per-user volume: `volume` is the gain for `identity`'s microphone (1.0 is
/// unity), the value the web path hands `RemoteParticipant.setVolume`.
#[tauri::command]
pub async fn native_voice_set_volume(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    volume: f32,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_volume(&identity, volume);
    Ok(())
}

/// Screen-share audio volume: the gain for `identity`'s screen-share audio (1.0
/// is unity, 0 when muted), the value the web path gives its audio element.
#[tauri::command]
pub async fn native_voice_set_screenshare_volume(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    volume: f32,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_screenshare_volume(&identity, volume);
    Ok(())
}

/// Native resource counts for `getSessionDebugInfo`.
#[tauri::command]
pub async fn native_voice_debug_info(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<Resources, String> {
    Ok(state.inner.lock().await.resources())
}

/// How long one stats read may take. The transport read runs under the
/// session lock, so a wedged signaling thread must not hold mute/PTT commands.
const STATS_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// One stats sample for the webview's connection panel, tile chip and Go Live
/// readout. A stale session or a failed or slow transport read is an
/// error (ping is the core output); a failed per-track read only drops that
/// track's sample.
#[tauri::command]
pub async fn native_voice_get_stats(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
) -> Result<stats::Stats, String> {
    // Only `Inner` is taken, no new lock. The transport stats need the room,
    // which lives in `Inner`, so they are read under it, bounded by
    // STATS_TIMEOUT, kept short so mute and the other commands never wait
    // long behind a stuck read. Per-track stats are read after the guard drops, from
    // Arc'd track handles.
    let at_ms = now_ms();
    let (transport, local, remote) = {
        let mut inner = state.inner.lock().await;
        let s = inner.current(session)?;
        let (local, remote) = s.stats_tracks();
        let transport = tokio::time::timeout(STATS_TIMEOUT, s.transport_stats())
            .await
            .map_err(|_| "native voice stats timed out".to_string())??;
        (transport, local, remote)
    };
    // Each track read has its own bound, so one slow track drops only its
    // own sample: the ping and the other tracks still arrive.
    let mut local_video = std::collections::BTreeMap::new();
    let mut remote_video = std::collections::BTreeMap::new();
    for (key, track) in local {
        match tokio::time::timeout(STATS_TIMEOUT, track.get_stats()).await {
            Ok(Ok(s)) => {
                local_video.insert(key, stats::sender_layers(&s));
            }
            Ok(Err(e)) => log::debug!("[native_voice] {key} sender stats: {e}"),
            Err(_) => log::debug!("[native_voice] {key} sender stats timed out"),
        }
    }
    for (sid, track) in remote {
        match tokio::time::timeout(STATS_TIMEOUT, track.get_stats()).await {
            Ok(Ok(s)) => {
                if let Some(r) = stats::receiver_sample(&s) {
                    remote_video.insert(sid, r);
                }
            }
            Ok(Err(e)) => log::debug!("[native_voice] {sid} receiver stats: {e}"),
            Err(_) => log::debug!("[native_voice] {sid} receiver stats timed out"),
        }
    }
    Ok(stats::Stats {
        at_ms,
        publisher: stats::transport_entries(&transport.0),
        subscriber: stats::transport_entries(&transport.1),
        remote_video,
        local_video,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Proves both that the SDK version is readable and that a libwebrtc symbol
    /// links and runs. If the prebuilt archive were missing or ABI-mismatched,
    /// this binary would not link at all.
    #[test]
    fn build_info_reports_sdk_and_libwebrtc() {
        let info = native_voice_build_info();
        assert!(info.contains("livekit 0.9.5"), "unexpected: {info}");
        assert!(info.contains("libwebrtc-ok"), "unexpected: {info}");
    }

    #[test]
    fn video_codecs_probe_runs() {
        // Either answer is valid for a build; the probe must not panic.
        let _ = probe_video_codecs();
        assert!(is_h264_mime("video/h264"));
        assert!(!is_h264_mime("video/VP8"));
        assert!(is_vp9_mime("video/vp9"));
        assert!(!is_vp9_mime("video/VP8"));
    }

    #[test]
    fn decode_names_lowercase_dedupe_and_drop_support_entries() {
        let mimes = [
            "video/VP8",
            "video/H264",
            "video/H264",
            "video/VP9",
            "video/rtx",
            "video/red",
            "video/ulpfec",
            "video/flexfec-03",
            "video/AV1",
        ];
        assert_eq!(
            decode_names(mimes.into_iter()),
            vec!["vp8", "h264", "vp9", "av1"]
        );
        assert!(decode_names(std::iter::empty()).is_empty());
        assert_eq!(decode_codec_name("video"), None);
    }

    #[test]
    fn wipe_zeroes_before_dropping() {
        let mut key = Some(vec![7u8; 4]);
        wipe(&mut key);
        assert!(key.is_none());
    }

    #[test]
    fn key_after_connect_applies_a_rotation_and_rejects_supersession() {
        let mut inner = Inner {
            key: Some(vec![1]),
            session: None,
            standalone: None,
            standalone_generation: 0,
            next_id: 3,
            ..Default::default()
        };
        assert_eq!(inner.key_after_connect(3, &[1]), Ok(None));
        inner.key = Some(vec![2]);
        assert_eq!(inner.key_after_connect(3, &[1]), Ok(Some(vec![2])));
        assert!(inner.key_after_connect(2, &[1]).is_err());
        inner.key = None;
        assert!(inner.key_after_connect(3, &[1]).is_err());
    }

    #[test]
    fn stale_session_ids_are_rejected() {
        let mut inner = Inner::default();
        assert!(inner.current(1).is_err());
        assert_eq!(inner.resources().rooms, 0);
    }

    #[test]
    fn a_superseded_camera_preview_start_does_not_claim_the_slot() {
        let mut inner = Inner::default();
        let older = inner.begin_standalone();
        let newer = inner.begin_standalone();
        // The older start finishes last: it must not claim the slot the newer
        // start owns.
        assert!(!inner.standalone_is_latest(older));
        assert!(inner.standalone_is_latest(newer));
        // A stop while a start is in flight supersedes it too.
        inner.clear_standalone();
        assert!(!inner.standalone_is_latest(newer));
    }

    /// A double start: the older one is superseded and drops its own test.
    #[test]
    fn a_second_mic_test_start_supersedes_the_first() {
        let mut inner = Inner::default();
        let (_, older, seen) = inner.begin_mic_test().unwrap();
        let (_, newer, _) = inner.begin_mic_test().unwrap();
        assert_ne!(older, newer);
        assert_eq!(
            inner.admit_mic_test(older, seen),
            Err("mic test superseded".to_string())
        );
        assert_eq!(inner.admit_mic_test(newer, seen), Ok(()));
    }

    #[test]
    fn stopping_a_mic_test_supersedes_its_start_and_ignores_stale_ids() {
        let mut inner = Inner::default();
        let (_, older, seen) = inner.begin_mic_test().unwrap();
        let (_, current, _) = inner.begin_mic_test().unwrap();
        assert!(inner.stop_mic_test(older).is_none());
        assert_eq!(
            inner.admit_mic_test(current, seen),
            Ok(()),
            "a stale stop leaves the current start admitted"
        );
        assert!(inner.stop_mic_test(current).is_none(), "nothing stored yet");
        assert!(inner.admit_mic_test(current, seen).is_err());
    }

    #[test]
    fn a_connect_ends_the_mic_test_and_refuses_one_still_starting() {
        let mut inner = Inner::default();
        let (_, id, seen) = inner.begin_mic_test().unwrap();
        // What `native_voice_connect` does under its first lock hold.
        assert!(inner.take_mic_test().is_none());
        inner.next_id += 1;
        assert_eq!(
            inner.admit_mic_test(id, seen),
            Err(MIC_TEST_IN_CALL.to_string())
        );
    }

    #[test]
    fn a_start_between_the_two_connect_locks_is_refused() {
        let mut inner = Inner::default();
        // First lock hold of `native_voice_connect`.
        assert!(inner.take_mic_test().is_none());
        inner.next_id += 1;
        // A start that begins after it sees the bumped connect count, so
        // only the second take can refuse it.
        let (_, id, seen) = inner.begin_mic_test().unwrap();
        assert!(inner.take_mic_test().is_none());
        assert!(inner.admit_mic_test(id, seen).is_err());
    }

    #[test]
    fn a_mic_test_cannot_start_during_a_call() {
        assert!(mic_test_blocked(true));
        assert!(!mic_test_blocked(false));
        let mut inner = Inner::default();
        assert!(!inner.mic_test_blocked());
        assert!(inner.begin_mic_test().is_ok());
    }

    fn idle_test(monitor: bool) -> MicTest {
        let audio = session::AudioOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
            enhanced_noise_suppression: false,
        };
        MicTest::idle_for_test(audio, monitor, tokio::spawn(async {}))
    }

    /// The meter's monitor holds the test slot: a test start takes it over, a
    /// stop of the old id is stale, and a connect takes it out.
    #[tokio::test]
    async fn a_mic_test_start_replaces_a_running_monitor_and_a_connect_ends_it() {
        let mut inner = Inner::default();
        let (_, monitor_id, seen) = inner.begin_mic_test().unwrap();
        inner.admit_mic_test(monitor_id, seen).unwrap();
        inner.mic_test = Some((monitor_id, idle_test(true)));
        let (replaced, test_id, seen) = inner.begin_mic_test().unwrap();
        assert_eq!(replaced.map(|(id, _)| id), Some(monitor_id));
        assert!(inner.stop_mic_test(monitor_id).is_none(), "stale id");
        inner.admit_mic_test(test_id, seen).unwrap();
        inner.mic_test = Some((test_id, idle_test(false)));
        let ended = inner.take_mic_test();
        assert_eq!(ended.map(|(id, _)| id), Some(test_id));
        assert!(inner.mic_test.is_none());
    }

    /// A monitor that finishes opening after a call joined must not claim
    /// the slot: the call's capture owns the device.
    #[test]
    fn a_monitor_that_finishes_after_a_connect_is_refused() {
        let mut inner = Inner::default();
        let (_, id, seen) = inner.begin_mic_test().unwrap();
        inner.next_id += 1;
        assert_eq!(
            inner.admit_mic_test(id, seen),
            Err(MIC_TEST_IN_CALL.to_string())
        );
    }
}
