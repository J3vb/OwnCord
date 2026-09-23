//! One native LiveKit room: connect over the loopback proxy URL, E2EE with the
//! room key the TypeScript key exchange hands over, microphone publish and
//! remote playout through libwebrtc's audio device module (ADM), camera
//! publish and remote video through the session's frame socket
//! (`video.rs`), screen share (`screen.rs`), and a stream of room events for
//! the webview. No Tauri types here so the interop example
//! (`examples/native_voice_interop.rs`) drives exactly the code the app runs.
use std::sync::{Arc, Mutex};

use livekit::e2ee::EncryptionType;
use livekit::e2ee::{key_provider::KeyProvider, key_provider::KeyProviderOptions, E2eeOptions};
use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::prelude::*;
use livekit::rtc_engine::lk_runtime::LkRuntime;
use livekit::webrtc::audio_source::RtcAudioSource;
use livekit::webrtc::native::frame_cryptor::EncryptionState;
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

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
/// `audioCaptureDefaults` (libwebrtc's APM stands in for RNNoise on Linux).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOptions {
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
}

/// Rust-side resource counts for the facade's debug surface (B7-11: the
/// long-session soak cannot see native memory, so it reads these instead).
#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub rooms: usize,
    pub local_tracks: usize,
    pub adm_refs: usize,
    /// Open frame-socket connections (remote renderers, camera upload and
    /// screen preview).
    pub video_sockets: usize,
    /// Screen capture threads alive, each holding a capturer (and, on
    /// Wayland, a portal session): zero once every share is stopped.
    pub screen_captures: usize,
    /// Process thread count, the observable for rust-sdks #1408 (a leaked
    /// FrameCryptor thread per cryptor) across repeated joins.
    pub threads: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// The device name: the Linux device modules leave the GUID empty.
    pub id: String,
    pub name: String,
    /// The device module's index, what a switch selects by.
    #[serde(skip)]
    pub index: u16,
}

/// The platform's capture and playout devices, in the device module's order
/// (the first entry is what it uses by default).
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

fn devices_of(audio: &PlatformAudio) -> Devices {
    Devices {
        inputs: audio
            .recording_devices()
            .map(|d| DeviceInfo {
                id: d.name.clone(),
                name: d.name,
                index: d.index as u16,
            })
            .collect(),
        outputs: audio
            .playout_devices()
            .map(|d| DeviceInfo {
                id: d.name.clone(),
                name: d.name,
                index: d.index as u16,
            })
            .collect(),
    }
}

/// The index to switch to: the first device whose id is `requested`,
/// otherwise the module's default (the first listed), flagged as a fallback
/// unless the default was what was asked for (an empty id). `None` when
/// nothing is listed.
fn resolve_device(requested: &str, listed: &[DeviceInfo]) -> (Option<u16>, bool) {
    match listed.iter().find(|d| d.id == requested) {
        Some(d) => (Some(d.index), false),
        None => (listed.first().map(|d| d.index), !requested.is_empty()),
    }
}

/// A selected device: its name (empty: the default) and the device-module
/// index last applied for it, which a hot-plug can shift.
#[derive(Default)]
struct Selection {
    name: String,
    index: Option<u16>,
}

/// Select device `index` the way `PlatformAudio`'s hot-swap does (stop,
/// select, re-init and restart a stream that was running), but by index. The
/// stream is restarted even when the selection fails, and left untouched when
/// `index` is the one already `applied`.
fn switch_stream(
    applied: Option<u16>,
    index: u16,
    running: bool,
    stop: impl Fn() -> bool,
    select: impl Fn() -> bool,
    init: impl Fn() -> bool,
    start: impl Fn() -> bool,
) -> Result<(), String> {
    if applied == Some(index) {
        return Ok(());
    }
    if running && !stop() {
        return Err("stopping the audio stream failed".into());
    }
    let selected = select();
    if running && !(init() && start()) {
        return Err("restarting the audio stream failed".into());
    }
    if !selected {
        return Err("selecting the audio device failed".into());
    }
    Ok(())
}

/// Enumerate with a device module that lives only for the call (no session).
pub fn list_devices_transient() -> Result<Devices, String> {
    let audio = PlatformAudio::new().map_err(|e| e.to_string())?;
    Ok(devices_of(&audio))
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
/// effective frame rate).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenOptions {
    pub width: u32,
    pub height: u32,
    pub max_bitrate: u64,
    pub max_framerate: f64,
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
}

