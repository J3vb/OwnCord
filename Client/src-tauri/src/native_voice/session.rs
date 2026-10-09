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
use livekit::options::{AudioEncoding, TrackPublishOptions, VideoEncoding, VideoPreset};
use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::native::frame_cryptor::EncryptionState;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

use super::camera::{
    self, CameraCapture, CameraDevice, CaptureOptions as CameraCaptureOptions,
    Target as CameraTarget,
};
use super::capture::{self, Apm, Capture};
use super::playout::{self, Playout};
use super::screen::{self, CaptureOptions, ScreenCapture, Started, Target};
use super::video::{FrameServer, Observer};

/// The only key index OwnCord ever uses. livekit-client's
/// `ExternalE2EEKeyProvider.setKey(key)` writes index 0, and rust-sdks #1280
/// aborts the process on an out-of-range index, so this is a constant, not a
/// parameter.
pub const KEY_INDEX: i32 = 0;

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

/// Layer control for one remote video (P3-07, the web path's
/// `setEnabled`/`setVideoQuality`): a stream no one sees stops, a shown one
/// comes at `quality`. The webview maps a tile's size to a quality
/// (`video_quality`) by choice; livekit 0.9.3's `update_video_dimensions` is
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub sid: String,
    pub kind: &'static str,
    pub source: &'static str,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantInfo {
    pub identity: String,
    pub tracks: Vec<TrackInfo>,
}

/// Room events forwarded to the webview, in the vocabulary the TS adapter maps
/// onto livekit-client's `RoomEvent`s.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Connected {
        participants: Vec<ParticipantInfo>,
    },
    ParticipantConnected {
        identity: String,
    },
    ParticipantDisconnected {
        identity: String,
    },
    TrackPublished {
        identity: String,
        track: TrackInfo,
    },
    TrackUnpublished {
        identity: String,
        sid: String,
    },
    TrackSubscribed {
        identity: String,
        track: TrackInfo,
    },
    TrackUnsubscribed {
        identity: String,
        sid: String,
    },
    TrackMuted {
        identity: String,
        sid: String,
        muted: bool,
    },
    ActiveSpeakers {
        identities: Vec<String>,
    },
    /// The server's grant for the local participant changed: whether it still
    /// lets this client publish the microphone. The webview defers an unmute
    /// that arrives while it is false and republishes when it turns true.
    MicrophonePermission {
        allowed: bool,
    },
    /// The input-sensitivity gate opened (speech) or closed (silence). It
    /// lights the local speaking ring, as the web path's detector does.
    VoiceGate {
        open: bool,
    },
    EncryptionStatus {
        identity: String,
        encrypted: bool,
    },
    /// Screen capture `capture` stopped on its own after it had started:
    /// the user ended it from the desktop's sharing indicator, or the shared
    /// window went away. The webview stops the share as the web path does
    /// when a browser capture track ends.
    ScreenCaptureEnded {
        capture: u64,
    },
    /// Camera capture `capture` stopped on its own after it had started: the
    /// device was unplugged or the pipeline errored. The webview turns the
    /// camera off as the web path does when a camera track ends.
    CameraCaptureEnded {
        capture: u64,
    },
    Reconnecting,
    Reconnected,
    Disconnected {
        reason: String,
    },
}

pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

fn track_info(sid: String, kind: TrackKind, source: TrackSource, muted: bool) -> TrackInfo {
    TrackInfo {
        sid,
        kind: match kind {
            TrackKind::Audio => "audio",
            TrackKind::Video => "video",
        },
        source: match source {
            TrackSource::Microphone => "microphone",
            TrackSource::Camera => "camera",
            TrackSource::Screenshare => "screen_share",
            TrackSource::ScreenshareAudio => "screen_share_audio",
            TrackSource::Unknown => "unknown",
        },
        muted,
    }
}

fn remote_pub_info(p: &RemoteTrackPublication) -> TrackInfo {
    track_info(p.sid().to_string(), p.kind(), p.source(), p.is_muted())
}

fn participant_info(p: &RemoteParticipant, tracks: &[RemoteTrackPublication]) -> ParticipantInfo {
    ParticipantInfo {
        identity: p.identity().to_string(),
        tracks: tracks.iter().map(remote_pub_info).collect(),
    }
}

