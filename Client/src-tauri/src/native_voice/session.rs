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
use livekit::options::{
    AudioEncoding, DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoding,
    VideoPreset,
};
use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::native::frame_cryptor::EncryptionState;
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
use super::capture::{self, Apm, Capture, GateSink, LevelSink, Sink};
use super::playout::{self, Playout};
use super::screen::{self, CaptureOptions, ScreenCapture, Started, Target};
use super::share_audio::ShareAudio;
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

/// The `RoomOptions` every native session connects with: dynacast on, so a
/// video layer nobody subscribes to is paused (the SDK re-applies the
/// paused layers after every publisher renegotiation, so starting or stopping
/// another track does not resume them), and GCM e2ee.
fn room_options(key_provider: KeyProvider) -> RoomOptions {
    let mut options = RoomOptions::default();
    options.dynacast = true;
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

/// Layer control for one remote video (P3-07, the web path's
/// `setEnabled`/`setVideoQuality`): a stream no one sees stops, a shown one
/// comes at `quality`. The webview maps a tile's size to a quality
/// (`video_quality`) by choice; livekit 0.9.5's `update_video_dimensions` is
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
    /// Whether the server reports the track end-to-end encrypted. The webview
    /// never subscribes one that is not, and neither does `forward_events`.
    pub encrypted: bool,
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
    /// The server's grant for the local participant, once right after
    /// connect and again on every change: livekit-client's
    /// `ParticipantPermission` publish fields, with `can_publish_sources` as
    /// the protocol's `TrackSource` numbers (empty means every source). The
    /// webview gates the microphone, camera and screen share on it, as the
    /// web path does with `localParticipant.permissions`.
    Permission {
        #[serde(rename = "canPublish")]
        can_publish: bool,
        #[serde(rename = "canPublishSources")]
        can_publish_sources: Vec<i32>,
    },
    /// The input-sensitivity gate opened (speech) or closed (silence). It
    /// lights the local speaking ring, as the web path's detector does.
    VoiceGate {
        open: bool,
    },
    /// A level report from the capture, every ~50 ms while it runs: the
    /// loudest ~10 ms RMS after the input volume, and whether the voice gate
    /// is open. It drives the settings meter and automatic sensitivity, as
    /// the web path's detector reports do.
    InputLevel {
        rms: f32,
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

fn track_info(
    sid: String,
    kind: TrackKind,
    source: TrackSource,
    muted: bool,
    encryption: EncryptionType,
) -> TrackInfo {
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
        encrypted: is_encrypted(encryption),
    }
}

/// Whether a publication is end-to-end encrypted, by the same test the SDK
/// uses to attach its frame cryptor.
fn is_encrypted(encryption: EncryptionType) -> bool {
    encryption != EncryptionType::None
}

fn remote_pub_info(p: &RemoteTrackPublication) -> TrackInfo {
    track_info(
        p.sid().to_string(),
        p.kind(),
        p.source(),
        p.is_muted(),
        p.encryption_type(),
    )
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
        } => permission_event(&permission),
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

/// The video codec a publish asks for (WP LP-7c). VP8 is the default and what
/// a webview that sends no `codec` gets; H.264 is sent only when
/// `native_voice_video_codecs` says the engine can encode it; so is VP9 (WP
/// M-11b), which goes out as one SVC layer and never simulcast.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PublishCodec {
    #[default]
    Vp8,
    H264,
    Vp9,
}

impl PublishCodec {
    fn video_codec(self) -> VideoCodec {
        match self {
            PublishCodec::Vp8 => VideoCodec::VP8,
            PublishCodec::H264 => VideoCodec::H264,
            PublishCodec::Vp9 => VideoCodec::VP9,
        }
    }

