//! One native LiveKit room: connect over the loopback proxy URL, E2EE with the
//! room key the TypeScript key exchange hands over, microphone capture and
//! processing through our own input stream (`capture.rs`, for RNNoise),
//! remote playout through our own mixer (`playout.rs`, for per-user
//! volume), camera
//! publish and remote video through the session's frame socket
//! (`video.rs`), screen share (`screen.rs`), and a stream of room events for
//! the webview. No Tauri types here so the interop example
//! (`examples/native_voice_interop.rs`) drives exactly the code the app runs.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use livekit::e2ee::EncryptionType;
use livekit::e2ee::{key_provider::KeyProvider, key_provider::KeyProviderOptions, E2eeOptions};
use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::prelude::VideoBuffer;
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

use super::camera::{
    self, CameraCapture, CameraDevice, CaptureOptions as CameraCaptureOptions,
    Target as CameraTarget,
};
use super::capture::{self, Apm, Capture, GateSink, LevelSink};
use super::playout::{self, Playout};
use super::screen::{self, CaptureOptions, ScreenCapture, Started, Target};
use super::share_audio::ShareAudio;
use super::video::FrameServer;
use crate::sync::lock;

mod audio_line;
mod events;
mod music;
mod publish_options;
mod screen_share;
mod video_bitrate;

use audio_line::off_runtime;
pub use audio_line::{Audio, Class, DeviceSwitch, MicCommit, MicStep};
pub use video_bitrate::VideoKind;

use events::{forward_events, is_encrypted, permission_event, withdraw_unencrypted};
pub use events::{Event, EventSink, ParticipantInfo, TrackInfo};
use publish_options::{
    camera_publish_options, mic_publish_options, screen_audio_publish_options,
    screen_publish_options,
};
pub use publish_options::{
    process_threads, screen_audio_source, CameraOptions, PublishCodec, ScreenOptions,
    MUSIC_TRACK_NAME,
};

/// The key index a session starts on, and the one an older client uses for
/// every key: livekit-client's `ExternalE2EEKeyProvider.setKey(key)` writes
/// index 0.
pub const KEY_INDEX: i32 = 0;

/// The key indexes ("slots") a room key can go in. A new key is staged in the
/// slot nobody sends with and sending switches to it a moment later. Upstream
/// livekit/rust-sdks issue 1280 aborts the process on an index outside the
/// key ring, so a slot from the webview is checked against this first.
pub const KEY_SLOTS: std::ops::RangeInclusive<i32> = 0..=1;

/// The bytes the frame cryptor derives the AES key from.
///
/// livekit-client's `ExternalE2EEKeyProvider.setKey(string)` UTF-8-encodes
/// the base64 *text* and runs PBKDF2 over those bytes — it never decodes the
/// base64. `E2EEWorker.applyRoomKey` sends that same text over IPC, so the
/// material here is the text's bytes, byte-for-byte what a Windows client
/// derives from.
pub fn shared_key_material(base64_room_key: &str) -> Vec<u8> {
    base64_room_key.as_bytes().to_vec()
}

/// The `RoomOptions` every native session connects with: dynacast on, so a
/// video layer nobody subscribes to is paused (the SDK re-applies the
/// paused layers after every publisher renegotiation, so starting or stopping
/// another track does not resume them), GCM e2ee, and separate publish and
/// subscribe peer connections.
fn room_options(key_provider: KeyProvider) -> RoomOptions {
    let mut options = RoomOptions::default();
    options.dynacast = true;
    // With one shared peer connection, a publish or unpublish of our own
    // track (a camera toggle) renegotiates the connection that carries the
    // remote videos, and now and then a remote video that just subscribed
    // kept decoding without its frames ever reaching the track: a black tile
    // for the rest of the call. A separate subscriber connection is never
    // renegotiated by our own publishes. Its answer gets stereo Opus from the
    // vendored SDK (vendor/livekit/OWNCORD-PATCH.md).
    options.single_peer_connection = false;
    // The report's proven configuration. `encryption` would also enable
    // data-track encryption, which livekit-client's `e2ee` path lacks.
    #[allow(deprecated)]
    {
        options.e2ee = Some(E2eeOptions {
            encryption_type: EncryptionType::Gcm,
            key_provider,
        });
    }
    options
}

/// Mirror of `ExternalE2EEKeyProvider`'s fixed options: no ratcheting, no
/// failure tolerance, the SDK-default salt and PBKDF2.
fn key_provider_options() -> KeyProviderOptions {
    KeyProviderOptions {
        ratchet_window_size: 0,
        failure_tolerance: -1,
        ..Default::default()
    }
}

/// How long a resumed video's enable request gets before its layer is asked
/// for (`set_video_view`).
const LAYER_AFTER_ENABLE: std::time::Duration = std::time::Duration::from_millis(50);

/// The webview's name for a simulcast layer.
pub fn video_quality(name: &str) -> Result<VideoQuality, String> {
    match name {
        "low" => Ok(VideoQuality::Low),
        "medium" => Ok(VideoQuality::Medium),
        "high" => Ok(VideoQuality::High),
        other => Err(format!("unknown video quality {other}")),
    }
}

/// Layer control for one remote video (the web path's
/// `setEnabled`/`setVideoQuality`): a stream no one sees stops, a shown one
/// comes at `quality`. The webview maps a tile's size to a quality
/// (`video_quality`) by choice; livekit 0.10.0's `update_video_dimensions` is
/// not used. Runs without the session lock;
/// the webview sends a publication's next view only once this returns.
pub async fn set_video_view(
    publication: &RemoteTrackPublication,
    enabled: bool,
    quality: VideoQuality,
) {
    let resumed = enabled && !publication.is_enabled();
    publication.set_enabled(enabled);
    if !enabled || !publication.simulcasted() {
        return;
    }
    if resumed {
        // The SDK sends each request from its own task, and the enable
        // carries the full published size, which the SFU prefers over a
        // quality: let it go first.
        tokio::time::sleep(LAYER_AFTER_ENABLE).await;
    }
    publication.set_video_quality(quality);
}
/// Microphone audio processing, from the same preferences the web path feeds
/// `audioCaptureDefaults`, plus its Enhanced Noise Suppression (RNNoise).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOptions {
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    #[serde(default)]
    pub enhanced_noise_suppression: bool,
}