/// Map an SDK room event onto the webview vocabulary; `None` drops it.
fn map_event(ev: RoomEvent) -> Option<Event> {
    Some(match ev {
        RoomEvent::Connected {
            participants_with_tracks,
        } => Event::Connected {
            participants: participants_with_tracks
                .iter()
                .map(|(p, tracks)| participant_info(p, tracks))
                .collect(),
        },
        RoomEvent::ParticipantConnected(p) => Event::ParticipantConnected {
            identity: p.identity().to_string(),
        },
        RoomEvent::ParticipantDisconnected(p) => Event::ParticipantDisconnected {
            identity: p.identity().to_string(),
        },
        RoomEvent::TrackPublished {
            publication,
            participant,
        } => Event::TrackPublished {
            identity: participant.identity().to_string(),
            track: remote_pub_info(&publication),
        },
        RoomEvent::TrackUnpublished {
            publication,
            participant,
        } => Event::TrackUnpublished {
            identity: participant.identity().to_string(),
            sid: publication.sid().to_string(),
        },
        RoomEvent::TrackSubscribed {
            publication,
            participant,
            ..
        } => Event::TrackSubscribed {
            identity: participant.identity().to_string(),
            track: remote_pub_info(&publication),
        },
        RoomEvent::TrackUnsubscribed {
            publication,
            participant,
            ..
        } => Event::TrackUnsubscribed {
            identity: participant.identity().to_string(),
            sid: publication.sid().to_string(),
        },
        RoomEvent::TrackMuted {
            participant,
            publication,
        } => Event::TrackMuted {
            identity: participant.identity().to_string(),
            sid: publication.sid().to_string(),
            muted: true,
        },
        RoomEvent::TrackUnmuted {
            participant,
            publication,
        } => Event::TrackMuted {
            identity: participant.identity().to_string(),
            sid: publication.sid().to_string(),
            muted: false,
        },
        RoomEvent::ParticipantPermissionChanged {
            participant: Participant::Local(_),
            permission: Some(permission),
        } => Event::MicrophonePermission {
            allowed: mic_allowed(&permission),
        },
        RoomEvent::ActiveSpeakersChanged { speakers } => Event::ActiveSpeakers {
            identities: speakers.iter().map(|s| s.identity().to_string()).collect(),
        },
        // Frame E2EE state per participant (`ParticipantEncryptionStatusChanged`
        // is the data-track flag, not this). `KeyRatcheted` never occurs with
        // a ratchet window of 0; anything but `Ok` means frames are not
        // protected or not readable.
        RoomEvent::E2eeStateChanged { participant, state } => Event::EncryptionStatus {
            identity: participant.identity().to_string(),
            encrypted: state == EncryptionState::Ok,
        },
        RoomEvent::Reconnecting => Event::Reconnecting,
        RoomEvent::Reconnected => Event::Reconnected,
        RoomEvent::Disconnected { reason } => Event::Disconnected {
            reason: format!("{reason:?}"),
        },
        _ => return None,
    })
}

/// Microphone audio processing, from the same preferences the web path feeds
/// `audioCaptureDefaults`, plus its Enhanced Noise Suppression (RNNoise).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOptions {
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    #[serde(default)]
    pub enhanced_noise_suppression: bool,
}

/// Rust-side resource counts for the facade's debug surface (B7-11: the
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
    /// Process thread count, the observable for rust-sdks #1408 (a leaked
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

/// How the screen share is published: the capture's size and the web
/// path's `publishTrack` options for it (`getScreenShareMaxBitrate`, the
/// effective frame rate, `isScreenShareSimulcast`).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenOptions {
    pub width: u32,
    pub height: u32,
    pub max_bitrate: u64,
    pub max_framerate: f64,
    pub simulcast: bool,
}

/// The screen share's publish options. With simulcast it adds the web path's
/// one lower layer (`SCREENSHARE_SIMULCAST_LAYERS`): 720p at 15 fps and at
/// most 1.2 Mbps, so a viewer who cannot take the full stream still gets
/// readable text instead of a frozen frame, and the top layer keeps most of
/// the budget.
fn screen_publish_options(opts: &ScreenOptions) -> TrackPublishOptions {
    TrackPublishOptions {
        source: TrackSource::Screenshare,
        simulcast: opts.simulcast,
        simulcast_layers: opts.simulcast.then(|| {
            vec![VideoPreset {
                width: 1280,
                height: 720,
                encoding: VideoEncoding {
                    max_bitrate: 1_200_000,
                    max_framerate: 15.0,
                },
            }]
        }),
        video_encoding: Some(VideoEncoding {
            max_bitrate: opts.max_bitrate,
            max_framerate: opts.max_framerate,
        }),
        ..Default::default()
    }
}

/// How the camera is published, from the same presets the web path hands
/// `publishTrack` (`CAMERA_PRESETS`, `CAMERA_PUBLISH_BITRATES`).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraOptions {
    pub width: u32,
    pub height: u32,
    pub max_bitrate: u64,
    pub max_framerate: f64,
    pub simulcast: bool,
}

/// The camera's publish options. A 1080p camera adds the web path's
/// `cameraSimulcastLayers` (360p and 720p) so a viewer on a 1-3 Mbps link gets
/// 720p rather than the SDK default's 360p; 720p and below keep the defaults.
fn camera_publish_options(opts: &CameraOptions) -> TrackPublishOptions {
    let layer = |width, height, max_bitrate, max_framerate| VideoPreset {
        width,
        height,
        encoding: VideoEncoding {
            max_bitrate,
            max_framerate,
        },
    };
    TrackPublishOptions {
        source: TrackSource::Camera,
        simulcast: opts.simulcast,
        simulcast_layers: (opts.simulcast && opts.height > 720).then(|| {
            vec![
                layer(640, 360, 450_000, 20.0),
                layer(1280, 720, 1_700_000, 30.0),
            ]
        }),
        video_encoding: Some(VideoEncoding {
            max_bitrate: opts.max_bitrate,
            max_framerate: opts.max_framerate,
        }),
        ..Default::default()
    }
}

