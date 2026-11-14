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
mod codecs;
mod hotplug;
mod keys;
pub mod mic_test;
pub mod music;
pub mod page_gone;
pub mod playout;
mod quick;
pub mod screen;
pub mod session;
pub mod share_audio;
pub mod stats;
pub mod stream_format;
pub mod video;
pub mod volume;

#[cfg(test)]
use codecs::{decode_codec_name, decode_names, is_h264_mime, is_vp9_mime};
pub use codecs::{probe_video_codecs, VideoCodecs};
use keys::wipe;
use mic_test::{
    level_event, MicTest, MicTestEnvelope, MicTestEvent, MicTestOptions, MicTestUpdate,
    MIC_TEST_EVENT, MIC_TEST_IN_CALL,
};
use quick::{closing_error, unless_closing, QuickSlot};
use serde::Serialize;
use session::{
    release_blocking, AudioOptions, CameraOptions, Event, NativeSession, QualityError, Resources,
    Retired, ScreenOptions, VideoKind,
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
    /// The slot `key` is in and sent with.
    key_slot: i32,
    /// A key staged in the other slot (received with, not sent with yet).
    staged: Option<(i32, Vec<u8>)>,
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
    /// Supersede any in-flight start and take the current preview out, for
    /// the caller to release off the runtime.
    fn clear_standalone(&mut self) -> Option<Standalone> {
        self.standalone_generation += 1;
        self.standalone.take()
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
    /// Serialise the camera commands (start, change, stop, the settings
    /// preview) and the screen-share commands, each held through the release
    /// of a stopped capture, so a start issued behind a stop waits until the
    /// old device or portal session is free. Lock order: a gate, then
    /// `inner`; `inner` is never held while taking a gate. A gate is dropped
    /// before awaiting a first frame or a portal dialog, so a stop can end
    /// that wait. Microphone, device and leave commands never take a gate.
    camera_gate: Mutex<()>,
    screen_gate: Mutex<()>,
    /// The live session's push-to-talk, gain, volume and mute-hold controls
    /// and its close signal, reachable without `inner` (`quick.rs`).
    quick: QuickSlot,
    /// Bumped by every music start and stop, before anything is awaited. A
    /// start that finds it moved once it holds the session was superseded by
    /// a newer start or a stop, and publishes nothing. Not a gate: it is
    /// read and written without holding anything, and never held.
    music_ticket: std::sync::atomic::AtomicU64,
}

impl NativeVoiceState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Report the native LiveKit SDK version and confirm libwebrtc is linked
/// (phase 0's proof that the prebuilt archive matched the toolchain).
#[tauri::command]
pub fn native_voice_build_info() -> String {
    let probe = livekit::webrtc::native::create_random_uuid();
    format!("livekit {} libwebrtc-ok {probe}", livekit::SDK_VERSION)
}

/// A slot from the webview, checked against the key ring.
fn key_slot(slot: Option<i32>) -> Result<i32, String> {
    let slot = slot.unwrap_or(session::KEY_INDEX);
    if session::KEY_SLOTS.contains(&slot) {
        Ok(slot)
    } else {
        Err(format!("key slot {slot} out of range"))
    }
}

/// Install or rotate the room key. `key` is the base64 text livekit-client
/// would receive in `ExternalE2EEKeyProvider.setKey`; see
/// `session::shared_key_material` for why it is used as text. Without a
/// `slot` it goes in slot 0; `stage` keeps sending on the current key until
/// `native_voice_use_key_slot`.
#[tauri::command]
pub async fn native_voice_set_key(
    state: tauri::State<'_, NativeVoiceState>,
    key: String,
    slot: Option<i32>,
    stage: Option<bool>,
) -> Result<(), String> {
    let slot = key_slot(slot)?;
    let material = session::shared_key_material(&key);
    let mut inner = state.inner.lock().await;
    let staged = inner.install_key(material.clone(), slot, stage.unwrap_or(false));
    if let Some((_, s)) = &inner.session {
        if staged {
            s.stage_key(material, slot);
        } else {
            s.set_key(material, slot);
        }
    }
    log::debug!("[native_voice] room key installed in slot {slot} (staged: {staged})");
    Ok(())
}

/// Send with the room key already installed in `slot`.
#[tauri::command]
pub async fn native_voice_use_key_slot(
    state: tauri::State<'_, NativeVoiceState>,
    slot: i32,
) -> Result<(), String> {
    let slot = key_slot(Some(slot))?;
    let mut inner = state.inner.lock().await;
    if !inner.use_key_slot(slot) {
        return Err(format!("no room key in slot {slot}"));
    }
    if let Some((_, s)) = &inner.session {
        s.use_key_slot(slot);
    }
    log::debug!("[native_voice] sending with key slot {slot}");
    Ok(())
}

/// Forget the room key (leave). The live room, if any, keeps the key it has
/// until it is closed — the facade closes it in the same teardown.
#[tauri::command]
pub async fn native_voice_clear_key(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<(), String> {
    state.inner.lock().await.clear_keys();
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
    // A publish of the old session may hold the lock on the SFU: end it.
    state.quick.begin_close(None);
    let (id, key, superseded, test) = {
        let mut inner = state.inner.lock().await;
        let Some(key) = inner.key.clone() else {
            // Told to close above: finish it rather than leave it held silent.
            let stale = inner.session.take();
            state.quick.remove(None);
            drop(inner);
            if let Some((old, s)) = stale {
                log::info!("[native_voice] closing session {old}: connect without a room key");
                s.close().await;
            }
            return Err("no E2EE room key installed before connect".to_string());
        };
        // Take the old session out under the lock but close it after
        // releasing it: close() awaits the SFU, and holding the state lock
        // across that serialised a fast leave→join behind the old teardown
        // (voice #20).
        let superseded = inner.session.take();
        state.quick.remove(None);
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
    session.enable_audio(audio).await;
    let identity = session.local_identity();
    let mut inner = state.inner.lock().await;
    let rotated = inner.key_after_connect(id, connected_key.as_deref().unwrap_or_default());
    wipe(&mut connected_key);
    match rotated {
        Err(e) => {
            log::info!("[native_voice] {e}");
            // close() awaits the SFU: not under the lock.
            drop(inner);
            session.close().await;
            return Err(e);
        }
        Ok(rotated) => {
            // Connect installs the key in slot 0. A rotation that landed
            // meanwhile, or a call on slot 1, needs the current slots here.
            if rotated.is_some() || inner.key_slot != session::KEY_INDEX {
                if let Some(k) = inner.key.clone() {
                    session.set_key(k, inner.key_slot);
                }
            }
            if let Some((slot, k)) = inner.staged.clone() {
                session.stage_key(k, slot);
            }
        }
    }
    log::info!("[native_voice] session {id} connected as {identity}");
    let frames = session.frames_url().to_string();
    let (capture_controls, playout_controls) = session.quick_controls();
    inner.session = Some((id, session));
    state.quick.install(id, capture_controls, playout_controls);
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
    let switch = state
        .inner
        .lock()
        .await
        .current(session)?
        .device_switch(&kind)?;
    // The driver call runs without the session lock; a session that ended
    // meanwhile releases the switch's handles on the blocking thread and the
    // result is not reported.
    let result = tokio::task::spawn_blocking(move || switch.apply(&device_id))
        .await
        .map_err(|e| e.to_string())?;
    let live = state.inner.lock().await.current(session).is_ok();
    switch_outcome(session, live, result)
}

/// A device switch's result stands only while its session is still live.
fn switch_outcome(session: u64, live: bool, result: Result<(), String>) -> Result<(), String> {
    if live {
        result
    } else {
        Err(format!("native voice session {session} is not current"))
    }
}

/// Close session `session` if it is still the live one.
#[tauri::command]
pub async fn native_voice_disconnect(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
) -> Result<Resources, String> {
    // Quiet the microphone now and end a publish that holds the lock on the
    // SFU, so the leave does not wait behind it.
    state.quick.begin_close(Some(session));
    let closing = {
        let mut inner = state.inner.lock().await;
        if matches!(&inner.session, Some((id, _)) if *id == session) {
            // Take it out under the lock, close it after releasing: close()
            // awaits the SFU, and holding the lock across it blocked every
            // other command (voice #20).
            state.quick.remove(Some(session));
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
    // A mute goes quiet at once, ahead of a publish holding the lock.
    let request = state.quick.mic_request(session, enabled);
    let closing = state.quick.closing(session);
    // Decide under the lock, open or close the stream without it, then commit
    // under the lock again if this call is still the latest on a live session.
    let step = unless_closing(
        closing.clone(),
        async {
            let mut inner = state.inner.lock().await;
            let s = inner.current(session)?;
            if enabled {
                state.quick.release_hold(session, request);
            }
            Ok(s.begin_microphone(enabled, bitrate).await)
        },
        || closing_error(session),
    )
    .await?;
    let ran = tokio::task::spawn_blocking(move || step.run())
        .await
        .map_err(|e| e.to_string())??;
    let Some(commit) = ran else {
        return Ok(());
    };
    let (result, cleanup) = unless_closing(
        closing,
        async {
            let mut inner = state.inner.lock().await;
            Ok(inner.current(session)?.finish_microphone(commit).await)
        },
        || closing_error(session),
    )
    .await?;
    if let Some(stop) = cleanup {
        let stopped = tokio::task::spawn_blocking(move || stop.run())
            .await
            .map_err(|e| e.to_string());
        if let Ok(Err(e)) | Err(e) = stopped {
            log::warn!("[native_voice] capture stop: {e}");
        }
    }
    result
}

/// Close or open push-to-talk's gate on `session`'s microphone.
#[tauri::command]
pub async fn native_voice_set_ptt_gated(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    gated: bool,
) -> Result<(), String> {
    state.quick.get(session)?.capture.set_ptt_gated(gated);
    Ok(())
}

/// Set the input-sensitivity gate on `session`'s microphone: the RMS level
/// (web path's `vadThreshold` scale) that counts as speech, 0 for no gate.
/// `retune` moves the level without restarting the detector, for automatic
/// sensitivity's steps; `speech` makes the gate also ask RNNoise whether a
/// frame is a voice (the client sends it whenever a gate runs).
#[tauri::command]
pub async fn native_voice_set_voice_gate(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    threshold: f32,
    retune: Option<bool>,
    speech: Option<bool>,
) -> Result<(), String> {
    state.quick.get(session)?.capture.set_voice_gate(
        threshold,
        retune.unwrap_or(false),
        speech.unwrap_or(false),
    );
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
        .quick
        .get(session)?
        .capture
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
        let _gate = state.camera_gate.lock().await;
        let (standalone, retired) = {
            let mut inner = state.inner.lock().await;
            let retired = inner.current(session)?.release_camera().await;
            // The settings preview may hold the device: free it for the call,
            // whose camera the preview then shows.
            (inner.clear_standalone(), retired)
        };
        release_blocking(standalone).await;
        retired.release().await;
        state
            .inner
            .lock()
            .await
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
            stop_camera_capture(&state, session, id).await;
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
    let (id, started) = {
        let _gate = state.camera_gate.lock().await;
        // A superseded pending capture frees its device before the new one opens.
        let pending = state
            .inner
            .lock()
            .await
            .current(session)?
            .retire_camera_change();
        pending.release().await;
        let (retired, started) = state
            .inner
            .lock()
            .await
            .current(session)?
            .start_camera_change(target, capture);
        retired.release().await;
        started?
    };
    let started = started
        .await
        .map_err(|_| "camera capture stopped before it started".to_string())
        .and_then(|r| r);
    let finished = {
        let _gate = state.camera_gate.lock().await;
        let (retired, finished) = {
            let mut inner = state.inner.lock().await;
            let s = inner.current(session)?;
            let (mut retired, finished) = match started {
                Ok(size) => {
                    let (retired, swapped) = s.finish_camera_change(id);
                    (retired, swapped.map(|()| size))
                }
                Err(e) => (Retired::default(), Err(e)),
            };
            if finished.is_err() {
                retired.merge(s.stop_camera(id).await);
            }
            (retired, finished)
        };
        retired.release().await;
        finished
    };
    let (width, height) = finished?;
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
    unless_closing(
        state.quick.closing(session),
        async {
            let mut inner = state.inner.lock().await;
            inner
                .current(session)?
                .publish_camera(capture, options)
                .await
        },
        || closing_error(session),
    )
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
    let _gate = state.camera_gate.lock().await;
    let retired = state
        .inner
        .lock()
        .await
        .current(session)?
        .stop_camera(capture)
        .await;
    retired.release().await;
    Ok(())
}

/// Stop camera capture `capture` of `session` if it is still current, under
/// the camera gate, releasing it before returning.
async fn stop_camera_capture(state: &NativeVoiceState, session: u64, capture: u64) {
    let _gate = state.camera_gate.lock().await;
    let retired = match state.inner.lock().await.current(session) {
        Ok(s) => s.stop_camera(capture).await,
        Err(_) => return,
    };
    retired.release().await;
}

/// Release `value` (a preview's capture) under the camera gate.
async fn release_preview<T: Send + 'static>(state: &NativeVoiceState, value: T) {
    let _gate = state.camera_gate.lock().await;
    release_blocking(value).await;
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
    let (generation, capturer, started) = {
        let _gate = state.camera_gate.lock().await;
        let generation = {
            let mut inner = state.inner.lock().await;
            let generation = inner.begin_standalone();
            if let Some((frames, (width, height))) = inner.call_camera_preview() {
                let old = inner.standalone.take();
                drop(inner);
                release_blocking(old).await;
                return Ok(CameraPreviewStarted {
                    width,
                    height,
                    frames,
                });
            }
            generation
        };
        let (capturer, started) = camera::CameraCapture::start(target, capture, || {})?;
        (generation, capturer, started)
    };
    let frames = match video::FrameServer::bind().await {
        Ok(frames) => frames,
        Err(e) => {
            release_preview(&state, capturer).await;
            return Err(e);
        }
    };
    frames.set_camera(Some(capturer.preview()));
    let url = frames.url().to_string();
    let started = started
        .await
        .map_err(|_| "camera preview stopped before it started".to_string())
        .and_then(|r| r);
    let (width, height) = match started {
        Ok(size) => size,
        Err(e) => {
            release_preview(&state, (capturer, frames)).await;
            return Err(e);
        }
    };
    let mut inner = state.inner.lock().await;
    // A newer start or a stop superseded this one while it started: release
    // the capture here rather than replacing the slot the newer request owns.
    if !inner.standalone_is_latest(generation) {
        drop(inner);
        release_preview(&state, (capturer, frames)).await;
        return Err("camera preview superseded by a newer request".to_string());
    }
    let replaced = inner.standalone.replace(Standalone {
        frames,
        _capture: capturer,
    });
    drop(inner);
    release_preview(&state, replaced).await;
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
    let _gate = state.camera_gate.lock().await;
    let stopped = state.inner.lock().await.clear_standalone();
    release_blocking(stopped).await;
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
    let (id, started) = {
        let _gate = state.screen_gate.lock().await;
        let retired = state
            .inner
            .lock()
            .await
            .current(session)?
            .release_screen()
            .await;
        retired.release().await;
        state
            .inner
            .lock()
            .await
            .current(session)?
            .start_screen(target, capture)
            .await?
    };
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
    let (id, started) = {
        let _gate = state.screen_gate.lock().await;
        // A superseded pending share closes before the new one opens.
        let pending = state
            .inner
            .lock()
            .await
            .current(session)?
            .retire_screen_change();
        pending.release().await;
        let (retired, started) = state
            .inner
            .lock()
            .await
            .current(session)?
            .start_screen_change(target, capture);
        retired.release().await;
        started?
    };
    let started = started
        .await
        .map_err(|_| "screen capture stopped before it started".to_string())
        .and_then(|r| r);
    let finished = {
        let _gate = state.screen_gate.lock().await;
        let (retired, finished) = {
            let mut inner = state.inner.lock().await;
            let s = inner.current(session)?;
            let (mut retired, finished) = match started {
                Ok(size) => {
                    let (retired, swapped) = s.finish_screen_change(id);
                    (retired, swapped.map(|()| size))
                }
                Err(e) => (Retired::default(), Err(e)),
            };
            if finished.is_err() {
                retired.merge(s.stop_screen(id).await);
            }
            (retired, finished)
        };
        retired.release().await;
        finished
    };
    let (width, height) = finished?;
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
    let (sid, width, height) = unless_closing(
        state.quick.closing(session),
        async {
            let mut inner = state.inner.lock().await;
            inner
                .current(session)
                .map_err(QualityError::Refused)?
                .set_screen_quality(capture, options, publish)
                .await
        },
        || QualityError::Refused(closing_error(session)),
    )
    .await?;
    Ok(ScreenQualitySet { sid, width, height })
}

/// Hold the published camera or share `sid` under `max_bitrate` bits per
/// second without republishing it: the top layer runs at it and every lower
/// layer at the lower of its own rate and it; 0 restores the rates the
/// publish produced. A `sid` that is not the live publication is a no-op.
#[tauri::command]
pub async fn native_voice_set_video_bitrate(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    kind: String,
    sid: String,
    max_bitrate: u64,
) -> Result<(), String> {
    let kind = VideoKind::parse(&kind)?;
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_video_bitrate(kind, &sid, max_bitrate)
}

/// Publish running capture `capture` as the screen share; returns its sid.
#[tauri::command]
pub async fn native_voice_publish_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
    options: ScreenOptions,
) -> Result<String, String> {
    unless_closing(
        state.quick.closing(session),
        async {
            let mut inner = state.inner.lock().await;
            inner
                .current(session)?
                .publish_screen(capture, options)
                .await
        },
        || closing_error(session),
    )
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
    let (retired, published) = state
        .inner
        .lock()
        .await
        .current(session)?
        .publish_screen_audio_until(capture, state.quick.closing(session))
        .await;
    retired.release().await;
    published
}

/// Unpublish screen audio `sid` and end its capture; a stale sid is a no-op.
#[tauri::command]
pub async fn native_voice_unpublish_screen_audio(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    sid: String,
) -> Result<(), String> {
    let retired = state
        .inner
        .lock()
        .await
        .current(session)?
        .unpublish_screen_audio(&sid)
        .await;
    retired.release().await;
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
    let _gate = state.screen_gate.lock().await;
    let retired = state
        .inner
        .lock()
        .await
        .current(session)?
        .stop_screen(capture)
        .await;
    retired.release().await;
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
    // Heard at once, ahead of a publish holding the lock; the latest call wins.
    let playout = state.quick.get(session)?.playout;
    playout.mixer().set_muted(&sid, !subscribed);
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
mod tests;