/// Keep `old` until nothing but this list holds it. A lagging audio
/// callback can still hold an older generation after a second rebuild, so
/// drop only the entries every follower has let go of, here on the caller's
/// thread.
pub(super) fn retire<T>(retired: &mut Vec<Arc<T>>, old: Option<Arc<T>>) {
    retired.retain(|r| Arc::strong_count(r) > 1);
    retired.extend(old);
}

/// What a request to change the audio processing asks of a session.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ProcessingChange {
    /// Audio is not enabled yet: only remember the options.
    Remember,
    /// The options are what the running processing already has.
    Unchanged,
    /// Only Enhanced Noise Suppression changed: RNNoise runs outside
    /// libwebrtc, so keep the processing (and the echo canceller's
    /// adaptation) and only switch the denoiser.
    Reroute,
    /// Build the processing again (libwebrtc's flags are fixed at
    /// construction) and swap it in.
    Rebuild,
}

pub(super) fn processing_change(
    enabled: bool,
    current: Option<AudioOptions>,
    next: AudioOptions,
) -> ProcessingChange {
    if !enabled {
        ProcessingChange::Remember
    } else if current == Some(next) {
        ProcessingChange::Unchanged
    } else if current.is_some_and(|c| {
        AudioOptions {
            enhanced_noise_suppression: next.enhanced_noise_suppression,
            ..c
        } == next
    }) {
        ProcessingChange::Reroute
    } else {
        ProcessingChange::Rebuild
    }
}

/// Rust-side resource counts for the facade's debug surface (the
/// long-session soak cannot see native memory, so it reads these instead).
#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub rooms: usize,
    pub local_tracks: usize,
    /// Open microphone input streams (0 while muted).
    pub capture_streams: usize,
    /// Remote audio tracks being read into the playout mixer.
    pub audio_streams: usize,
    /// Open frame-socket connections (remote renderers, camera upload and
    /// screen preview).
    pub video_sockets: usize,
    /// Screen capture threads alive, each holding a capturer (and, on
    /// Wayland, a portal session): zero once every share is stopped.
    pub screen_captures: usize,
    /// Native camera capture threads alive (each holding a GStreamer
    /// pipeline and the device): zero once the camera is off.
    pub camera_captures: usize,
    /// Process thread count, the observable for upstream livekit/rust-sdks issue 1408 (a leaked
    /// FrameCryptor thread per cryptor) across repeated joins.
    pub threads: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// The audio host's stable device id.
    pub id: String,
    pub name: String,
    /// The device's position in its list, what a switch selects by.
    #[serde(skip)]
    pub index: u16,
}

/// The platform's capture and playout devices; the first entry of each is
/// what is used by default.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

/// The index to switch to: the first device whose id is `requested`,
/// otherwise the default (the first listed), flagged as a fallback
/// unless the default was what was asked for (an empty id). `None` when
/// nothing is listed.
pub(super) fn resolve_device(requested: &str, listed: &[DeviceInfo]) -> (Option<u16>, bool) {
    match listed.iter().find(|d| d.id == requested) {
        Some(d) => (Some(d.index), false),
        None => (listed.first().map(|d| d.index), !requested.is_empty()),
    }
}

/// The audio host's capture and playout devices, in or out of a call.
pub fn list_devices() -> Devices {
    Devices {
        inputs: capture::list_inputs(),
        outputs: playout::list_outputs(),
    }
}

/// The GStreamer `Video/Source` devices (V4L2 and PipeWire), in or out of a
/// call. Blocking: the monitor runs a discovery pass.
pub fn list_cameras() -> Vec<CameraDevice> {
    camera::list_devices()
}

/// The device kinds the web path's `switchActiveDevice` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    Input,
    Output,
}

impl DeviceKind {
    pub fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "audioinput" => Ok(Self::Input),
            "audiooutput" => Ok(Self::Output),
            other => Err(format!("unsupported device kind {other}")),
        }
    }
}

/// A published camera or screen share. `issued` is the sid the webview was
/// handed and must name to unpublish; `live` follows the SDK's republish
/// after a full reconnect, which re-issues the sid of the same track.
/// `capture` is the capture it carries, the id the webview names to stop it.
struct VideoPublication {
    issued: String,
    live: TrackSid,
    capture: Option<u64>,
    /// The sender's layers (rate, scale-down) right after the publish: what a
    /// lifted bitrate cap restores (`video_bitrate.rs`). Empty until recorded,
    /// and again after a republish, whose layers are new.
    original_layers: Vec<video_bitrate::Layer>,
}

impl VideoPublication {
    fn new(sid: TrackSid) -> Self {
        Self {
            issued: sid.to_string(),
            live: sid,
            capture: None,
            original_layers: Vec::new(),
        }
    }

    fn of_capture(sid: TrackSid, capture: Option<u64>) -> Self {
        Self {
            capture,
            ..Self::new(sid)
        }
    }

    fn republished(&mut self, previous: &TrackSid, sid: TrackSid) {
        if self.live == *previous {
            self.live = sid;
            self.original_layers.clear();
        }
    }
}

type VideoSlot = Arc<Mutex<Option<VideoPublication>>>;

/// Why `set_screen_quality` did not apply. `Refused` changed nothing and the
/// share goes on; after `Publish` only the screen video is unpublished: the
/// capture (running at the new size) and the share audio stay up, so the
/// caller must stop the screen or retry the publish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", content = "message", rename_all = "camelCase")]
pub enum QualityError {
    Refused(String),
    Publish(String),
}