pub fn process_threads() -> usize {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("Threads:"))
                .and_then(|v| v.trim().parse().ok())
        })
        .unwrap_or(0)
}

/// A published camera or screen share. `issued` is the sid the webview was
/// handed and must name to unpublish; `live` follows the SDK's republish
/// after a full reconnect, which re-issues the sid of the same track.
struct VideoPublication {
    issued: String,
    live: TrackSid,
    /// The initial `publish_track` has not returned yet. A full reconnect
    /// can republish the new track inside that await, before its sid is
    /// known, so the republish is adopted into `live` instead of orphaned.
    pending: bool,
    /// While pending: the sid of the publication this one replaced. Its own
    /// delayed republish can still arrive and must not be adopted.
    stale: Option<TrackSid>,
}

impl VideoPublication {
    #[cfg(test)]
    fn new(sid: TrackSid) -> Self {
        Self {
            issued: sid.to_string(),
            live: sid,
            pending: false,
            stale: None,
        }
    }

    /// Marks a publish in flight; [`Self::settle`] completes it.
    fn pending(stale: Option<TrackSid>) -> Self {
        Self {
            issued: String::new(),
            live: Self::placeholder(),
            pending: true,
            stale,
        }
    }

    fn placeholder() -> TrackSid {
        TrackSid::try_from("TR_pending".to_string()).unwrap()
    }

    /// `publish_track` returned `sid`. A republish adopted meanwhile keeps
    /// `live`; otherwise the track is still under the sid it was issued.
    fn settle(&mut self, sid: TrackSid) {
        self.issued = sid.to_string();
        if self.live == Self::placeholder() {
            self.live = sid;
        }
        self.pending = false;
        self.stale = None;
    }

    fn republished(&mut self, previous: &TrackSid, sid: TrackSid) {
        if self.pending || self.live == *previous {
            self.live = sid;
        }
    }
}

type VideoSlot = Arc<Mutex<Option<VideoPublication>>>;

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
    camera: VideoSlot,
    /// The running native camera capture, independent of publication: the
    /// self-view preview reads it back over the frame socket's `camera` route.
    camera_capture: Option<CameraShare>,
    screen: Option<ScreenShare>,
    screen_publication: VideoSlot,
    next_capture: u64,
    next_camera: u64,
    on_event: EventSink,
    frames: FrameServer,
    playout: Playout,
    capture: Capture,
    forwarder: tokio::task::JoinHandle<()>,
}

