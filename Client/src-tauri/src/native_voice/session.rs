//! One native LiveKit room: connect over the loopback proxy URL, E2EE with the
//! room key the TypeScript key exchange hands over, microphone publish and
//! remote playout through libwebrtc's audio device module (ADM), and a stream
//! of room events for the webview. No Tauri types here so the interop example
//! (`examples/native_voice_interop.rs`) drives exactly the code the app runs.
use std::sync::Arc;

use livekit::e2ee::EncryptionType;
use livekit::e2ee::{key_provider::KeyProvider, key_provider::KeyProviderOptions, E2eeOptions};
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::rtc_engine::lk_runtime::LkRuntime;
use livekit::webrtc::audio_source::RtcAudioSource;
use livekit::webrtc::native::frame_cryptor::EncryptionState;
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

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

pub struct NativeSession {
    room: Room,
    key_provider: KeyProvider,
    audio: Option<PlatformAudio>,
    mic: Option<LocalTrackPublication>,
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
        let (room, events) = Room::connect(url, token, options)
            .await
            .map_err(|e| e.to_string())?;
        room.e2ee_manager().set_enabled(true);
        let forwarder = tokio::spawn(forward_events(events, on_event));
        Ok(Self {
            room,
            key_provider,
            audio: None,
            mic: None,
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
            local_tracks: usize::from(self.mic.is_some()),
            adm_refs: self.audio.as_ref().map_or(0, PlatformAudio::ref_count),
            threads: process_threads(),
        }
    }

    /// Leave the room and release every native handle. Dropping the last
    /// `PlatformAudio` disables the ADM.
    pub async fn close(mut self) {
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

async fn forward_events(mut events: UnboundedReceiver<RoomEvent>, on_event: EventSink) {
    while let Some(ev) = events.recv().await {
        if let Some(mapped) = map_event(ev) {
            on_event(mapped);
        }
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
    fn process_threads_reads_procfs() {
        assert!(process_threads() >= 1);
    }
}