/// Whether a quality change for `capture` may go ahead: it must be the live,
/// published share, with no source change pending (that change's new capture
/// would otherwise carry the old options over the new quality).
fn quality_gate(
    live: Option<u64>,
    published: bool,
    change_pending: bool,
    capture: u64,
) -> Result<(), QualityError> {
    if live != Some(capture) || !published {
        return Err(QualityError::Refused(format!(
            "screen capture {capture} is not the published screen share"
        )));
    }
    if change_pending {
        return Err(QualityError::Refused(
            "the screen source is being changed".into(),
        ));
    }
    Ok(())
}

/// The running screen capture: its id (what the webview names to publish or
/// stop it) and the capturer thread.
struct ScreenShare {
    id: u64,
    capture: ScreenCapture,
}

/// The running native camera capture: its id and the GStreamer pipeline
/// thread. Held whether or not it is published, like `ScreenShare`, so the
/// self-view preview survives a mute/unpublish (the web path keeps its track).
struct CameraShare {
    id: u64,
    capture: CameraCapture,
}

pub struct NativeSession {
    room: Room,
    key_provider: KeyProvider,
    /// Set by `enable_audio`: the processing capture and playout share.
    apm: Option<Arc<Apm>>,
    /// The options `apm` was built from, or the latest asked for before
    /// `enable_audio` ran.
    audio: Option<AudioOptions>,
    /// Processing that rebuilds replaced, each kept until the capture and
    /// playout have both moved past it, so its last reference is never
    /// dropped on an audio thread.
    retired: Vec<Arc<Apm>>,
    /// The published microphone track — not its publication: a full
    /// reconnect republishes the same track under a new publication and
    /// detaches the old one, so muting through a stored publication would
    /// silently skip the track.
    mic: Option<LocalAudioTrack>,
    /// The published microphone's source, fed by `capture` (none when the
    /// interop example published a synthetic one).
    mic_source: Option<NativeAudioSource>,
    /// Set when the server withdrew the microphone publication (a moderator
    /// mute); the next enable republishes instead of unmuting a dead track.
    mic_withdrawn: MicWithdrawn,
    /// Bumped by every microphone call, under the session lock: a call that
    /// finds it moved when its driver step ends was superseded and commits
    /// nothing.
    mic_epoch: u64,
    camera: VideoSlot,
    /// The running native camera capture, independent of publication: the
    /// self-view preview reads it back over the frame socket's `camera` route.
    camera_capture: Option<CameraShare>,
    /// A capture started to replace the published camera's device; it takes
    /// over the publication once its first frame arrives
    /// (`finish_camera_change`), until then the live camera is untouched.
    camera_change: Option<CameraShare>,
    screen: Option<ScreenShare>,
    /// A capture started to replace the published share's source; it takes
    /// over the publication once its first frame arrives
    /// (`finish_screen_change`), until then the live share is untouched.
    screen_change: Option<ScreenShare>,
    screen_publication: VideoSlot,
    /// The screen share's audio publication. Its `capture` is the screen
    /// capture it belongs to, like the video slot's.
    ///
    /// Lock order: the session's tokio `inner` mutex is outermost. Below it
    /// the slots (camera, screen, screen audio) are each locked alone, never
    /// two at once, by the session and by `forward_events`.
    screen_audio: VideoSlot,
    /// The capture feeding the published screen audio (none for the interop
    /// example's synthetic source). Lives and dies with `screen_audio`.
    share_audio: Option<ShareAudio>,
    /// The music share's publication (its `capture` is always `None`), a slot
    /// of its own beside `screen_audio` so neither touches the other. Same
    /// lock order as `screen_audio`: locked alone, below the session's mutex.
    music_audio: VideoSlot,
    /// The capture feeding the published music track. Lives and dies with
    /// `music_audio`.
    music_feed: Option<ShareAudio>,
    next_capture: u64,
    next_camera: u64,
    on_event: EventSink,
    frames: FrameServer,
    /// The playout and capture are shared with the blocking threads that
    /// open and close their devices; `playout_controls` and `capture_controls`
    /// reach the settings that never wait on a device.
    playout: Arc<Audio<Playout>>,
    playout_controls: playout::Controls,
    capture: Arc<Audio<Capture>>,
    capture_controls: capture::Controls,
    forwarder: tokio::task::JoinHandle<()>,
    /// Emits the capture's reports (`enable_audio`), off the audio thread.
    capture_reports: Option<tokio::task::JoinHandle<()>>,
}

/// Capture reports (gate edges and level reports, ~20 a second) waiting for
/// the webview: about three seconds of them.
const CAPTURE_REPORT_QUEUE: usize = 64;

/// The capture's report sinks and the task that emits what they queue. The
/// capture reports from the audio callback thread, which must never wait on
/// an emit (it serializes and takes the webviews' lock): the sinks only
/// queue, dropping a report when the queue is full, and the task emits, in
/// order. It ends when the sinks are dropped with the capture.
pub(super) fn capture_report_sinks(
    on_event: EventSink,
) -> (GateSink, LevelSink, tokio::task::JoinHandle<()>) {
    let (reports, mut queue) = tokio::sync::mpsc::channel(CAPTURE_REPORT_QUEUE);
    let emitter = tokio::spawn(async move {
        while let Some(event) = queue.recv().await {
            on_event(event);
        }
    });
    let gate_reports = reports.clone();
    let on_gate: GateSink = Arc::new(move |open| {
        let _ = gate_reports.try_send(Event::VoiceGate { open });
    });
    let on_level: LevelSink = Arc::new(move |rms, open| {
        let _ = reports.try_send(Event::InputLevel { rms, open });
    });
    (on_gate, on_level, emitter)
}