/// The microphone's publish options: the channel's configured bitrate
/// (`voice_config`, the web path's `audioPreset`), or the SDK's own default
/// (48 kbps) when no config reached the client.
fn mic_publish_options(bitrate: Option<u64>) -> TrackPublishOptions {
    TrackPublishOptions {
        source: TrackSource::Microphone,
        audio_encoding: bitrate.map(|max_bitrate| AudioEncoding { max_bitrate }),
        ..Default::default()
    }
}

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
        let mut options = RoomOptions::default();
        // The report's proven configuration. `encryption` would also enable
        // data-track encryption, which livekit-client's `e2ee` path lacks.
        #[allow(deprecated)]
        {
            options.e2ee = Some(E2eeOptions {
                encryption_type: EncryptionType::Gcm,
                key_provider: key_provider.clone(),
            });
        }
        let frames = FrameServer::bind().await?;
        let (room, events) = Room::connect(url, token, options)
            .await
            .map_err(|e| e.to_string())?;
        room.e2ee_manager().set_enabled(true);
        let camera = VideoSlot::default();
        let screen_publication = VideoSlot::default();
        let playout = Playout::default();
        let mic_withdrawn = MicWithdrawn::default();
        let forwarder = tokio::spawn(forward_events(
            events,
            on_event.clone(),
            frames.observer(),
            playout.listener(),
            [camera.clone(), screen_publication.clone()],
            mic_withdrawn.clone(),
        ));
        Ok(Self {
            room,
            key_provider,
            apm: None,
            mic: None,
            mic_source: None,
            mic_withdrawn,
            camera,
            camera_capture: None,
            screen: None,
            screen_publication,
            next_capture: 0,
            next_camera: 0,
            on_event,
            frames,
            playout,
            capture: Capture::default(),
            forwarder,
        })
    }

    /// Rotate the room key in place (index 0), the way OwnCord rotates on
    /// leave and on the periodic timer.
    pub fn set_key(&self, key_material: Vec<u8>) {
        self.key_provider.set_shared_key(key_material, KEY_INDEX);
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
        self.playout.mixer().clone()
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
    pub fn enable_audio(&mut self, opts: AudioOptions) {
        if self.apm.is_some() {
            return;
        }
        let apm = Apm::new(&opts);
        self.playout.set_reference(apm.clone());
        let on_event = self.on_event.clone();
        self.capture.configure(
            apm.clone(),
            opts.enhanced_noise_suppression,
            Arc::new(move |open| on_event(Event::VoiceGate { open })),
        );
        self.apm = Some(apm);
        if let Err(e) = self.playout.set_device("") {
            log::warn!("[native_voice] playout unavailable: {e}");
        }
    }

    /// Enable or disable the microphone. The first enable publishes; after
    /// that the publication stays and is muted in place (no renegotiation, no
    /// new frame cryptor — rust-sdks #1408), and the OS capture is stopped
    /// while muted so the system's in-use indicator goes out — the same
    /// contract as `stopMicTrackOnMute` on the web path.
    pub async fn set_microphone(
        &mut self,
        enabled: bool,
        bitrate: Option<u64>,
    ) -> Result<(), String> {
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
            self.capture.stop();
            self.mic_source = None;
        }
        let Some(track) = &self.mic else {
            if !enabled {
                return Ok(());
            }
            // Unbuffered (queue 0): the capture callback hands over whole
            // 10 ms frames and never waits.
            let source =
                NativeAudioSource::new(AudioSourceOptions::default(), capture::SAMPLE_RATE, 1, 0);
            self.capture.start(source.clone())?;
            self.mic_source = Some(source.clone());
            let published = self
                .publish_audio(RtcAudioSource::Native(source), bitrate)
                .await;
            if published.is_err() {
                self.capture.stop();
                self.mic_source = None;
                // The server may not have re-granted yet: stay withdrawn so
                // the next enable tries a fresh publish again.
                self.mic_withdrawn.keep_if_failed(was_withdrawn, &published);
            }
            return published;
        };
        if enabled {
            // The interop example publishes its own source and captures nothing.
            if let Some(source) = &self.mic_source {
                self.capture.start(source.clone())?;
            }
            track.unmute();
        } else {
            track.mute();
            self.capture.stop();
        }
        Ok(())
    }

    /// Close or open push-to-talk's gate: the capture and the publication
    /// stay as they are, and a closed gate sends silence (DP-30).
    pub fn set_ptt_gated(&self, gated: bool) {
        self.capture.set_ptt_gated(gated);
    }

    /// Set the input-sensitivity gate's threshold (0: no gate).
    pub fn set_voice_gate(&self, threshold: f32) {
        self.capture.set_voice_gate(threshold);
    }

    /// Publish any audio source as the microphone track. The app passes its
    /// capture's source; the interop example passes a synthetic sine.
    pub async fn publish_audio(
        &mut self,
        source: RtcAudioSource,
        bitrate: Option<u64>,
    ) -> Result<(), String> {
        let track = LocalAudioTrack::create_audio_track("microphone", source);
        self.room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(track.clone()),
                mic_publish_options(bitrate),
            )
            .await
            .map_err(|e| e.to_string())?;
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
        self.release_camera().await;
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
        let stale = self.release_camera_publication().await;
        *self.camera.lock().unwrap() = Some(VideoPublication::pending(stale));
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
            .map_err(|e| {
                self.camera.lock().unwrap().take();
                e.to_string()
            })?;
        let sid = publication.sid();
        if let Some(camera) = &self.camera_capture {
            camera.capture.set_source(Some(source));
        }
        if let Some(camera) = self.camera.lock().unwrap().as_mut() {
            camera.settle(sid.clone());
        }
        Ok(sid.to_string())
    }

    /// Unpublish camera `sid` (the web path unpublishes rather than mutes, so
    /// remote tiles close the same way). A stale sid, one a later publish
    /// already replaced, is a no-op: it must not remove the newer camera. The
    /// capture keeps running for the self-view preview.
    pub async fn unpublish_camera(&mut self, sid: &str) {
        let issued = self
            .camera
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.issued == sid);
        if issued {
            self.release_camera_publication().await;
        }
    }

    /// Unpublish the camera track without stopping the capture (the self-view
    /// stays live).
    /// Returns the sid it unpublished, so a replacing publish can tell that
    /// publication's delayed republish from its own.
    async fn release_camera_publication(&mut self) -> Option<TrackSid> {
        let camera = self.camera.lock().unwrap().take()?;
        if let Err(e) = self
            .room
            .local_participant()
            .unpublish_track(&camera.live)
            .await
        {
            log::warn!("[native_voice] camera unpublish: {e}");
        }
        Some(camera.live)
    }

    /// Stop capture `capture` if it is still the running one (a stale id is a
    /// no-op): unpublish it and release the pipeline and the device.
    pub async fn stop_camera(&mut self, capture: u64) {
        if self
            .camera_capture
            .as_ref()
            .is_some_and(|c| c.id == capture)
        {
            self.release_camera().await;
        }
    }

    /// Unpublish whatever camera is published and stop its capture: the
    /// preview socket ends with it.
    async fn release_camera(&mut self) {
        self.release_camera_publication().await;
        self.frames.set_camera(None);
        // Dropping joins the capture thread and tears down the pipeline.
        self.camera_capture.take();
    }

    /// Start capturing `target` for a screen share, replacing any capture
    /// already running. Returns the capture's id and a receiver that resolves
    /// with the first frame's size — on Wayland only once the user has
    /// completed the portal's dialog — or with why capture never began
    /// ([`screen::PORTAL_NOT_STARTED`] for a portal dialog that ended without
    /// one). The caller awaits it without holding the session, so a leave or
    /// a stop is never blocked behind the dialog: either drops the capture,
    /// which resolves it.
    pub async fn start_screen(
        &mut self,
        target: Target,
        options: CaptureOptions,
    ) -> Result<(u64, Started), String> {
        self.release_screen().await;
        self.next_capture += 1;
        let id = self.next_capture;
        let on_event = self.on_event.clone();
        let (capture, started) = ScreenCapture::start(target, options, move || {
            on_event(Event::ScreenCaptureEnded { capture: id })
        })?;
        self.frames.set_screen(Some(capture.preview()));
        self.screen = Some(ScreenShare { id, capture });
        Ok((id, started))
    }

    /// Publish capture `capture` as the screen share (replacing an earlier
    /// publish of it). E2EE covers it through the room's one key provider,
    /// exactly as the camera. Returns the publication's sid.
    pub async fn publish_screen(
        &mut self,
        capture: u64,
        opts: ScreenOptions,
    ) -> Result<String, String> {
        if !self.screen.as_ref().is_some_and(|s| s.id == capture) {
            return Err(format!("screen capture {capture} is not running"));
        }
        let stale = self.unpublish_screen().await;
        *self.screen_publication.lock().unwrap() = Some(VideoPublication::pending(stale));
        let source = NativeVideoSource::new(
            VideoResolution {
                width: opts.width,
                height: opts.height,
            },
            true,
        );
        let track = LocalVideoTrack::create_video_track(
            "screen_share",
            RtcVideoSource::Native(source.clone()),
        );
        let publication = self
            .room
            .local_participant()
            .publish_track(LocalTrack::Video(track), screen_publish_options(&opts))
            .await
            .map_err(|e| {
                self.screen_publication.lock().unwrap().take();
                e.to_string()
            })?;
        let sid = publication.sid();
        if let Some(screen) = &self.screen {
            screen.capture.set_source(Some(source));
        }
        if let Some(publication) = self.screen_publication.lock().unwrap().as_mut() {
            publication.settle(sid.clone());
        }
        Ok(sid.to_string())
    }

    /// Stop capture `capture` if it is still the running one (a stale id is
    /// a no-op): unpublish it, and release the capturer and, on Wayland, the
    /// portal session.
    pub async fn stop_screen(&mut self, capture: u64) {
        if self.screen.as_ref().is_some_and(|s| s.id == capture) {
            self.release_screen().await;
        }
    }

    async fn unpublish_screen(&mut self) -> Option<TrackSid> {
        if let Some(screen) = &self.screen {
            screen.capture.set_source(None);
        }
        let publication = self.screen_publication.lock().unwrap().take()?;
        if let Err(e) = self
            .room
            .local_participant()
            .unpublish_track(&publication.live)
            .await
        {
            log::warn!("[native_voice] screen unpublish: {e}");
        }
        Some(publication.live)
    }

    async fn release_screen(&mut self) {
        self.unpublish_screen().await;
        self.frames.set_screen(None);
        // Dropping joins the capture thread.
        self.screen.take();
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
        self.playout
            .mixer()
            .set_gain(identity, playout::Volume::Microphone, volume);
    }

    /// The gain for `identity`'s screen-share audio, 1.0 is unity (the web
    /// path's screen-share element volume, 0 to 1, 0 when muted).
    pub fn set_screenshare_volume(&self, identity: &str, volume: f32) {
        self.playout
            .mixer()
            .set_gain(identity, playout::Volume::ScreenShare, volume);
    }

    /// Switch the capture or playout device (a running stream moves to it).
    /// An empty id selects the default, the first listed device.
    pub fn set_device(&mut self, kind: &str, device_id: &str) -> Result<(), String> {
        match DeviceKind::parse(kind)? {
            DeviceKind::Output => self.playout.set_device(device_id),
            DeviceKind::Input => self.capture.set_device(device_id),
        }
    }

    pub fn resources(&self) -> Resources {
        Resources {
            rooms: 1,
            local_tracks: usize::from(self.mic.is_some())
                + usize::from(self.camera.lock().unwrap().is_some())
                + usize::from(self.screen_publication.lock().unwrap().is_some()),
            capture_streams: self.capture.streams(),
            audio_streams: self.playout.readers(),
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
        self.capture.stop();
        self.release_camera().await;
        self.release_screen().await;
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
    }
}

