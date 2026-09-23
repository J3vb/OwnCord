//! One native LiveKit room: connect over the loopback proxy URL, E2EE with the
//! room key the TypeScript key exchange hands over, microphone capture and
//! processing through our own input stream (`capture.rs`, for RNNoise),
//! remote playout through our own mixer (`playout.rs`, for per-user
//! volume), camera
//! publish and remote video through the session's frame socket
//! (`video.rs`), and a stream of room events for the webview. No Tauri types here so the interop example
//! (`examples/native_voice_interop.rs`) drives exactly the code the app runs.
use std::sync::{Arc, Mutex};

use livekit::e2ee::EncryptionType;
use livekit::e2ee::{key_provider::KeyProvider, key_provider::KeyProviderOptions, E2eeOptions};
use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::native::frame_cryptor::EncryptionState;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

use super::capture::{self, Apm, Capture};
use super::playout::{self, Playout};
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
    /// Open frame-socket connections (remote renderers plus camera upload).
    pub video_sockets: usize,
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

/// The published camera. `issued` is the sid the webview was handed and must
/// name to unpublish; `live` follows the SDK's republish after a full
/// reconnect, which re-issues the sid of the same track.
struct CameraPublication {
    issued: String,
    live: TrackSid,
}

impl CameraPublication {
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

type CameraSlot = Arc<Mutex<Option<CameraPublication>>>;

pub struct NativeSession {
    room: Room,
    key_provider: KeyProvider,
    /// Set by `enable_audio`: the processing capture and playout share.
    apm: Option<Arc<Apm>>,
    mic: Option<LocalTrackPublication>,
    /// The published microphone's source, fed by `capture` (none when the
    /// interop example published a synthetic one).
    mic_source: Option<NativeAudioSource>,
    camera: CameraSlot,
    frames: FrameServer,
    playout: Playout,
    capture: Capture,
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
        let camera = CameraSlot::default();
        let playout = Playout::default();
        let forwarder = tokio::spawn(forward_events(
            events,
            on_event,
            frames.observer(),
            playout.listener(),
            camera.clone(),
        ));
        Ok(Self {
            room,
            key_provider,
            apm: None,
            mic: None,
            mic_source: None,
            camera,
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
        self.capture
            .configure(apm.clone(), opts.enhanced_noise_suppression);
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
    pub async fn set_microphone(&mut self, enabled: bool) -> Result<(), String> {
        let Some(publication) = &self.mic else {
            if !enabled {
                return Ok(());
            }
            // Unbuffered (queue 0): the capture callback hands over whole
            // 10 ms frames and never waits.
            let source =
                NativeAudioSource::new(AudioSourceOptions::default(), capture::SAMPLE_RATE, 1, 0);
            self.capture.start(source.clone())?;
            self.mic_source = Some(source.clone());
            let published = self.publish_audio(RtcAudioSource::Native(source)).await;
            if published.is_err() {
                self.capture.stop();
                self.mic_source = None;
            }
            return published;
        };
        if enabled {
            // The interop example publishes its own source and captures nothing.
            if let Some(source) = &self.mic_source {
                self.capture.start(source.clone())?;
            }
            publication.unmute();
        } else {
            publication.mute();
            self.capture.stop();
        }
        Ok(())
    }

    /// Publish any audio source as the microphone track. The app passes its
    /// capture's source; the interop example passes a synthetic sine.
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
        *self.camera.lock().unwrap() = Some(CameraPublication::new(sid.clone()));
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
        publication.set_subscribed(subscribed);
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
                + usize::from(self.camera.lock().unwrap().is_some()),
            capture_streams: self.capture.streams(),
            audio_streams: self.playout.readers(),
            video_sockets: self.frames.sockets(),
            threads: process_threads(),
        }
    }

    /// Leave the room and release every native handle: the capture and
    /// playout streams close with the session, and dropping the frame server
    /// closes its listener and every frame socket.
    pub async fn close(mut self) {
        self.capture.stop();
        self.release_camera().await;
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
    }
}

async fn forward_events(
    mut events: UnboundedReceiver<RoomEvent>,
    on_event: EventSink,
    frames: Observer,
    playout: playout::Listener,
    camera: CameraSlot,
) {
    while let Some(ev) = events.recv().await {
        if let RoomEvent::LocalTrackRepublished {
            previous_sid,
            publication,
            participant,
            ..
        } = &ev
        {
            let orphan = {
                let mut slot = camera.lock().unwrap();
                apply_republish(
                    &mut slot,
                    publication.source(),
                    previous_sid,
                    &publication.sid(),
                )
            };
            if let Some(sid) = orphan {
                // The camera was disabled (slot emptied) or replaced while the
                // SDK was between its unpublish and publish during a full
                // reconnect: this fresh publication (a new sid) found nothing
                // to attach to, so no frames are driven for it and the webview
                // already considers the camera off. Unpublish it, or it lingers
                // beside the next camera.
                let participant = participant.clone();
                tokio::spawn(async move {
                    if let Err(e) = participant.unpublish_track(&sid).await {
                        log::warn!("[native_voice] orphan camera unpublish: {e}");
                    }
                });
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

/// The camera slot's response to a local track's `LocalTrackRepublished`:
/// adopt the new sid when the event continues the slot's live camera, or
/// return the sid to unpublish when it does not — the camera was disabled
/// (slot emptied) or a newer one replaced it while the SDK was between its
/// unpublish and publish, leaving a publication nobody can drive. A non-camera
/// republish returns `None`: the microphone is tracked by `NativeSession`
/// itself, not here.
fn apply_republish(
    camera: &mut Option<CameraPublication>,
    source: TrackSource,
    previous_sid: &TrackSid,
    sid: &TrackSid,
) -> Option<TrackSid> {
    if source != TrackSource::Camera {
        return None;
    }
    match camera.as_mut() {
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
    fn camera_unpublish_follows_its_republished_sid() {
        let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
        let mut camera = CameraPublication::new(sid("TR_a"));
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
        let mut slot = Some(CameraPublication::new(sid("TR_a")));
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
        let mut slot = Some(CameraPublication::new(sid("TR_c")));
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
        let mut slot = Some(CameraPublication::new(sid("TR_new")));
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