/// The local (by source key) and remote (by publication sid) video tracks
/// whose stats the webview reads.
pub type StatsTracks = (Vec<(&'static str, LocalTrack)>, Vec<(String, RemoteTrack)>);

impl NativeSession {
    /// Connect with the room key already installed: the TS key exchange
    /// finishes before `room.connect()` on every platform, so a session with
    /// no key is a caller bug, not a state to support.
    pub async fn connect(
        url: &str,
        token: &str,
        key_material: Vec<u8>,
        on_event: EventSink,
    ) -> Result<Self, String> {
        let key_provider = KeyProvider::with_shared_key(key_provider_options(), key_material);
        let options = room_options(key_provider.clone());
        let frames = FrameServer::bind().await?;
        log::info!(
            "[native_voice] video encoder backends: {:?}",
            livekit::webrtc::rtp_sender::VideoEncoderBackend::list_available()
                .into_iter()
                .collect::<Vec<_>>()
        );
        let (room, events) = Room::connect(url, token, options)
            .await
            .map_err(|e| e.to_string())?;
        room.e2ee_manager().set_enabled(true);
        // Always false: `room_options` asks for separate connections. Kept so
        // a support log shows the mode the session actually ran in.
        log::info!(
            "[native_voice] single peer connection active: {}",
            room.is_single_peer_connection_active()
        );
        // The join's grant raises no change event, so the webview hears it
        // here, before any event the forwarder sends.
        if let Some(permission) = room.local_participant().permission() {
            on_event(permission_event(&permission));
        }
        let camera = VideoSlot::default();
        let screen_publication = VideoSlot::default();
        let screen_audio = VideoSlot::default();
        let music_audio = VideoSlot::default();
        let playout = Playout::default();
        let playout_controls = playout.controls();
        let capture = Capture::default();
        let capture_controls = capture.controls();
        let mic_withdrawn = MicWithdrawn::default();
        let forwarder = tokio::spawn(forward_events(
            events,
            on_event.clone(),
            frames.observer(),
            playout.listener(),
            [
                camera.clone(),
                screen_publication.clone(),
                screen_audio.clone(),
                music_audio.clone(),
            ],
            mic_withdrawn.clone(),
        ));
        Ok(Self {
            room,
            key_provider,
            apm: None,
            retired: Vec::new(),
            audio: None,
            mic: None,
            mic_source: None,
            mic_withdrawn,
            mic_epoch: 0,
            camera,
            camera_capture: None,
            screen: None,
            camera_change: None,
            screen_change: None,
            screen_publication,
            screen_audio,
            share_audio: None,
            music_audio,
            music_feed: None,
            next_capture: 0,
            next_camera: 0,
            on_event,
            frames,
            playout: Arc::new(Audio::new(playout)),
            playout_controls,
            capture: Arc::new(Audio::new(capture)),
            capture_controls,
            forwarder,
            capture_reports: None,
        })
    }

    /// Keep a publication only if the server accepted it as end-to-end
    /// encrypted, the one case the SDK attaches the frame cryptor in. Any
    /// other is stopped and unpublished at once, and the publish fails.
    async fn require_encrypted(&self, publication: &LocalTrackPublication) -> Result<(), String> {
        if is_encrypted(publication.encryption_type()) {
            return Ok(());
        }
        withdraw_unencrypted(&self.room.local_participant(), publication).await;
        Err("the media server did not accept end-to-end encryption for this track".into())
    }

    /// Install the room key in `slot` and send with it from now on.
    pub fn set_key(&self, key_material: Vec<u8>, slot: i32) {
        self.key_provider.set_shared_key(key_material, slot);
        self.use_key_slot(slot);
    }

    /// Install the room key in `slot` for receiving only; `use_key_slot`
    /// switches sending to it.
    pub fn stage_key(&self, key_material: Vec<u8>, slot: i32) {
        self.key_provider.set_shared_key(key_material, slot);
    }

    /// Encrypt every local track with the key in `slot`.
    pub fn use_key_slot(&self, slot: i32) {
        self.room
            .e2ee_manager()
            .set_sender_key_index(&self.room.local_participant().identity(), slot);
    }

    /// A second, raw view of the room's events, for the interop example
    /// (which reads decoded remote audio and so needs the track objects the
    /// webview-facing `Event`s deliberately leave out).
    pub fn subscribe_room_events(&self) -> UnboundedReceiver<RoomEvent> {
        self.room.subscribe()
    }

    /// The playout mixer, for the interop example: CI has no output device,
    /// so it pulls the mix itself to measure per-user volume end to end.
    pub fn playout_mixer(&self) -> Arc<playout::Mixer> {
        self.playout_controls.mixer().clone()
    }

    /// The frame socket's base URL, token included: only the webview (via
    /// the connect result) and the interop example may see it.
    pub fn frames_url(&self) -> &str {
        self.frames.url()
    }

    pub fn local_identity(&self) -> String {
        self.room.local_participant().identity().to_string()
    }

    /// Set up the audio processing and open playout on the default output
    /// device. The app calls this right after connect, independent of
    /// whether the microphone is ever published. The SDK's device module is
    /// never acquired, so its playout stays in the synthetic mode that keeps
    /// the decode pipeline running without a device, and remote audio plays
    /// only through the gained mix in `playout.rs`, which is also what the
    /// echo canceller hears. A box with no sound server logs and carries on
    /// listen-only.
    pub async fn enable_audio(&mut self, opts: AudioOptions) {
        if self.apm.is_some() {
            return;
        }
        // Options asked for before this ran win over the connect-time ones.
        let opts = self.audio.unwrap_or(opts);
        self.audio = Some(opts);
        let apm = Apm::new(&opts);
        self.playout_controls.set_reference(apm.clone());
        let (on_gate, on_level, emitter) = capture_report_sinks(self.on_event.clone());
        self.capture_reports = Some(emitter);
        self.capture_controls.configure(
            apm.clone(),
            opts.enhanced_noise_suppression,
            on_gate,
            on_level,
        );
        self.apm = Some(apm);
        let switch = DeviceSwitch::output(&self.playout);
        match off_runtime(move || switch.apply("")).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) | Err(e) => log::warn!("[native_voice] playout unavailable: {e}"),
        }
    }

    /// Apply new audio processing options in a running call: libwebrtc's
    /// processing takes its flags at construction, so build a new one and
    /// hand it to both the capture (forward stream) and the playout (the
    /// echo canceller's reverse stream). Both follow it on a later audio
    /// frame, whether or not the microphone is unmuted. Before
    /// `enable_audio` the options are only remembered.
    pub fn set_audio_processing(&mut self, audio: AudioOptions) {
        match processing_change(self.apm.is_some(), self.audio, audio) {
            ProcessingChange::Unchanged => {}
            ProcessingChange::Remember => self.audio = Some(audio),
            ProcessingChange::Reroute => {
                if let Some(apm) = &self.apm {
                    self.capture_controls
                        .set_processing(apm.clone(), audio.enhanced_noise_suppression);
                }
                self.audio = Some(audio);
            }
            ProcessingChange::Rebuild => {
                let apm = Apm::new(&audio);
                self.playout_controls.set_reference(apm.clone());
                self.capture_controls
                    .set_processing(apm.clone(), audio.enhanced_noise_suppression);
                retire(&mut self.retired, self.apm.replace(apm));
                self.audio = Some(audio);
            }
        }
    }

    /// Enable or disable the microphone. The first enable publishes; after
    /// that the publication stays and is muted in place (no renegotiation, no
    /// new frame cryptor — upstream livekit/rust-sdks issue 1408), and the OS capture is stopped
    /// while muted so the system's in-use indicator goes out — the same
    /// contract as `stopMicTrackOnMute` on the web path.
    pub async fn set_microphone(
        &mut self,
        enabled: bool,
        bitrate: Option<u64>,
    ) -> Result<(), String> {
        let step = self.begin_microphone(enabled, bitrate).await;
        let Some(commit) = off_runtime(move || step.run()).await?? else {
            return Ok(());
        };
        let (result, cleanup) = self.finish_microphone(commit).await;
        if let Some(stop) = cleanup {
            if let Ok(Err(e)) | Err(e) = off_runtime(move || stop.run()).await {
                log::warn!("[native_voice] capture stop: {e}");
            }
        }
        result
    }

    /// The session-locked first step of [`Self::set_microphone`]: decide what
    /// the call needs from the capture and take its place in line. Run the
    /// returned step on a blocking thread without the session, then pass what
    /// it returns to [`Self::finish_microphone`] under the session again.
    pub async fn begin_microphone(&mut self, enabled: bool, bitrate: Option<u64>) -> MicStep {
        self.mic_epoch += 1;
        let epoch = self.mic_epoch;
        let was_withdrawn = enabled && self.mic_withdrawn.take();
        if was_withdrawn {
            // The SFU dropped the publication; the track is dead. Best effort
            // unpublish, then fall through to a fresh first publish.
            if let Some(track) = self.mic.take() {
                let _ = self
                    .room
                    .local_participant()
                    .unpublish_track(&track.sid())
                    .await;
            }
            self.mic_source = None;
        }
        if self.mic.is_none() {
            if !enabled {
                return self.stop_step();
            }
            // Unbuffered (queue 0): the capture callback hands over whole
            // 10 ms frames and never waits.
            let source =
                NativeAudioSource::new(AudioSourceOptions::default(), capture::SAMPLE_RATE, 1, 0);
            return MicStep::first_publish(&self.capture, epoch, source, bitrate, was_withdrawn);
        }
        if enabled {
            // The interop example publishes its own source and captures nothing.
            let Some(source) = self.mic_source.clone() else {
                if let Some(track) = &self.mic {
                    track.unmute();
                }
                return MicStep::Idle;
            };
            return MicStep::Start {
                capture: self.capture.clone(),
                ticket: self.capture.ticket(Class::Running),
                stop_first: false,
                commit: MicCommit {
                    epoch,
                    source,
                    publish: None,
                },
            };
        }
        if let Some(track) = &self.mic {
            track.mute();
        }
        self.stop_step()
    }

    fn stop_step(&self) -> MicStep {
        MicStep::Stop {
            capture: self.capture.clone(),
            ticket: self.capture.ticket(Class::Running),
        }
    }

    /// The session-locked last step of a microphone call whose capture start
    /// succeeded: unmute the track, or publish it. A call a later one
    /// superseded while its step ran changes nothing: the later call decides
    /// the track and holds the later place in the capture's line. A failed
    /// publish returns the stop that closes the capture it started.
    pub async fn finish_microphone(
        &mut self,
        commit: MicCommit,
    ) -> (Result<(), String>, Option<MicStep>) {
        if self.mic_epoch != commit.epoch {
            return (Ok(()), None);
        }
        let Some((bitrate, was_withdrawn)) = commit.publish else {
            if let Some(track) = &self.mic {
                track.unmute();
            }
            return (Ok(()), None);
        };
        self.mic_source = Some(commit.source.clone());
        let published = self
            .publish_audio(RtcAudioSource::Native(commit.source), bitrate)
            .await;
        if published.is_err() {
            self.mic_source = None;
            // The server may not have re-granted yet: stay withdrawn so
            // the next enable tries a fresh publish again.
            self.mic_withdrawn.keep_if_failed(was_withdrawn, &published);
            let stop = self.stop_step();
            return (published, Some(stop));
        }
        (published, None)
    }

    /// Close or open push-to-talk's gate: the capture and the publication
    /// stay as they are, and a closed gate sends silence.
    pub fn set_ptt_gated(&self, gated: bool) {
        self.capture_controls.set_ptt_gated(gated);
    }

    /// Set the input-sensitivity gate's threshold (0: no gate); `retune`
    /// moves it without restarting the detector, `speech` adds RNNoise's
    /// verdict to the rule.
    pub fn set_voice_gate(&self, threshold: f32, retune: bool, speech: bool) {
        self.capture_controls
            .set_voice_gate(threshold, retune, speech);
    }

    /// Set the input volume as a linear gain (0 to 2).
    pub fn set_input_gain(&self, gain: f32) {
        self.capture_controls.set_input_gain(gain);
    }

    /// The capture and playout settings that never wait on a device or the
    /// SFU, for the commands that must not queue behind the session lock.
    pub fn quick_controls(&self) -> (capture::Controls, playout::Controls) {
        (self.capture_controls.clone(), self.playout_controls.clone())
    }

    /// Publish any audio source as the microphone track. The app passes its
    /// capture's source; the interop example passes a synthetic sine.
    pub async fn publish_audio(
        &mut self,
        source: RtcAudioSource,
        bitrate: Option<u64>,
    ) -> Result<(), String> {
        let track = LocalAudioTrack::create_audio_track("microphone", source);
        let publication = self
            .room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(track.clone()),
                mic_publish_options(bitrate),
            )
            .await
            .map_err(|e| e.to_string())?;
        self.require_encrypted(&publication).await?;
        self.mic = Some(track);
        Ok(())
    }

    /// Start native camera capture of `target` (a [`camera::list_devices`] id,
    /// or a synthetic source for the interop test), replacing any capture
    /// already running. Returns the capture's id and a receiver that resolves
    /// with the first frame's size, or why capture never began. Capture is
    /// independent of the window and of publication: it keeps running while
    /// the webview is hidden.
    pub async fn start_camera(
        &mut self,
        target: CameraTarget,
        options: CameraCaptureOptions,
    ) -> Result<(u64, Started), String> {
        // The command released any running capture before this; direct
        // callers get the old device freed before the new one opens it.
        self.release_camera().await.release().await;
        self.next_camera += 1;
        let id = self.next_camera;
        let on_event = self.on_event.clone();
        let (capture, started) = CameraCapture::start(target, options, move || {
            on_event(Event::CameraCaptureEnded { capture: id })
        })?;
        self.frames.set_camera(Some(capture.preview()));
        self.camera_capture = Some(CameraShare { id, capture });
        Ok((id, started))
    }

    /// The running camera's preview socket and its latest frame size (0x0
    /// before a frame was watched), so the settings preview can show the
    /// call's camera instead of opening the device a second time.
    pub fn camera_preview(&self) -> Option<(String, (u32, u32))> {
        let camera = self.camera_capture.as_ref()?;
        let size = camera
            .capture
            .preview()
            .borrow()
            .as_ref()
            .map_or((0, 0), |b| (b.width(), b.height()));
        Some((self.frames.url().to_string(), size))
    }

    /// Publish running camera capture `capture` as the camera track. E2EE
    /// covers it through the room's one key provider, exactly as the
    /// microphone. Returns the publication's sid, which [`Self::unpublish_camera`]
    /// takes. A capture already published is replaced.
    pub async fn publish_camera(
        &mut self,
        capture: u64,
        opts: CameraOptions,
    ) -> Result<String, String> {
        if !self
            .camera_capture
            .as_ref()
            .is_some_and(|c| c.id == capture)
        {
            return Err(format!("camera capture {capture} is not running"));
        }
        self.release_camera_publication().await;
        let source = NativeVideoSource::new(
            VideoResolution {
                width: opts.width,
                height: opts.height,
            },
            false,
        );
        let track =
            LocalVideoTrack::create_video_track("camera", RtcVideoSource::Native(source.clone()));
        let publication = self
            .room
            .local_participant()
            .publish_track(LocalTrack::Video(track), camera_publish_options(&opts))
            .await
            .map_err(|e| e.to_string())?;
        self.require_encrypted(&publication).await?;
        let sid = publication.sid();
        if let Some(camera) = &self.camera_capture {
            camera.capture.set_source(Some(source));
        }
        let capture = self.camera_capture.as_ref().map(|c| c.id);
        *lock(&self.camera) = Some(VideoPublication::of_capture(sid.clone(), capture));
        self.hold_published_layers(
            VideoKind::Camera,
            &sid,
            publication.track(),
            opts.max_bitrate,
        );
        Ok(sid.to_string())
    }

    /// Start capturing `target` to replace the published camera's device,
    /// leaving the live capture and its publication running. Returns the new
    /// capture's id and its first-frame receiver, as `start_camera`; the
    /// caller awaits it without holding the session, then calls
    /// `finish_camera_change` (or `stop_camera` to give up).
    /// Take out the pending camera change, if any, for the caller to release
    /// before it starts another.
    pub fn retire_camera_change(&mut self) -> Retired {
        let mut retired = Retired::default();
        retired.cameras.extend(self.camera_change.take());
        retired
    }

    pub fn start_camera_change(
        &mut self,
        target: CameraTarget,
        options: CameraCaptureOptions,
    ) -> (Retired, Result<(u64, Started), String>) {
        let mut retired = Retired::default();
        if !self.camera_published() {
            return (retired, Err("no published camera to change".into()));
        }
        retired.cameras.extend(self.camera_change.take());
        self.next_camera += 1;
        let id = self.next_camera;
        let on_event = self.on_event.clone();
        let started = CameraCapture::start(target, options, move || {
            on_event(Event::CameraCaptureEnded { capture: id })
        });
        match started {
            Ok((capture, started)) => {
                self.camera_change = Some(CameraShare { id, capture });
                (retired, Ok((id, started)))
            }
            Err(e) => (retired, Err(e)),
        }
    }

    /// Move the published camera onto capture `capture` (started by
    /// `start_camera_change`): same publication and sid, same preview socket,
    /// and the old capture is released. Fails, changing nothing, when a stop,
    /// a new camera or another change came first.
    pub fn finish_camera_change(&mut self, capture: u64) -> (Retired, Result<(), String>) {
        let mut retired = Retired::default();
        let result = self.swap_camera(capture, &mut retired);
        (retired, result)
    }

    fn swap_camera(&mut self, capture: u64, retired: &mut Retired) -> Result<(), String> {
        let next = self
            .camera_change
            .take_if(|c| c.id == capture)
            .ok_or("the camera change was superseded")?;
        let Some(live) = self.camera_capture.as_mut() else {
            retired.cameras.push(next);
            return Err("the camera stopped during the change".into());
        };
        {
            // One guard for the published check and the write: a release
            // clearing the slot in between must not be written over.
            let mut slot = lock(&self.camera);
            let Some(publication) = slot.as_mut().filter(|p| p.capture == Some(live.id)) else {
                retired.cameras.push(next);
                return Err("the camera stopped during the change".into());
            };
            // The source keeps the size it was published at: the encoder follows
            // each frame's own size (as on the web path's replaceTrack).
            next.capture.take_over(&live.capture);
            publication.capture = Some(next.id);
        }
        // Releasing the old capture joins its thread and frees its device; the
        // preview lives on in `next`.
        retired.cameras.push(std::mem::replace(live, next));
        Ok(())
    }

    /// Whether the running capture is the one published as the camera.
    fn camera_published(&self) -> bool {
        let live = self.camera_capture.as_ref().map(|c| c.id);
        live.is_some()
            && lock(&self.camera)
                .as_ref()
                .is_some_and(|p| p.capture == live)
    }

    /// Unpublish camera `sid` (the web path unpublishes rather than mutes, so
    /// remote tiles close the same way). A stale sid, one a later publish
    /// already replaced, is a no-op: it must not remove the newer camera. The
    /// capture keeps running for the self-view preview.
    pub async fn unpublish_camera(&mut self, sid: &str) {
        let issued = lock(&self.camera).as_ref().is_some_and(|c| c.issued == sid);
        if issued {
            self.release_camera_publication().await;
        }
    }

    /// Unpublish the camera track without stopping the capture (the self-view
    /// stays live).
    async fn release_camera_publication(&mut self) {
        let camera = lock(&self.camera).take();
        if let Some(camera) = camera {
            if let Err(e) = self
                .room
                .local_participant()
                .unpublish_track(&camera.live)
                .await
            {
                log::warn!("[native_voice] camera unpublish: {e}");
            }
        }
    }

    /// Stop capture `capture` if it is still the running one (a stale id is a
    /// no-op): unpublish it and release the pipeline and the device. A
    /// pending change's capture is only dropped.
    pub async fn stop_camera(&mut self, capture: u64) -> Retired {
        let mut retired = Retired::default();
        if self.camera_change.as_ref().is_some_and(|c| c.id == capture) {
            retired.cameras.extend(self.camera_change.take());
        }
        if self
            .camera_capture
            .as_ref()
            .is_some_and(|c| c.id == capture)
        {
            retired.merge(self.release_camera().await);
        }
        retired
    }

    /// Unpublish whatever camera is published and stop its capture: the
    /// preview socket ends with it.
    pub async fn release_camera(&mut self) -> Retired {
        let mut retired = Retired::default();
        retired.cameras.extend(self.camera_change.take());
        self.release_camera_publication().await;
        self.frames.set_camera(None);
        // Releasing joins the capture thread and tears down the pipeline.
        retired.cameras.extend(self.camera_capture.take());
        retired
    }

    /// The publisher and subscriber transports' raw stats.
    pub async fn transport_stats(&self) -> Result<(Vec<RtcStats>, Vec<RtcStats>), String> {
        let s = self
            .room
            .get_stats()
            .await
            .map_err(|e| format!("native voice stats: {e}"))?;
        Ok((s.publisher_stats, s.subscriber_stats))
    }

    /// Handles (Arc clones) of the video tracks whose stats the webview
    /// reads. Local tracks are keyed by source, not sid, so the lookup is
    /// immune to the issued/live sid split after a full reconnect; remote
    /// ones by publication sid (what `remote_pub_info` sends). Unsubscribed
    /// publications have no track and are skipped.
    pub fn stats_tracks(&self) -> StatsTracks {
        let local = self
            .room
            .local_participant()
            .track_publications()
            .values()
            .filter_map(|p| {
                let key = match p.source() {
                    TrackSource::Camera => "camera",
                    TrackSource::Screenshare => "screen_share",
                    _ => return None,
                };
                p.track().map(|t| (key, t))
            })
            .collect();
        let remote = self
            .room
            .remote_participants()
            .values()
            .flat_map(|participant| participant.track_publications().into_values())
            .filter(|p| p.kind() == TrackKind::Video)
            .filter_map(|p| p.track().map(|t| (p.sid().to_string(), t)))
            .collect();
        (local, remote)
    }

    pub fn remote_publication(
        &self,
        identity: &str,
        sid: &str,
    ) -> Result<RemoteTrackPublication, String> {
        let participants = self.room.remote_participants();
        let participant = participants
            .get(&ParticipantIdentity::from(identity.to_string()))
            .ok_or_else(|| format!("unknown participant {identity}"))?;
        let track_sid =
            TrackSid::try_from(sid.to_string()).map_err(|_| format!("bad track sid {sid}"))?;
        participant
            .get_track_publication(&track_sid)
            .ok_or_else(|| format!("unknown track {sid}"))
    }

    /// Deafen support: (un)subscribe one remote publication.
    pub fn set_subscribed(
        &mut self,
        identity: &str,
        sid: &str,
        subscribed: bool,
    ) -> Result<(), String> {
        self.remote_publication(identity, sid)?
            .set_subscribed(subscribed);
        Ok(())
    }

    /// Per-user volume: the gain for `identity`'s microphone, 1.0 is unity
    /// (the web path's `RemoteParticipant.setVolume`, 0 to 2 in practice).
    pub fn set_volume(&self, identity: &str, volume: f32) {
        self.playout_controls
            .mixer()
            .set_gain(identity, playout::Volume::Microphone, volume);
    }

    /// The gain for `identity`'s screen-share audio, 1.0 is unity (the web
    /// path's screen-share element volume, 0 to 1, 0 when muted).
    pub fn set_screenshare_volume(&self, identity: &str, volume: f32) {
        self.playout_controls
            .mixer()
            .set_gain(identity, playout::Volume::ScreenShare, volume);
    }

    /// Switch the capture or playout device (a running stream moves to it).
    /// An empty id selects the default, the first listed device.
    /// The caller runs [`DeviceSwitch::apply`] on a blocking thread, without
    /// the session. Switches of one kind apply in the order they were made
    /// here.
    pub fn device_switch(&self, kind: &str) -> Result<DeviceSwitch, String> {
        Ok(match DeviceKind::parse(kind)? {
            DeviceKind::Output => DeviceSwitch::output(&self.playout),
            DeviceKind::Input => DeviceSwitch::input(&self.capture),
        })
    }

    pub fn resources(&self) -> Resources {
        // One slot lock at a time (see the lock order at `screen_audio`).
        let camera = usize::from(lock(&self.camera).is_some());
        let screen = usize::from(lock(&self.screen_publication).is_some());
        let screen_audio = usize::from(lock(&self.screen_audio).is_some());
        let music = usize::from(lock(&self.music_audio).is_some());
        Resources {
            rooms: 1,
            local_tracks: usize::from(self.mic.is_some()) + camera + screen + screen_audio + music,
            capture_streams: self.capture_controls.streams(),
            audio_streams: self.playout_controls.readers(),
            video_sockets: self.frames.sockets(),
            screen_captures: screen::active_captures(),
            camera_captures: camera::active_captures(),
            threads: process_threads(),
        }
    }

    /// Leave the room and release every native handle: the capture and
    /// playout streams close with the session, and dropping the frame server
    /// closes its listener and every frame socket.
    pub async fn close(mut self) {
        // Ticketed after every step already made, so a start still in flight
        // is skipped or stopped by it.
        let stop = self.stop_step();
        match off_runtime(move || stop.run()).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) | Err(e) => log::warn!("[native_voice] capture stop: {e}"),
        }
        self.release_camera().await.release().await;
        self.release_screen().await.release().await;
        self.release_music().await.release().await;
        // The track's sid follows a republish; a stored publication's would not.
        if let Some(track) = self.mic.take() {
            let _ = self
                .room
                .local_participant()
                .unpublish_track(&track.sid())
                .await;
        }
        if let Err(e) = self.room.close().await {
            log::warn!("[native_voice] room close: {e}");
        }
        self.forwarder.abort();
        if let Some(reports) = &self.capture_reports {
            reports.abort();
        }
        release_blocking((self.capture, self.playout)).await;
    }
}