async fn forward_events(
    mut events: UnboundedReceiver<RoomEvent>,
    on_event: EventSink,
    frames: Observer,
    playout: playout::Listener,
    published: [VideoSlot; 2],
    mic_withdrawn: MicWithdrawn,
) {
    while let Some(ev) = events.recv().await {
        if let RoomEvent::LocalTrackRepublished {
            previous_sid,
            publication,
            participant,
            ..
        } = &ev
        {
            let source = publication.source();
            let slot = match source {
                TrackSource::Camera => Some(&published[0]),
                TrackSource::Screenshare => Some(&published[1]),
                _ => None,
            };
            let orphan = slot.and_then(|slot| {
                apply_republish(
                    &mut slot.lock().unwrap(),
                    source,
                    previous_sid,
                    &publication.sid(),
                )
            });
            if let Some(sid) = orphan {
                // The video was stopped (slot emptied) or replaced while the
                // SDK was between its unpublish and publish during a full
                // reconnect: this fresh publication (a new sid) found nothing
                // to attach to, so no frames are driven for it and the webview
                // already considers it off. Unpublish it, or it lingers beside
                // the next one.
                let participant = participant.clone();
                tokio::spawn(async move {
                    if let Err(e) = participant.unpublish_track(&sid).await {
                        log::warn!("[native_voice] orphan video unpublish: {e}");
                    }
                });
            }
        }
        if let RoomEvent::ParticipantPermissionChanged {
            participant: Participant::Local(_),
            permission: Some(permission),
        } = &ev
        {
            if !mic_allowed(permission) {
                mic_withdrawn.set();
            }
        }
        // Before the webview hears of a video track, so its frame socket
        // finds it.
        frames.observe(&ev);
        playout.observe(&ev);
        if let Some(mapped) = map_event(ev) {
            on_event(mapped);
        }
    }
}