    /// The RTP scalability mode this codec publishes with. VP9 is one spatial
    /// layer with three temporal layers (`L1T3`): the SFU can drop temporal
    /// layers for a slow viewer, and it is what browsers decode. Simulcast is
    /// off for it, because the SDK builds one encoding when a mode is set.
    fn svc(self) -> Option<String> {
        match self {
            PublishCodec::Vp9 => Some("L1T3".to_string()),
            PublishCodec::Vp8 | PublishCodec::H264 => None,
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
    #[serde(default)]
    pub codec: PublishCodec,
}

/// The screen share's publish options. With simulcast it adds the web path's
/// one lower layer (`SCREENSHARE_SIMULCAST_LAYERS`): 720p at 15 fps and at
/// most 1.2 Mbps, so a viewer who cannot take the full stream still gets
/// readable text instead of a frozen frame, and the top layer keeps most of
/// the budget. Like the web path's `screenShareDegradation`, a 120 fps share
/// degrades `Balanced` (resolution before frame rate); lower rates keep
/// resolution.
fn screen_publish_options(opts: &ScreenOptions) -> TrackPublishOptions {
    let scalability_mode = opts.codec.svc();
    let simulcast = opts.simulcast && scalability_mode.is_none();
    TrackPublishOptions {
        source: TrackSource::Screenshare,
        simulcast,
        scalability_mode,
        simulcast_layers: simulcast.then(|| {
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
        video_codec: opts.codec.video_codec(),
        degradation_preference: Some(if opts.max_framerate >= 120.0 {
            DegradationPreference::Balanced
        } else {
            DegradationPreference::MaintainResolution
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
    #[serde(default)]
    pub codec: PublishCodec,
}

/// The camera's publish options. A 1080p camera adds the web path's
/// `cameraSimulcastLayers` (360p and 720p) so a viewer on a 1-3 Mbps link gets
/// 720p rather than the SDK default's 360p; 720p and below keep the defaults.
fn camera_publish_options(opts: &CameraOptions) -> TrackPublishOptions {
    let scalability_mode = opts.codec.svc();
    let simulcast = opts.simulcast && scalability_mode.is_none();
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
        simulcast,
        scalability_mode,
        simulcast_layers: (simulcast && opts.height > 720).then(|| {
            vec![
                layer(640, 360, 450_000, 20.0),
                layer(1280, 720, 1_700_000, 30.0),
            ]
        }),
        video_encoding: Some(VideoEncoding {
            max_bitrate: opts.max_bitrate,
            max_framerate: opts.max_framerate,
        }),
        video_codec: opts.codec.video_codec(),
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

/// The screen share's audio publish options, the web path's
/// `SCREENSHARE_AUDIO_PUBLISH` (screenShare.ts): no DTX, 128 kbps
/// (`musicHighQualityStereo`) and no RED, which livekit-client leaves off for
/// a stereo track and the Rust SDK forces off under E2EE anyway.
///
/// `stereo` (LP-8d) is the flag of the vendored livekit crate
/// (`vendor/livekit/OWNCORD-PATCH.md`): it makes the SFU's publisher answer
/// carry `stereo=1`, so the encoder is built with two channels instead of
/// downmixing the share to mono. The mic, camera and screen video options
/// leave it off.
fn screen_audio_publish_options() -> TrackPublishOptions {
    TrackPublishOptions {
        source: TrackSource::ScreenshareAudio,
        dtx: false,
        red: false,
        audio_encoding: Some(livekit::options::audio::MUSIC_HIGH_QUALITY_STEREO.encoding),
        stereo: true,
        ..Default::default()
    }
}

/// The source the share audio feeds: 48 kHz stereo, unbuffered (the capture
/// thread paces it).
pub fn screen_audio_source() -> NativeAudioSource {
    NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 2, 0)
}

/// A published camera or screen share. `issued` is the sid the webview was
/// handed and must name to unpublish; `live` follows the SDK's republish
/// after a full reconnect, which re-issues the sid of the same track.
/// `capture` is the capture it carries, the id the webview names to stop it.
struct VideoPublication {
    issued: String,
    live: TrackSid,
    capture: Option<u64>,
}

impl VideoPublication {
    fn new(sid: TrackSid) -> Self {
        Self {
            issued: sid.to_string(),
            live: sid,
            capture: None,
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
    next_capture: u64,
    next_camera: u64,
    on_event: EventSink,
    frames: FrameServer,
    playout: Playout,
    capture: Capture,
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
        // LP-8d: the share audio's stereo comes from the publish options (the
        // server's answer), not from this mode; the log records which mode the
        // server granted, which decides whether a native viewer decodes it.
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
        let playout = Playout::default();
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
            camera,
            camera_capture: None,
            screen: None,
            camera_change: None,
            screen_change: None,
            screen_publication,
            screen_audio,
            share_audio: None,
            next_capture: 0,
            next_camera: 0,
            on_event,
            frames,
            playout,
            capture: Capture::default(),
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
        // Options asked for before this ran win over the connect-time ones.
        let opts = self.audio.unwrap_or(opts);
        self.audio = Some(opts);
        let apm = Apm::new(&opts);
        self.playout.set_reference(apm.clone());
        let (on_gate, on_level, emitter) = capture_report_sinks(self.on_event.clone());
        self.capture_reports = Some(emitter);
        self.capture.configure(
            apm.clone(),
            opts.enhanced_noise_suppression,
            on_gate,
            on_level,
        );
        self.apm = Some(apm);
        if let Err(e) = self.playout.set_device("") {
            log::warn!("[native_voice] playout unavailable: {e}");
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
                    self.capture
                        .set_processing(apm.clone(), audio.enhanced_noise_suppression);
                }
                self.audio = Some(audio);
            }
            ProcessingChange::Rebuild => {
                let apm = Apm::new(&audio);
                self.playout.set_reference(apm.clone());
                self.capture
                    .set_processing(apm.clone(), audio.enhanced_noise_suppression);
                retire(&mut self.retired, self.apm.replace(apm));
                self.audio = Some(audio);
            }
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
            self.capture.start(Sink::Track(source.clone()))?;
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
                self.capture.start(Sink::Track(source.clone()))?;
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

    /// Set the input-sensitivity gate's threshold (0: no gate); `retune`
    /// moves it without restarting the detector.
    pub fn set_voice_gate(&self, threshold: f32, retune: bool) {
        self.capture.set_voice_gate(threshold, retune);
    }

    /// Set the input volume as a linear gain (0 to 2).
    pub fn set_input_gain(&self, gain: f32) {
        self.capture.set_input_gain(gain);
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
        *self.camera.lock().unwrap() = Some(VideoPublication::of_capture(sid.clone(), capture));
        Ok(sid.to_string())
    }

    /// Start capturing `target` to replace the published camera's device,
    /// leaving the live capture and its publication running. Returns the new
    /// capture's id and its first-frame receiver, as `start_camera`; the
    /// caller awaits it without holding the session, then calls
    /// `finish_camera_change` (or `stop_camera` to give up).
    pub fn start_camera_change(
        &mut self,
        target: CameraTarget,
        options: CameraCaptureOptions,
    ) -> Result<(u64, Started), String> {
        if !self.camera_published() {
            return Err("no published camera to change".into());
        }
        self.camera_change.take();
        self.next_camera += 1;
        let id = self.next_camera;
        let on_event = self.on_event.clone();
        let (capture, started) = CameraCapture::start(target, options, move || {
            on_event(Event::CameraCaptureEnded { capture: id })
        })?;
        self.camera_change = Some(CameraShare { id, capture });
        Ok((id, started))
    }

    /// Move the published camera onto capture `capture` (started by
    /// `start_camera_change`): same publication and sid, same preview socket,
    /// and the old capture is released. Fails, changing nothing, when a stop,
    /// a new camera or another change came first.
    pub fn finish_camera_change(&mut self, capture: u64) -> Result<(), String> {
        let next = self
            .camera_change
            .take_if(|c| c.id == capture)
            .ok_or("the camera change was superseded")?;
        let Some(live) = self.camera_capture.as_mut() else {
            return Err("the camera stopped during the change".into());
        };
        {
            // One guard for the published check and the write: a release
            // clearing the slot in between must not be written over.
            let mut slot = self.camera.lock().unwrap();
            let Some(publication) = slot.as_mut().filter(|p| p.capture == Some(live.id)) else {
                return Err("the camera stopped during the change".into());
            };
            // The source keeps the size it was published at: the encoder follows
            // each frame's own size (as on the web path's replaceTrack).
            next.capture.take_over(&live.capture);
            publication.capture = Some(next.id);
        }
        // Dropping the old capture joins its thread and frees its device; the
        // preview lives on in `next`.
        drop(std::mem::replace(live, next));
        Ok(())
    }

    /// Whether the running capture is the one published as the camera.
    fn camera_published(&self) -> bool {
        let live = self.camera_capture.as_ref().map(|c| c.id);
        live.is_some()
            && self
                .camera
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|p| p.capture == live)
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
    async fn release_camera_publication(&mut self) {
        let camera = self.camera.lock().unwrap().take();
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
    pub async fn stop_camera(&mut self, capture: u64) {
        if self.camera_change.as_ref().is_some_and(|c| c.id == capture) {
            self.camera_change.take();
        }
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
        self.camera_change.take();
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
        self.unpublish_screen().await;
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
            .map_err(|e| e.to_string())?;
        self.require_encrypted(&publication).await?;
        let sid = publication.sid();
        if let Some(screen) = &self.screen {
            screen.capture.set_source(Some(source));
        }
        let capture = self.screen.as_ref().map(|s| s.id);
        *self.screen_publication.lock().unwrap() =
            Some(VideoPublication::of_capture(sid.clone(), capture));
        Ok(sid.to_string())
    }

    /// Publish the other applications' sound as the screen share's audio,
    /// alongside running capture `capture` (replacing an earlier one). The
    /// capture (`share_audio.rs`) starts here and ends with the publication.
    /// Returns the publication's sid.
    pub async fn publish_screen_audio(&mut self, capture: u64) -> Result<String, String> {
        if !self.screen.as_ref().is_some_and(|s| s.id == capture) {
            return Err(format!("screen capture {capture} is not running"));
        }
        let source = screen_audio_source();
        let app = self
            .screen
            .as_ref()
            .and_then(|s| screen::target_pid(s.capture.target()));
        let feed = ShareAudio::start(source.clone(), app);
        self.publish_screen_audio_from(capture, source, Some(feed))
            .await
    }

    /// As `publish_screen_audio`, but fed by the caller: the interop example's
    /// synthetic stereo tone (CI has no sound server).
    pub async fn publish_screen_audio_source(
        &mut self,
        capture: u64,
        source: NativeAudioSource,
    ) -> Result<String, String> {
        self.publish_screen_audio_from(capture, source, None).await
    }

    async fn publish_screen_audio_from(
        &mut self,
        capture: u64,
        source: NativeAudioSource,
        feed: Option<ShareAudio>,
    ) -> Result<String, String> {
        if !self.screen.as_ref().is_some_and(|s| s.id == capture) {
            return Err(format!("screen capture {capture} is not running"));
        }
        // Replace semantics. On any error below `feed` drops with this frame,
        // leaving the slot empty and no capture thread behind.
        self.release_screen_audio().await;
        let track = LocalAudioTrack::create_audio_track(
            "screen_share_audio",
            RtcAudioSource::Native(source),
        );
        let publication = self
            .room
            .local_participant()
            .publish_track(LocalTrack::Audio(track), screen_audio_publish_options())
            .await
            .map_err(|e| e.to_string())?;
        self.require_encrypted(&publication).await?;
        let sid = publication.sid();
        *self.screen_audio.lock().unwrap() =
            Some(VideoPublication::of_capture(sid.clone(), Some(capture)));
        self.share_audio = feed;
        Ok(sid.to_string())
    }

    /// The opus codec the published screen-share audio `sid` was negotiated
    /// with, as the sender's stats report it: `(channels, sdp_fmtp_line)`.
    /// The LP-8d interop example prints it to prove the publisher is stereo.
    pub async fn screen_audio_codec(&self, sid: &str) -> Result<(u32, String), String> {
        let publication = self
            .room
            .local_participant()
            .track_publications()
            .into_values()
            .find(|p| p.sid().as_str() == sid)
            .ok_or_else(|| format!("screen audio {sid} is not published"))?;
        let Some(LocalTrack::Audio(track)) = publication.track() else {
            return Err(format!("screen audio {sid} has no audio track"));
        };
        let stats = track
            .get_stats()
            .await
            .map_err(|e| format!("screen audio stats: {e}"))?;
        stats
            .into_iter()
            .find_map(|s| match s {
                RtcStats::Codec(c) if c.codec.mime_type.to_ascii_lowercase().contains("opus") => {
                    Some((c.codec.channels, c.codec.sdp_fmtp_line))
                }
                _ => None,
            })
            .ok_or_else(|| "screen audio stats carry no opus codec".to_string())
    }

    /// Unpublish screen audio `sid` if it is still the published one; a stale
    /// sid, one a later publish replaced, is a no-op.
    pub async fn unpublish_screen_audio(&mut self, sid: &str) {
        let issued = self
            .screen_audio
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.issued == sid);
        if issued {
            self.release_screen_audio().await;
        }
    }

    /// Unpublish the screen audio and stop its capture thread (joined on
    /// drop). Called by `release_screen` (stop, close, a new share) and not by
    /// `unpublish_screen`, so a codec republish keeps the audio, as the web
    /// path does (screenShare.ts: "Screen audio stays published"); the
    /// interop example's `--republish-screen` and stop cover both.
    async fn release_screen_audio(&mut self) {
        let publication = self.screen_audio.lock().unwrap().take();
        self.share_audio.take();
        if let Some(publication) = publication {
            if let Err(e) = self
                .room
                .local_participant()
                .unpublish_track(&publication.live)
                .await
            {
                log::warn!("[native_voice] screen audio unpublish: {e}");
            }
        }
    }

    /// Start capturing `target` to replace the published share's source,
    /// leaving the live capture and its publication running. Returns the
    /// new capture's id and its first-frame receiver, as `start_screen`;
    /// the caller awaits it without holding the session, then calls
    /// `finish_screen_change` (or `stop_screen` to give up).
    pub fn start_screen_change(
        &mut self,
        target: Target,
        options: CaptureOptions,
    ) -> Result<(u64, Started), String> {
        if !self.screen_published() {
            return Err("no published screen share to change".into());
        }
        self.screen_change.take();
        self.next_capture += 1;
        let id = self.next_capture;
        let on_event = self.on_event.clone();
        let (capture, started) = ScreenCapture::start(target, options, move || {
            on_event(Event::ScreenCaptureEnded { capture: id })
        })?;
        self.screen_change = Some(ScreenShare { id, capture });
        Ok((id, started))
    }

    /// Move the published share onto capture `capture` (started by
    /// `start_screen_change`): same publication and sid, same preview socket,
    /// and the old capture is released. Fails, changing nothing, when a stop,
    /// a new share or another change came first.
    pub fn finish_screen_change(&mut self, capture: u64) -> Result<(), String> {
        let next = self
            .screen_change
            .take_if(|c| c.id == capture)
            .ok_or("the screen source change was superseded")?;
        let Some(live) = self.screen.as_mut() else {
            return Err("the screen share stopped during the source change".into());
        };
        {
            // One guard for the published check and the write: a release
            // clearing the slot in between must not be written over.
            let mut slot = self.screen_publication.lock().unwrap();
            let Some(publication) = slot.as_mut().filter(|p| p.capture == Some(live.id)) else {
                return Err("the screen share stopped during the source change".into());
            };
            // The source keeps the size it was published at: the encoder follows
            // each frame's own size, but the layer sizes the server was told stay
            // (as on the web path's replaceTrack).
            next.capture.take_over(&live.capture);
            publication.capture = Some(next.id);
        }
        {
            // The share audio follows the capture that is live, so a
            // withdrawal ends that one. A short lock of its own, taken after
            // the video slot's guard is released.
            let mut slot = self.screen_audio.lock().unwrap();
            if let Some(audio) = slot.as_mut().filter(|a| a.capture == Some(live.id)) {
                audio.capture = Some(next.id);
                // A window's share sound is that app's: follow the new source.
                if let Some(feed) = &self.share_audio {
                    feed.set_app(screen::target_pid(next.capture.target()));
                }
            }
        }
        // Dropping the old share joins its capture thread (and, on Wayland,
        // closes its portal session); the preview lives on in `next`.
        drop(std::mem::replace(live, next));
        Ok(())
    }

    /// Change the live share's quality: re-size and re-pace the running
    /// capture, then publish it again with `publish` at the new size (the
    /// SDK cannot change a sender's encoding). One `&mut self` hold covers
    /// both steps, so a stop, source change or leave queued behind it runs
    /// after the new publication exists and releases it, and one that came
    /// first makes the gate refuse. Returns the new sid and the size.
    pub async fn set_screen_quality(
        &mut self,
        capture: u64,
        options: CaptureOptions,
        publish: ScreenOptions,
    ) -> Result<(String, u32, u32), QualityError> {
        quality_gate(
            self.screen.as_ref().map(|s| s.id),
            self.screen_published(),
            self.screen_change.is_some(),
            capture,
        )?;
        let size = self
            .screen
            .as_ref()
            .and_then(|s| s.capture.set_options(options));
        let (width, height) = size.unwrap_or((publish.width, publish.height));
        let sid = self
            .publish_screen(
                capture,
                ScreenOptions {
                    width,
                    height,
                    ..publish
                },
            )
            .await
            .map_err(QualityError::Publish)?;
        Ok((sid, width, height))
    }

    /// Whether the running capture is the one published as the screen share.
    fn screen_published(&self) -> bool {
        let live = self.screen.as_ref().map(|s| s.id);
        live.is_some()
            && self
                .screen_publication
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|p| p.capture == live)
    }

    /// Stop capture `capture` if it is still the running one (a stale id is
    /// a no-op): unpublish it, and release the capturer and, on Wayland, the
    /// portal session. A pending source change's capture is only dropped.
    pub async fn stop_screen(&mut self, capture: u64) {
        if self.screen_change.as_ref().is_some_and(|s| s.id == capture) {
            self.screen_change.take();
        }
        if self.screen.as_ref().is_some_and(|s| s.id == capture) {
            self.release_screen().await;
        }
    }

    /// Unpublish the screen share if `capture` is the running one, keeping the
    /// capture alive (a codec republish publishes it again). A stale id is a
    /// no-op.
    pub async fn unpublish_screen_keep_capture(&mut self, capture: u64) {
        if self.screen.as_ref().is_some_and(|s| s.id == capture) {
            self.unpublish_screen().await;
        }
    }

    async fn unpublish_screen(&mut self) {
        if let Some(screen) = &self.screen {
            screen.capture.set_source(None);
        }
        let publication = self.screen_publication.lock().unwrap().take();
        if let Some(publication) = publication {
            if let Err(e) = self
                .room
                .local_participant()
                .unpublish_track(&publication.live)
                .await
            {
                log::warn!("[native_voice] screen unpublish: {e}");
            }
        }
    }

    async fn release_screen(&mut self) {
        self.screen_change.take();
        self.release_screen_audio().await;
        self.unpublish_screen().await;
        self.frames.set_screen(None);
        // Dropping joins the capture thread.
        self.screen.take();
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
        // One slot lock at a time (see the lock order at `screen_audio`).
        let camera = usize::from(self.camera.lock().unwrap().is_some());
        let screen = usize::from(self.screen_publication.lock().unwrap().is_some());
        let screen_audio = usize::from(self.screen_audio.lock().unwrap().is_some());
        Resources {
            rooms: 1,
            local_tracks: usize::from(self.mic.is_some()) + camera + screen + screen_audio,
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
        if let Some(reports) = &self.capture_reports {
            reports.abort();
        }
    }
}

async fn forward_events(
    mut events: UnboundedReceiver<RoomEvent>,
    on_event: EventSink,
    frames: Observer,
    playout: playout::Listener,
    published: [VideoSlot; 3],
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
                TrackSource::ScreenshareAudio => Some(&published[2]),
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
        if let RoomEvent::LocalTrackRepublished {
            publication,
            participant,
            ..
        } = &ev
        {
            if !is_encrypted(publication.encryption_type()) {
                withdraw_unencrypted(participant, publication).await;
                // Clear what the session holds for the withdrawn track, so the
                // next enable publishes a fresh one: the microphone republishes
                // on its next unmute, and a camera or screen share is ended
                // the way a capture that stops on its own is.
                let sid = publication.sid();
                let ended = match publication.source() {
                    TrackSource::Microphone => {
                        mic_withdrawn.set();
                        None
                    }
                    TrackSource::Camera => release_slot(&mut published[0].lock().unwrap(), &sid)
                        .map(|capture| Event::CameraCaptureEnded { capture }),
                    TrackSource::Screenshare => {
                        release_slot(&mut published[1].lock().unwrap(), &sid)
                            .map(|capture| Event::ScreenCaptureEnded { capture })
                    }
                    // The share ends the way a stopped capture does; the
                    // webview's stop releases the capture thread.
                    TrackSource::ScreenshareAudio => {
                        release_slot(&mut published[2].lock().unwrap(), &sid)
                            .map(|capture| Event::ScreenCaptureEnded { capture })
                    }
                    _ => None,
                };
                if let Some(ended) = ended {
                    on_event(ended);
                }
                on_event(Event::EncryptionStatus {
                    identity: participant.identity().to_string(),
                    encrypted: false,
                });
                continue;
            }
        }
        if let RoomEvent::TrackSubscribed {
            publication,
            participant,
            ..
        } = &ev
        {
            // Only end-to-end encrypted tracks reach playout, the frame
            // socket and the webview.
            if !is_encrypted(publication.encryption_type()) {
                publication.set_subscribed(false);
                let identity = participant.identity().to_string();
                log::warn!(
                    "[native_voice] refusing a track from {} published without end-to-end encryption",
                    identity.split(':').next().unwrap_or_default()
                );
                continue;
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

/// Stop and unpublish a local publication that is not end-to-end encrypted.
async fn withdraw_unencrypted(participant: &LocalParticipant, publication: &LocalTrackPublication) {
    if let Some(track) = publication.track() {
        track.disable();
    }
    if let Err(e) = participant.unpublish_track(&publication.sid()).await {
        log::warn!("[native_voice] unencrypted publication unpublish: {e}");
    }
    log::error!("[native_voice] the media server did not accept end-to-end encryption for a track");
}

/// Empty a video slot whose live publication is `sid`, returning the capture
/// it carried. A slot holding any other publication is left alone.
fn release_slot(slot: &mut Option<VideoPublication>, sid: &TrackSid) -> Option<u64> {
    if slot.as_ref().is_some_and(|p| p.live == *sid) {
        return slot.take().and_then(|p| p.capture);
    }
    None
}

fn permission_event(permission: &livekit_protocol::ParticipantPermission) -> Event {
    Event::Permission {
        can_publish: permission.can_publish,
        can_publish_sources: permission.can_publish_sources.clone(),
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
mod tests {
    use super::*;
    use livekit::e2ee::key_provider::KeyDerivationAlgorithm;
    use livekit_protocol as proto;

    #[test]
    fn room_options_enable_dynacast_and_gcm_e2ee() {
        let key_provider = KeyProvider::with_shared_key(key_provider_options(), vec![7; 32]);
        let options = room_options(key_provider.clone());
        assert!(options.dynacast);
        #[allow(deprecated)]
        let e2ee = options.e2ee;
        let e2ee = e2ee.expect("e2ee is configured");
        assert!(matches!(e2ee.encryption_type, EncryptionType::Gcm));
    }

    #[test]
    fn retire_keeps_every_generation_a_follower_still_holds() {
        let mut retired = Vec::new();
        let first = Arc::new(1);
        let held_by_lagging_callback = first.clone();
        retire(&mut retired, Some(first));
        retire(&mut retired, Some(Arc::new(2)));
        assert_eq!(retired.len(), 2, "the first generation is still held");
        drop(held_by_lagging_callback);
        retire(&mut retired, None);
        assert!(retired.is_empty(), "unheld generations are freed here");
    }

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
            codec: PublishCodec::default(),
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
    fn screen_quality_is_refused_without_a_published_share() {
        let refused = |r: Result<(), QualityError>| matches!(r, Err(QualityError::Refused(_)));
        assert!(quality_gate(Some(4), true, false, 4).is_ok());
        // No capture, an unpublished one (a failed republish or a codec
        // switch in flight), or a stale id (a source change or stop came
        // first).
        assert!(refused(quality_gate(None, false, false, 4)));
        assert!(refused(quality_gate(Some(4), false, false, 4)));
        assert!(refused(quality_gate(Some(5), true, false, 4)));
        // A pending source change keeps the options it started with.
        assert!(refused(quality_gate(Some(4), true, true, 4)));
    }

    #[test]
    fn a_quality_error_names_its_stage_for_the_webview() {
        let json = |e| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(QualityError::Refused("x".into())),
            serde_json::json!({"stage": "refused", "message": "x"})
        );
        assert_eq!(
            json(QualityError::Publish("y".into())),
            serde_json::json!({"stage": "publish", "message": "y"})
        );
    }

    #[test]
    fn screen_share_without_simulcast_is_one_layer() {
        let opts = screen_publish_options(&screen(false));
        assert!(!opts.simulcast);
        assert!(opts.simulcast_layers.is_none());
    }

    #[test]
    fn a_120_fps_screen_share_degrades_balanced_and_lower_rates_keep_resolution() {
        let mut opts = screen(false);
        assert_eq!(
            screen_publish_options(&opts).degradation_preference,
            Some(DegradationPreference::MaintainResolution)
        );
        opts.max_framerate = 60.0;
        assert_eq!(
            screen_publish_options(&opts).degradation_preference,
            Some(DegradationPreference::MaintainResolution)
        );
        opts.max_framerate = 120.0;
        assert_eq!(
            screen_publish_options(&opts).degradation_preference,
            Some(DegradationPreference::Balanced)
        );
    }

    fn camera(height: u32, simulcast: bool) -> CameraOptions {
        CameraOptions {
            width: height * 16 / 9,
            height,
            max_bitrate: 4_000_000,
            max_framerate: 30.0,
            simulcast,
            codec: PublishCodec::default(),
        }
    }

    #[test]
    fn camera_publish_options_carry_the_codec() {
        let mut opts = camera(720, false);
        assert_eq!(camera_publish_options(&opts).video_codec, VideoCodec::VP8);
        opts.codec = PublishCodec::H264;
        assert_eq!(camera_publish_options(&opts).video_codec, VideoCodec::H264);
    }

    #[test]
    fn screen_publish_options_carry_the_codec() {
        let mut opts = screen(false);
        assert_eq!(screen_publish_options(&opts).video_codec, VideoCodec::VP8);
        opts.codec = PublishCodec::H264;
        assert_eq!(screen_publish_options(&opts).video_codec, VideoCodec::H264);
    }

    #[test]
    fn vp9_publish_is_one_svc_layer_without_simulcast() {
        // Camera: a 1080p simulcast request, which would add two layers for
        // VP8, is one L1T3 encoding for VP9.
        let mut cam = camera(1080, true);
        cam.codec = PublishCodec::Vp9;
        let opts = camera_publish_options(&cam);
        assert_eq!(opts.video_codec, VideoCodec::VP9);
        assert_eq!(opts.scalability_mode.as_deref(), Some("L1T3"));
        assert!(!opts.simulcast);
        assert!(opts.simulcast_layers.is_none());

        // Screen share, the same.
        let mut share = screen(true);
        share.codec = PublishCodec::Vp9;
        let opts = screen_publish_options(&share);
        assert_eq!(opts.video_codec, VideoCodec::VP9);
        assert_eq!(opts.scalability_mode.as_deref(), Some("L1T3"));
        assert!(!opts.simulcast);
        assert!(opts.simulcast_layers.is_none());

        // VP8 and H.264 keep their simulcast and set no scalability mode.
        assert!(camera_publish_options(&camera(1080, true))
            .scalability_mode
            .is_none());
        assert!(screen_publish_options(&screen(true))
            .scalability_mode
            .is_none());
        assert!(PublishCodec::H264.svc().is_none());
    }

    #[test]
    fn codec_defaults_to_vp8_when_absent() {
        let camera: CameraOptions = serde_json::from_str(
            r#"{"width":1280,"height":720,"maxBitrate":1,"maxFramerate":30.0,"simulcast":false}"#,
        )
        .expect("camera options without codec");
        assert_eq!(camera.codec, PublishCodec::Vp8);
        let screen: ScreenOptions = serde_json::from_str(
            r#"{"width":1280,"height":720,"maxBitrate":1,"maxFramerate":30.0,"simulcast":false}"#,
        )
        .expect("screen options without codec");
        assert_eq!(screen.codec, PublishCodec::Vp8);
        let h264: CameraOptions = serde_json::from_str(
            r#"{"width":1,"height":1,"maxBitrate":1,"maxFramerate":1.0,"simulcast":false,"codec":"h264"}"#,
        )
        .expect("camera options with h264");
        assert_eq!(h264.codec, PublishCodec::H264);
        let vp9: CameraOptions = serde_json::from_str(
            r#"{"width":1,"height":1,"maxBitrate":1,"maxFramerate":1.0,"simulcast":false,"codec":"vp9"}"#,
        )
        .expect("camera options with vp9");
        assert_eq!(vp9.codec, PublishCodec::Vp9);
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
    fn permission_event_serializes_for_the_webview() {
        let json = serde_json::to_string(&permission_event(&permission(
            true,
            &[proto::TrackSource::Microphone, proto::TrackSource::Camera],
        )))
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"permission","canPublish":true,"canPublishSources":[2,1]}"#
        );
    }

    #[test]
    fn permission_event_carries_a_full_denial() {
        let json = serde_json::to_string(&permission_event(&permission(false, &[]))).unwrap();
        assert_eq!(
            json,
            r#"{"type":"permission","canPublish":false,"canPublishSources":[]}"#
        );
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
    fn only_a_gcm_or_custom_track_counts_as_encrypted() {
        assert!(!is_encrypted(EncryptionType::None));
        assert!(is_encrypted(EncryptionType::Gcm));
        assert!(is_encrypted(EncryptionType::Custom));
        let info = track_info(
            "TR_a".into(),
            TrackKind::Audio,
            TrackSource::Microphone,
            false,
            EncryptionType::None,
        );
        assert!(!info.encrypted);
    }

    #[test]
    fn releasing_a_withdrawn_video_empties_only_its_own_slot() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot = Some(VideoPublication::of_capture(sid("TR_a"), Some(7)));
        assert_eq!(release_slot(&mut slot, &sid("TR_b")), None);
        assert!(slot.is_some());
        assert_eq!(release_slot(&mut slot, &sid("TR_a")), Some(7));
        assert!(slot.is_none());
        let mut uncaptured = Some(VideoPublication::new(sid("TR_c")));
        assert_eq!(release_slot(&mut uncaptured, &sid("TR_c")), None);
        assert!(uncaptured.is_none());
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

    /// The audio thread's report sinks only queue: with the emitter not yet
    /// run they return at once, past a full queue, and the emitter then
    /// delivers what fit, in order.
    #[tokio::test]
    async fn capture_reports_queue_without_blocking_and_arrive_in_order() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (on_gate, on_level, emitter) = capture_report_sinks(Arc::new(move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::to_string(&event).unwrap());
        }));
        on_gate(false);
        for _ in 0..CAPTURE_REPORT_QUEUE * 2 {
            on_level(0.5, false);
        }
        drop((on_gate, on_level));
        emitter.await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), CAPTURE_REPORT_QUEUE, "the overflow is dropped");
        assert_eq!(seen[0], r#"{"type":"voiceGate","open":false}"#);
        assert_eq!(seen[1], r#"{"type":"inputLevel","rms":0.5,"open":false}"#);
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
        let json = serde_json::to_string(&Event::InputLevel {
            rms: 0.25,
            open: false,
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"inputLevel","rms":0.25,"open":false}"#);
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
    fn screen_audio_publish_options_match_the_web_path() {
        let opts = screen_audio_publish_options();
        assert_eq!(opts.source, TrackSource::ScreenshareAudio);
        assert!(!opts.dtx);
        assert!(!opts.red);
        assert_eq!(
            opts.audio_encoding.map(|e| e.max_bitrate),
            Some(128_000),
            "musicHighQualityStereo"
        );
        assert!(opts.stereo, "the share audio asks the SFU for stereo opus");
    }

    #[test]
    fn mic_and_video_publish_options_stay_mono() {
        // TF_STEREO would double the mic's bitrate and switch opus out of
        // VoIP mode; only the share audio asks for it.
        assert!(!TrackPublishOptions::default().stereo);
        assert!(!mic_publish_options(None).stereo);
        assert!(!mic_publish_options(Some(96_000)).stereo);
        assert!(!camera_publish_options(&camera(720, true)).stereo);
        assert!(!camera_publish_options(&camera(1080, false)).stereo);
        assert!(!screen_publish_options(&screen(true)).stereo);
        assert!(!screen_publish_options(&screen(false)).stereo);
    }

    #[test]
    fn a_republished_share_audio_follows_its_new_sid() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot = Some(VideoPublication::of_capture(sid("TR_a"), Some(3)));
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::ScreenshareAudio,
                &sid("TR_a"),
                &sid("TR_b")
            ),
            None
        );
        let audio = slot.expect("still published");
        assert_eq!(audio.live, sid("TR_b"));
        assert_eq!(audio.issued, "TR_a", "the webview still names TR_a");
        assert_eq!(audio.capture, Some(3));
    }

    #[test]
    fn a_share_audio_republished_after_a_stop_is_orphaned() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot: Option<VideoPublication> = None;
        assert_eq!(
            apply_republish(
                &mut slot,
                TrackSource::ScreenshareAudio,
                &sid("TR_a"),
                &sid("TR_b")
            ),
            Some(sid("TR_b"))
        );
        assert!(slot.is_none(), "the orphan must not occupy the slot");
    }

    #[test]
    fn an_unencrypted_share_audio_republish_ends_the_share() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut slot = Some(VideoPublication::of_capture(sid("TR_a"), Some(9)));
        assert_eq!(release_slot(&mut slot, &sid("TR_a")), Some(9));
        assert!(slot.is_none());
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

    fn audio(ec: bool, enhanced: bool) -> AudioOptions {
        AudioOptions {
            echo_cancellation: ec,
            noise_suppression: true,
            auto_gain_control: true,
            enhanced_noise_suppression: enhanced,
        }
    }

    /// A toggle that changes nothing must not replace the processing (and
    /// reset the echo canceller's adaptation); an Enhanced Noise Suppression
    /// change only switches the denoiser; any other change rebuilds it, and
    /// before audio is enabled it is only remembered.
    #[test]
    fn set_audio_processing_rebuilds_only_on_a_change() {
        let on = audio(true, false);
        assert_eq!(
            processing_change(true, Some(on), on),
            ProcessingChange::Unchanged
        );
        assert_eq!(
            processing_change(true, Some(on), audio(false, false)),
            ProcessingChange::Rebuild
        );
        assert_eq!(
            processing_change(true, Some(on), audio(true, true)),
            ProcessingChange::Reroute
        );
        assert_eq!(
            processing_change(true, Some(on), audio(false, true)),
            ProcessingChange::Rebuild
        );
        assert_eq!(
            processing_change(false, None, on),
            ProcessingChange::Remember
        );
        assert_eq!(
            processing_change(false, Some(on), audio(false, false)),
            ProcessingChange::Remember
        );
    }
}