/// Captures taken out of a session whose drop joins an OS thread and frees a
/// device or portal session. The session methods that stop, replace or finish
/// a capture return them so the caller releases them with [`Retired::release`]
/// after dropping the session lock.
#[derive(Default)]
#[must_use = "release retired captures with `.release().await` once the session lock is dropped"]
pub struct Retired {
    cameras: Vec<CameraShare>,
    screens: Vec<ScreenShare>,
    share_audio: Vec<ShareAudio>,
}

impl Retired {
    pub fn merge(&mut self, other: Retired) {
        self.cameras.extend(other.cameras);
        self.screens.extend(other.screens);
        self.share_audio.extend(other.share_audio);
    }

    pub fn is_empty(&self) -> bool {
        self.cameras.is_empty() && self.screens.is_empty() && self.share_audio.is_empty()
    }

    /// Drop them on a blocking thread; returns once every device is released.
    pub async fn release(self) {
        if !self.is_empty() {
            release_blocking(self).await;
        }
    }
}

/// Drop `value` on a blocking thread and wait for it: dropping a capture
/// joins its OS thread, which must not hold an async worker.
pub async fn release_blocking<T: Send + 'static>(value: T) {
    if let Err(e) = tokio::task::spawn_blocking(move || drop(value)).await {
        log::warn!("[native_voice] release: {e}");
    }
}