/// Whether the server's grant lets this participant publish the microphone:
/// an empty source list means every source (LiveKit's rule).
fn mic_allowed(permission: &livekit_protocol::ParticipantPermission) -> bool {
    permission.can_publish
        && (permission.can_publish_sources.is_empty()
            || permission
                .can_publish_sources
                .contains(&(livekit_protocol::TrackSource::Microphone as i32)))
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

/// A video slot's (camera or screen share) response to a local track's
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
    if !matches!(source, TrackSource::Camera | TrackSource::Screenshare) {
        return None;
    }
    match slot.as_mut() {
        Some(c) if c.pending && c.stale.as_ref() == Some(previous_sid) => {
            // The replaced publication's delayed republish: nobody can drive
            // it, and its next republish must be told apart the same way.
            c.stale = Some(sid.clone());
            Some(sid.clone())
        }
        Some(c) if c.pending || c.live == *previous_sid => {
            c.republished(previous_sid, sid.clone());
            None
        }
        _ => Some(sid.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use livekit::e2ee::key_provider::KeyDerivationAlgorithm;
    use livekit_protocol as proto;

    fn permission(
        can_publish: bool,
        sources: &[proto::TrackSource],
    ) -> proto::ParticipantPermission {
        proto::ParticipantPermission {
            can_publish,
            can_publish_sources: sources.iter().map(|s| *s as i32).collect(),
            ..Default::default()
        }
    }

    fn screen(simulcast: bool) -> ScreenOptions {
        ScreenOptions {
            width: 1920,
            height: 1080,
            max_bitrate: 6_000_000,
            max_framerate: 30.0,
            simulcast,
        }
    }

    #[test]
    fn screen_share_simulcasts_with_a_text_friendly_720p_layer() {
        let opts = screen_publish_options(&screen(true));
        assert_eq!(opts.source, TrackSource::Screenshare);
        assert!(opts.simulcast);
        let encoding = opts.video_encoding.expect("top layer encoding");
        assert_eq!(encoding.max_bitrate, 6_000_000);
        assert_eq!(encoding.max_framerate, 30.0);
        let layers = opts.simulcast_layers.expect("custom simulcast layers");
        assert_eq!(layers.len(), 1);
        assert_eq!((layers[0].width, layers[0].height), (1280, 720));
        assert!(layers[0].encoding.max_bitrate <= 1_200_000);
        assert_eq!(layers[0].encoding.max_framerate, 15.0);
    }

    #[test]
    fn screen_share_without_simulcast_is_one_layer() {
        let opts = screen_publish_options(&screen(false));
        assert!(!opts.simulcast);
        assert!(opts.simulcast_layers.is_none());
    }

    fn camera(height: u32, simulcast: bool) -> CameraOptions {
        CameraOptions {
            width: height * 16 / 9,
            height,
            max_bitrate: 4_000_000,
            max_framerate: 30.0,
            simulcast,
        }
    }

    #[test]
    fn a_1080p_camera_gets_360p_and_720p_simulcast_layers() {
        let opts = camera_publish_options(&camera(1080, true));
        assert_eq!(opts.source, TrackSource::Camera);
        assert!(opts.simulcast);
        let layers = opts.simulcast_layers.expect("custom simulcast layers");
        let sizes: Vec<_> = layers.iter().map(|l| (l.width, l.height)).collect();
        assert_eq!(sizes, [(640, 360), (1280, 720)]);
    }

    #[test]
    fn a_720p_camera_keeps_the_sdk_default_layers() {
        let opts = camera_publish_options(&camera(720, true));
        assert!(opts.simulcast);
        assert!(opts.simulcast_layers.is_none());
    }

    #[test]
    fn a_camera_without_simulcast_has_no_layers() {
        assert!(camera_publish_options(&camera(1080, false))
            .simulcast_layers
            .is_none());
    }

    #[test]
    fn mic_publish_options_carry_the_configured_bitrate() {
        let o = mic_publish_options(Some(96_000));
        assert!(matches!(o.source, TrackSource::Microphone));
        assert_eq!(o.audio_encoding.map(|e| e.max_bitrate), Some(96_000));
    }

    #[test]
    fn mic_publish_options_keep_the_sdk_default_without_a_bitrate() {
        assert!(mic_publish_options(None).audio_encoding.is_none());
    }

    #[test]
    fn microphone_permission_event_serializes_for_the_webview() {
        let json = serde_json::to_string(&Event::MicrophonePermission { allowed: false }).unwrap();
        assert_eq!(json, r#"{"type":"microphonePermission","allowed":false}"#);
    }

    #[test]
    fn mic_revoked_when_sources_exclude_microphone() {
        assert!(!mic_allowed(&permission(
            true,
            &[proto::TrackSource::Camera]
        )));
        assert!(!mic_allowed(&permission(false, &[])));
    }

    #[test]
    fn mic_allowed_when_sources_empty_or_listed() {
        assert!(mic_allowed(&permission(true, &[])));
        assert!(mic_allowed(&permission(
            true,
            &[proto::TrackSource::Microphone]
        )));
    }

    #[test]
    fn failed_republish_keeps_the_withdrawal_pending() {
        let w = MicWithdrawn::default();
        w.keep_if_failed(true, &Ok::<(), String>(()));
        assert!(!w.take());
        w.keep_if_failed(false, &Err::<(), _>("denied".into()));
        assert!(!w.take());
        w.keep_if_failed(true, &Err::<(), _>("denied".into()));
        assert!(w.take());
    }

    #[test]
    fn withdrawn_flag_is_consumed_once() {
        let w = MicWithdrawn::default();
        assert!(!w.take());
        w.set();
        assert!(w.take());
        assert!(!w.take());
    }

    /// The Windows client derives from the UTF-8 bytes of the base64 text
    /// (`ExternalE2EEKeyProvider.setKey(string)`), never from the decoded key.
    #[test]
    fn key_material_is_the_base64_text_bytes() {
        let b64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        assert_eq!(shared_key_material(b64), b64.as_bytes());
        assert_ne!(
            shared_key_material(b64).len(),
            32,
            "must not be the decoded key"
        );
    }

    #[test]
    fn key_index_is_zero_and_provider_matches_external_key_provider() {
        assert_eq!(KEY_INDEX, 0);
        let o = key_provider_options();
        assert_eq!(o.ratchet_window_size, 0);
        assert_eq!(o.failure_tolerance, -1);
        assert_eq!(o.ratchet_salt, b"LKFrameEncryptionKey");
        assert!(matches!(
            o.key_derivation_algorithm,
            KeyDerivationAlgorithm::PBKDF2
        ));
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let json = serde_json::to_string(&Event::ActiveSpeakers {
            identities: vec!["user-1".into()],
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"activeSpeakers","identities":["user-1"]}"#);
        let json = serde_json::to_string(&Event::Disconnected {
            reason: "ClientInitiated".into(),
        })
        .unwrap();
        assert!(json.contains(r#""type":"disconnected""#));
    }

    #[test]
    fn video_qualities_are_the_web_names() {
        assert_eq!(video_quality("low"), Ok(VideoQuality::Low));
        assert_eq!(video_quality("medium"), Ok(VideoQuality::Medium));
        assert_eq!(video_quality("high"), Ok(VideoQuality::High));
        assert!(video_quality("off").is_err());
    }

    #[test]
    fn device_kinds_are_the_web_names() {
        assert_eq!(DeviceKind::parse("audioinput"), Ok(DeviceKind::Input));
        assert_eq!(DeviceKind::parse("audiooutput"), Ok(DeviceKind::Output));
        assert!(DeviceKind::parse("videoinput").is_err());
    }

    #[test]
    fn devices_serialize_camel_case() {
        let json = serde_json::to_string(&Devices {
            inputs: vec![DeviceInfo {
                id: "Mic".into(),
                name: "Mic".into(),
                index: 3,
            }],
            outputs: vec![],
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"inputs":[{"id":"Mic","name":"Mic"}],"outputs":[]}"#
        );
    }

    #[test]
    fn unknown_device_ids_fall_back_to_the_default() {
        let device = |name: &str, index| DeviceInfo {
            id: name.into(),
            name: name.into(),
            index,
        };
        let listed = vec![
            device("USB Mic", 0),
            device("Built-in", 1),
            device("Built-in", 2),
        ];
        assert_eq!(resolve_device("Built-in", &listed), (Some(1), false));
        assert_eq!(resolve_device("", &listed), (Some(0), false));
        assert_eq!(resolve_device("unplugged", &listed), (Some(0), true));
        let shifted = vec![device("USB Mic", 0), device("Built-in", 3)];
        assert_eq!(resolve_device("Built-in", &shifted), (Some(3), false));
        assert_eq!(resolve_device("unplugged", &[]), (None, true));
        assert_eq!(resolve_device("", &[]), (None, false));
    }

    #[test]
    fn camera_unpublish_follows_its_republished_sid() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut camera = VideoPublication::new(sid("TR_a"));
        camera.republished(&sid("TR_mic"), sid("TR_mic2"));
        assert_eq!(camera.live, sid("TR_a"), "another track's republish");
        camera.republished(&sid("TR_a"), sid("TR_b"));
        camera.republished(&sid("TR_b"), sid("TR_c"));
        assert_eq!(camera.live, sid("TR_c"));
        assert_eq!(camera.issued, "TR_a", "the webview still names TR_a");
    }

    /// A disable can land while the SDK is between its unpublish of the old
    /// sid and the dispatch of `LocalTrackRepublished` during a full
    /// reconnect: `release_camera` empties the slot, then the event arrives
    /// carrying a fresh publication sid nobody can drive. The slot must hand
    /// that sid back so the forwarder unpublishes it — the alternative is a
    /// camera published with no frames (frozen remote tiles) beside the next
    /// one the webview enables.
    #[test]
    fn a_camera_republished_after_a_disable_is_orphaned_not_adopted() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot = Some(VideoPublication::new(sid("TR_a")));
        // The disable arrives inside the await, before the republish event,
        // emptying the slot.
        assert!(slot.take().is_some());
        assert_eq!(
            apply_republish(&mut slot, TrackSource::Camera, &sid("TR_a"), &sid("TR_b")),
            Some(sid("TR_b")),
            "a republish with no live camera to continue must be unpublished"
        );
        assert!(slot.is_none(), "the orphan must not occupy the slot");

        // The later enable publishes one camera, and its own republish is
        // adopted rather than orphaned: exactly one camera remains.
        let mut slot = Some(VideoPublication::new(sid("TR_c")));
        assert_eq!(
            apply_republish(&mut slot, TrackSource::Camera, &sid("TR_c"), &sid("TR_d")),
            None
        );
        let live = slot.expect("the enabled camera stays published").live;
        assert_eq!(live, sid("TR_d"));
    }

    /// `publish_camera` fills the slot only after `publish_track` returns, so a
    /// full reconnect republishing inside that await used to find it empty and
    /// unpublish the camera it was creating.
    #[test]
    fn a_camera_republished_while_its_first_publish_is_pending_is_adopted() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot = Some(VideoPublication::pending(None));
        assert_eq!(
            apply_republish(&mut slot, TrackSource::Camera, &sid("TR_a"), &sid("TR_b")),
            None,
            "a pending publish must not be orphaned"
        );
        let camera = slot.as_mut().unwrap();
        camera.settle(sid("TR_a"));
        assert_eq!(camera.live, sid("TR_b"), "the republished sid stays live");
        assert_eq!(
            camera.issued, "TR_a",
            "the webview is handed the sid returned"
        );
    }

    #[test]
    fn a_pending_camera_ignores_the_replaced_publications_republish() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot = Some(VideoPublication::pending(Some(sid("TR_old"))));
        // The replaced camera's delayed republish is orphaned, and so is the
        // next one in its chain.
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::Camera,
                &sid("TR_old"),
                &sid("TR_old2")
            ),
            Some(sid("TR_old2"))
        );
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::Camera,
                &sid("TR_old2"),
                &sid("TR_old3")
            ),
            Some(sid("TR_old3"))
        );
        // The pending camera's own republish is still adopted.
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::Camera,
                &sid("TR_new"),
                &sid("TR_new2")
            ),
            None
        );
        let camera = slot.as_mut().unwrap();
        camera.settle(sid("TR_new"));
        assert_eq!(camera.live, sid("TR_new2"));
    }

    #[test]
    fn a_pending_camera_without_a_republish_settles_on_its_sid() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut camera = VideoPublication::pending(None);
        camera.settle(sid("TR_a"));
        assert_eq!(camera.live, sid("TR_a"));
        assert!(!camera.pending);
    }

    #[test]
    fn a_republished_camera_replaced_under_its_old_sid_is_orphaned() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        // A newer camera owns the slot; the stale publication's republish
        // arrives with the old sid and must not be attached to it.
        let mut slot = Some(VideoPublication::new(sid("TR_new")));
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::Camera,
                &sid("TR_old"),
                &sid("TR_old2")
            ),
            Some(sid("TR_old2"))
        );
        assert_eq!(slot.unwrap().live, sid("TR_new"));
    }

    #[test]
    fn a_non_camera_republish_is_never_orphaned() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        // The microphone is tracked by the session, not the camera slot; an
        // empty slot must not make its republish look like a stray camera.
        let mut slot = None;
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::Microphone,
                &sid("TR_mic"),
                &sid("TR_mic2")
            ),
            None
        );
    }

    #[test]
    fn process_threads_reads_procfs() {
        assert!(process_threads() >= 1);
    }
}
