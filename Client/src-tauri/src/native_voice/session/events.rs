//! The room events the webview reads: their wire shapes, the mapping from the
//! SDK's `RoomEvent`, and the task that forwards them.

use super::*;
use crate::native_voice::video::Observer;
use livekit::webrtc::native::frame_cryptor::EncryptionState;

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

pub(super) fn track_info(
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
pub(super) fn is_encrypted(encryption: EncryptionType) -> bool {
    encryption != EncryptionType::None
}

pub(super) fn remote_pub_info(p: &RemoteTrackPublication) -> TrackInfo {
    track_info(
        p.sid().to_string(),
        p.kind(),
        p.source(),
        p.is_muted(),
        p.encryption_type(),
    )
}

pub(super) fn participant_info(
    p: &RemoteParticipant,
    tracks: &[RemoteTrackPublication],
) -> ParticipantInfo {
    ParticipantInfo {
        identity: p.identity().to_string(),
        tracks: tracks.iter().map(remote_pub_info).collect(),
    }
}

/// Map an SDK room event onto the webview vocabulary; `None` drops it.
pub(super) fn map_event(ev: RoomEvent) -> Option<Event> {
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

pub(super) async fn forward_events(
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
                apply_republish(&mut lock(slot), source, previous_sid, &publication.sid())
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
                    TrackSource::Camera => release_slot(&mut lock(&published[0]), &sid)
                        .map(|capture| Event::CameraCaptureEnded { capture }),
                    TrackSource::Screenshare => release_slot(&mut lock(&published[1]), &sid)
                        .map(|capture| Event::ScreenCaptureEnded { capture }),
                    // The share ends the way a stopped capture does; the
                    // webview's stop releases the capture thread.
                    TrackSource::ScreenshareAudio => release_slot(&mut lock(&published[2]), &sid)
                        .map(|capture| Event::ScreenCaptureEnded { capture }),
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
pub(super) async fn withdraw_unencrypted(
    participant: &LocalParticipant,
    publication: &LocalTrackPublication,
) {
    if let Some(track) = publication.track() {
        track.disable();
    }
    if let Err(e) = participant.unpublish_track(&publication.sid()).await {
        log::warn!("[native_voice] unencrypted publication unpublish: {e}");
    }
    log::error!("[native_voice] the media server did not accept end-to-end encryption for a track");
}

pub(super) fn permission_event(permission: &livekit_protocol::ParticipantPermission) -> Event {
    Event::Permission {
        can_publish: permission.can_publish,
        can_publish_sources: permission.can_publish_sources.clone(),
    }
}

/// Whether the server's grant lets this participant publish the microphone:
/// an empty source list means every source (LiveKit's rule).
pub(super) fn mic_allowed(permission: &livekit_protocol::ParticipantPermission) -> bool {
    permission.can_publish
        && (permission.can_publish_sources.is_empty()
            || permission
                .can_publish_sources
                .contains(&(livekit_protocol::TrackSource::Microphone as i32)))
}