impl VideoPublication {
    fn new(sid: TrackSid) -> Self {
        Self {
            issued: sid.to_string(),
            live: sid,
        }
    }

    fn republished(&mut self, previous: &TrackSid, sid: TrackSid) {
        if self.live == *previous {
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

pub struct NativeSession {
    room: Room,
    key_provider: KeyProvider,
    audio: Option<PlatformAudio>,
    mic: Option<LocalTrackPublication>,
    camera: VideoSlot,
    screen: Option<ScreenShare>,
    screen_publication: VideoSlot,
    next_capture: u64,
    on_event: EventSink,
    frames: FrameServer,
    input: Selection,
    output: Selection,
    forwarder: tokio::task::JoinHandle<()>,
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
        let forwarder = tokio::spawn(forward_events(
            events,
            on_event.clone(),
            frames.observer(),
            [camera.clone(), screen_publication.clone()],
        ));
        Ok(Self {
            room,
            key_provider,
            audio: None,
            mic: None,
            camera,
            screen: None,
            screen_publication,
            next_capture: 0,
            on_event,
            frames,
            input: Selection::default(),
            output: Selection::default(),
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

    /// The frame socket's base URL, token included: only the webview (via
    /// the connect result) and the interop example may see it.
    pub fn frames_url(&self) -> &str {
        self.frames.url()
    }

    pub fn local_identity(&self) -> String {
        self.room.local_participant().identity().to_string()
    }

    /// Bring up the platform ADM: remote audio only plays out while one
    /// exists, so the app calls this right after connect, independent of
    /// whether the microphone is ever published.
    pub fn enable_platform_audio(&mut self, opts: AudioOptions) -> Result<(), String> {
        if self.audio.is_some() {
            return Ok(());
        }
        let audio = PlatformAudio::new().map_err(|e| e.to_string())?;
        audio
            .configure_audio_processing(AudioProcessingOptions {
                echo_cancellation: opts.echo_cancellation,
                noise_suppression: opts.noise_suppression,
                auto_gain_control: opts.auto_gain_control,
                ..Default::default()
            })
            .map_err(|e| e.to_string())?;
        self.audio = Some(audio);
        Ok(())
    }

    /// Enable or disable the microphone. The first enable publishes; after
    /// that the publication stays and is muted in place (no renegotiation, no
    /// new frame cryptor — rust-sdks #1408), and the OS capture is stopped
    /// while muted so the system's in-use indicator goes out — the same
    /// contract as `stopMicTrackOnMute` on the web path.
    pub async fn set_microphone(&mut self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.reselect(DeviceKind::Input);
        }
        let Some(publication) = &self.mic else {
            if !enabled {
                return Ok(());
            }
            let source = self
                .audio
                .as_ref()
                .ok_or("no audio device module — platform audio unavailable")?
                .rtc_source();
            return self.publish_audio(source).await;
        };
        if enabled {
            if let Some(audio) = &self.audio {
                audio.start_recording().map_err(|e| e.to_string())?;
            }
            publication.unmute();
        } else {
            publication.mute();
            if let Some(audio) = &self.audio {
                if let Err(e) = audio.stop_recording() {
                    log::warn!("[native_voice] stop_recording failed: {e}");
                }
            }
        }
        Ok(())
    }

    /// Point a stopped capture or playout stream at the selected device's
    /// current index before it starts again.
    fn reselect(&mut self, kind: DeviceKind) {
        let Some(audio) = &self.audio else { return };
        let runtime = LkRuntime::instance();
        let f = runtime.pc_factory();
        let listed = devices_of(audio);
        let (running, selection, devices, what) = match kind {
            DeviceKind::Input => (
                f.recording_is_initialized(),
                &mut self.input,
                listed.inputs,
                "capture",
            ),
            DeviceKind::Output => (
                f.playout_is_initialized(),
                &mut self.output,
                listed.outputs,
                "playout",
            ),
        };
        if running {
            return;
        }
        let (index, fell_back) = resolve_device(&selection.name, &devices);
        if fell_back {
            log::warn!(
                "[native_voice] {what} device {} not found; using the default",
                selection.name
            );
        }
        let Some(index) = index else { return };
        let selected = match kind {
            DeviceKind::Input => f.set_recording_device(index),
            DeviceKind::Output => f.set_playout_device(index),
        };
        selection.index = selected.then_some(index);
        if !selected {
            log::warn!("[native_voice] selecting {what} device {index} failed");
        }
    }

    /// Publish any audio source as the microphone track. The app passes the
    /// ADM source; the interop example passes a synthetic sine.
    pub async fn publish_audio(&mut self, source: RtcAudioSource) -> Result<(), String> {
        let track = LocalAudioTrack::create_audio_track("microphone", source);
        let publication = self
            .room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        self.mic = Some(publication);
        Ok(())
    }

    /// Publish the camera. Its frames arrive on the frame socket's `camera`
    /// route (the webview's `getUserMedia` track, uploaded by
    /// `cameraUplink.ts`); E2EE covers the track exactly as it covers the
    /// microphone, through the room's one key provider. A camera already
    /// published is replaced. Returns the publication's sid, which
    /// [`Self::unpublish_camera`] takes.
    pub async fn publish_camera(&mut self, opts: CameraOptions) -> Result<String, String> {
        self.release_camera().await;
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
            .publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Camera,
                    simulcast: opts.simulcast,
                    video_encoding: Some(VideoEncoding {
                        max_bitrate: opts.max_bitrate,
                        max_framerate: opts.max_framerate,
                    }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        let sid = publication.sid();
        self.frames.set_camera(Some(source));
        *self.camera.lock().unwrap() = Some(VideoPublication::new(sid.clone()));
        Ok(sid.to_string())
    }

    /// Unpublish camera `sid` (the web path unpublishes rather than mutes, so
    /// remote tiles close the same way). A stale sid, one a later publish
    /// already replaced, is a no-op: it must not remove the newer camera.
    pub async fn unpublish_camera(&mut self, sid: &str) {
        let issued = self
            .camera
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.issued == sid);
        if issued {
            self.release_camera().await;
        }
    }

    /// Unpublish whatever camera is published. The upload socket ends with it.
    async fn release_camera(&mut self) {
        self.frames.set_camera(None);
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

    /// Start capturing `target` for a screen share, replacing any capture
    /// already running. Returns the capture's id and a receiver that resolves
    /// with the first frame's size — on Wayland only once the user has
    /// completed the portal's dialog — or with why capture never began
    /// ([`screen::CANCELLED`] for a cancelled dialog). The caller awaits it
    /// without holding the session, so a leave or a stop is never blocked
    /// behind the dialog: either drops the capture, which resolves it.
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
            .publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    simulcast: false,
                    video_encoding: Some(VideoEncoding {
                        max_bitrate: opts.max_bitrate,
                        max_framerate: opts.max_framerate,
                    }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        let sid = publication.sid();
        if let Some(screen) = &self.screen {
            screen.capture.set_source(Some(source));
        }
        *self.screen_publication.lock().unwrap() = Some(VideoPublication::new(sid.clone()));
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
        self.unpublish_screen().await;
        self.frames.set_screen(None);
        // Dropping joins the capture thread.
        self.screen.take();
    }

    /// Deafen support: (un)subscribe one remote publication.
    pub fn set_subscribed(
        &mut self,
        identity: &str,
        sid: &str,
        subscribed: bool,
    ) -> Result<(), String> {
        let participants = self.room.remote_participants();
        let participant = participants
            .get(&ParticipantIdentity::from(identity.to_string()))
            .ok_or_else(|| format!("unknown participant {identity}"))?;
        let track_sid =
            TrackSid::try_from(sid.to_string()).map_err(|_| format!("bad track sid {sid}"))?;
        let publication = participant
            .get_track_publication(&track_sid)
            .ok_or_else(|| format!("unknown track {sid}"))?;
        if subscribed {
            self.reselect(DeviceKind::Output);
        }
        publication.set_subscribed(subscribed);
        Ok(())
    }

    pub fn devices(&self) -> Result<Devices, String> {
        self.audio
            .as_ref()
            .map(devices_of)
            .ok_or_else(|| "no audio device module — platform audio unavailable".to_string())
    }

    /// Switch the capture or playout device in place (the module restarts
    /// the stream if it is running). An empty id selects the module's
    /// default, its first enumerated device.
    pub fn set_device(&mut self, kind: &str, device_id: &str) -> Result<(), String> {
        let kind = DeviceKind::parse(kind)?;
        let audio = self
            .audio
            .as_ref()
            .ok_or("no audio device module — platform audio unavailable")?;
        let listed = devices_of(audio);
        let (devices, what, selection) = match kind {
            DeviceKind::Input => (listed.inputs, "capture", &mut self.input),
            DeviceKind::Output => (listed.outputs, "playout", &mut self.output),
        };
        let (index, fell_back) = resolve_device(device_id, &devices);
        let index = index.ok_or(format!("no {what} device"))?;
        // PlatformAudio only switches by GUID, which is empty on Linux; the
        // runtime its device module lives in exposes the index-based calls.
        let runtime = LkRuntime::instance();
        let f = runtime.pc_factory();
        let applied = selection.index;
        let switched = match kind {
            DeviceKind::Input => switch_stream(
                applied,
                index,
                f.recording_is_initialized(),
                || f.stop_recording(),
                || f.set_recording_device(index),
                || f.init_recording(),
                || f.start_recording(),
            ),
            DeviceKind::Output => switch_stream(
                applied,
                index,
                f.playout_is_initialized(),
                || f.stop_playout(),
                || f.set_playout_device(index),
                || f.init_playout(),
                || f.start_playout(),
            ),
        };
        selection.index = switched.is_ok().then_some(index);
        switched?;
        selection.name = if fell_back {
            String::new()
        } else {
            device_id.to_string()
        };
        if fell_back {
            return Err(format!(
                "{what} device {device_id} not found; switched to the default"
            ));
        }
        Ok(())
    }

    pub fn resources(&self) -> Resources {
        Resources {
            rooms: 1,
            local_tracks: usize::from(self.mic.is_some())
                + usize::from(self.camera.lock().unwrap().is_some())
                + usize::from(self.screen_publication.lock().unwrap().is_some()),
            adm_refs: self.audio.as_ref().map_or(0, PlatformAudio::ref_count),
            video_sockets: self.frames.sockets(),
            screen_captures: screen::active_captures(),
            threads: process_threads(),
        }
    }

    /// Leave the room and release every native handle. Dropping the last
    /// `PlatformAudio` disables the ADM; dropping the frame server closes
    /// its listener and every frame socket.
    pub async fn close(mut self) {
        self.release_camera().await;
        self.release_screen().await;
        if let Some(publication) = self.mic.take() {
            let _ = self
                .room
                .local_participant()
                .unpublish_track(&publication.sid())
                .await;
        }
        if let Err(e) = self.room.close().await {
            log::warn!("[native_voice] room close: {e}");
        }
        self.forwarder.abort();
        self.audio.take();
    }
}

async fn forward_events(
    mut events: UnboundedReceiver<RoomEvent>,
    on_event: EventSink,
    frames: Observer,
    published: [VideoSlot; 2],
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
        // Before the webview hears of a video track, so its frame socket
        // finds it.
        frames.observe(&ev);
        if let Some(mapped) = map_event(ev) {
            on_event(mapped);
        }
    }
}

/// A video slot's (camera or screen share) response to a local track's
/// `LocalTrackRepublished`: adopt the new sid when the event continues the
/// slot's live publication, or return the sid to unpublish when it does not —
/// the video was stopped (slot emptied) or a newer one replaced it while the
/// SDK was between its unpublish and publish, leaving a publication nobody can
/// drive. A non-video republish returns `None`: the microphone is tracked by
/// `NativeSession` itself, not here.
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
    fn a_failed_selection_still_restarts_the_running_stream() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        let step = |name: &'static str, ok: bool| {
            let calls = &calls;
            move || {
                calls.borrow_mut().push(name);
                ok
            }
        };
        let result = switch_stream(
            None,
            2,
            true,
            step("stop", true),
            step("select", false),
            step("init", true),
            step("start", true),
        );
        assert!(result.is_err());
        assert_eq!(*calls.borrow(), ["stop", "select", "init", "start"]);

        calls.borrow_mut().clear();
        let result = switch_stream(
            None,
            2,
            false,
            step("stop", true),
            step("select", true),
            step("init", true),
            step("start", true),
        );
        assert!(result.is_ok());
        assert_eq!(*calls.borrow(), ["select"]);
    }

    #[test]
    fn an_unchanged_index_leaves_the_running_stream_alone() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        let step = |name: &'static str| {
            let calls = &calls;
            move || {
                calls.borrow_mut().push(name);
                true
            }
        };
        let result = switch_stream(
            Some(2),
            2,
            true,
            step("stop"),
            step("select"),
            step("init"),
            step("start"),
        );
        assert!(result.is_ok());
        assert!(calls.borrow().is_empty());

        let result = switch_stream(
            Some(3),
            2,
            true,
            step("stop"),
            step("select"),
            step("init"),
            step("start"),
        );
        assert!(result.is_ok());
        assert_eq!(*calls.borrow(), ["stop", "select", "init", "start"]);
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