/// Empty a video slot whose live publication is `sid`, returning the capture
/// it carried. A slot holding any other publication is left alone.
fn release_slot(slot: &mut Option<VideoPublication>, sid: &TrackSid) -> Option<u64> {
    if slot.as_ref().is_some_and(|p| p.live == *sid) {
        return slot.take().and_then(|p| p.capture);
    }
    None
}

/// Shared between `forward_events` (sets it on a revocation) and
/// `set_microphone` (consumes it on the next enable).
#[derive(Clone, Default)]
struct MicWithdrawn(Arc<AtomicBool>);

impl MicWithdrawn {
    fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    /// A republish that failed (the grant not restored yet) leaves the
    /// withdrawal pending for the next enable.
    fn keep_if_failed<T>(&self, was_withdrawn: bool, result: &Result<T, String>) {
        if was_withdrawn && result.is_err() {
            self.set();
        }
    }
    fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

/// A video slot's (camera, screen share or its audio) response to a local track's
/// `LocalTrackRepublished`: adopt the new sid when the event continues the
/// slot's live publication, or return the sid to unpublish when it does not —
/// the video was stopped (slot emptied) or a newer one replaced it while the
/// SDK was between its unpublish and publish, leaving a publication nobody can
/// drive. A non-video republish returns `None`: `NativeSession` holds the
/// microphone's track, which the SDK carries into the new publication itself.
fn apply_republish(
    slot: &mut Option<VideoPublication>,
    source: TrackSource,
    previous_sid: &TrackSid,
    sid: &TrackSid,
) -> Option<TrackSid> {
    if !matches!(
        source,
        TrackSource::Camera | TrackSource::Screenshare | TrackSource::ScreenshareAudio
    ) {
        return None;
    }
    match slot.as_mut() {
        Some(c) if c.live == *previous_sid => {
            c.republished(previous_sid, sid.clone());
            None
        }
        _ => Some(sid.clone()),
    }
}

#[cfg(test)]
mod tests;
