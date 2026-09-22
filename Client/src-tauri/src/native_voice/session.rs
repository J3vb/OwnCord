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
use livekit::webrtc::audio_source::RtcAudioSource;
use livekit::webrtc::native::frame_cryptor::EncryptionState;
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
    mic: Option<TrackSid>,
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

    /// Publish (or unpublish) the microphone. Mute unpublishes and stops the
    /// OS capture, so the system's in-use indicator goes out — the same
    /// contract as `stopMicTrackOnMute` on the web path.
    pub async fn set_microphone(&mut self, enabled: bool) -> Result<(), String> {
        if enabled {
            if self.mic.is_some() {
                return Ok(());
            }
            let source = self
                .audio
                .as_ref()
                .ok_or("no audio device module — platform audio unavailable")?
                .rtc_source();
            self.publish_audio(source).await
        } else {
            let Some(sid) = self.mic.take() else {
                return Ok(());
            };
            self.room
                .local_participant()
                .unpublish_track(&sid)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(audio) = &self.audio {
                if let Err(e) = audio.stop_recording() {
                    log::warn!("[native_voice] stop_recording failed: {e}");
                }
            }
            Ok(())
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
        self.mic = Some(publication.sid());
        Ok(())
    }

    /// Deafen support: (un)subscribe one remote publication.
    pub fn set_subscribed(
        &self,
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
        if let Some(sid) = self.mic.take() {
            let _ = self.room.local_participant().unpublish_track(&sid).await;
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
    fn process_threads_reads_procfs() {
        assert!(process_threads() >= 1);
    }
}
