// Copyright 2025 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::sync::Arc;

use libwebrtc::enum_dispatch;
use livekit_protocol::{self as proto, AudioTrackFeature, PacketTrailerFeature};
use parking_lot::{Mutex, RwLock};

use super::track::TrackDimension;
use crate::{e2ee::EncryptionType, prelude::*, track::Track};

mod local;
mod remote;

pub use local::*;
pub use remote::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionStatus {
    Desired,
    Subscribed,
    Unsubscribed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionStatus {
    Allowed,
    NotAllowed,
}

#[derive(Clone, Debug)]
pub enum TrackPublication {
    Local(LocalTrackPublication),
    Remote(RemoteTrackPublication),
}

impl TrackPublication {
    enum_dispatch!(
        [Local, Remote];
        pub fn sid(self: &Self) -> TrackSid;
        pub fn name(self: &Self) -> String;
        pub fn kind(self: &Self) -> TrackKind;
        pub fn source(self: &Self) -> TrackSource;
        pub fn simulcasted(self: &Self) -> bool;
        pub fn dimension(self: &Self) -> TrackDimension;
        pub fn mime_type(self: &Self) -> String;
        pub fn is_muted(self: &Self) -> bool;
        pub fn is_remote(self: &Self) -> bool;
        pub fn encryption_type(self: &Self) -> EncryptionType;
        pub fn audio_features(self: &Self) -> Vec<AudioTrackFeature>;
        pub fn frame_metadata_features(self: &Self) -> Vec<PacketTrailerFeature>;

        pub(crate) fn on_muted(self: &Self, on_mute: impl Fn(TrackPublication) + Send + 'static) -> ();
        pub(crate) fn on_unmuted(self: &Self, on_unmute: impl Fn(TrackPublication) + Send + 'static) -> ();
        pub(crate) fn proto_info(self: &Self) -> proto::TrackInfo;
        pub(crate) fn update_info(self: &Self, info: proto::TrackInfo) -> ();
    );

    #[allow(dead_code)]
    pub(crate) fn set_track(&self, track: Option<Track>) {
        match self {
            TrackPublication::Local(p) => p.set_track(track),
            TrackPublication::Remote(p) => p.set_track(track.map(|t| t.try_into().unwrap())),
        }
    }

    pub fn track(&self) -> Option<Track> {
        match self {
            TrackPublication::Local(p) => p.track().map(Into::into),
            TrackPublication::Remote(p) => p.track().map(Into::into),
        }
    }
}

struct PublicationInfo {
    pub track: Option<Track>,
    pub name: String,
    pub sid: TrackSid,
    pub kind: TrackKind,
    pub source: TrackSource,
    pub simulcasted: bool,
    pub dimension: TrackDimension,
    pub mime_type: String,
    pub muted: bool,
    pub proto_info: proto::TrackInfo,
    pub encryption_type: EncryptionType,
    pub audio_features: Vec<AudioTrackFeature>,
    pub frame_metadata_features: Vec<PacketTrailerFeature>,
}

pub(crate) type MutedHandler = Box<dyn Fn(TrackPublication) + Send>;
pub(crate) type UnmutedHandler = Box<dyn Fn(TrackPublication) + Send>;

#[derive(Default)]
struct PublicationEvents {
    muted: Mutex<Option<MutedHandler>>,
    unmuted: Mutex<Option<UnmutedHandler>>,
}

pub(super) struct TrackPublicationInner {
    info: RwLock<PublicationInfo>,
    events: Arc<PublicationEvents>,
}

/// Returns whether a `TrackInfo` represents a simulcasted publication.
///
/// `TrackInfo.simulcast` and `TrackInfo.layers` are deprecated and modern
/// LiveKit servers no longer populate them; the authoritative source is
/// `TrackInfo.codecs[*].layers`. We still consult the deprecated fields so
/// older servers continue to work.
fn is_simulcasted(info: &proto::TrackInfo) -> bool {
    info.simulcast || info.layers.len() > 1 || info.codecs.iter().any(|c| c.layers.len() > 1)
}

// OWNCORD-PATCH (signal input): the sid and kind of a track entry, or why the
// entry is unusable (a sid without the track prefix, or a type the SDK does not
// implement). Callers skip such an entry instead of unwrapping it.
pub(crate) fn checked_track_ids(info: &proto::TrackInfo) -> Result<(TrackSid, TrackKind), String> {
    let kind = TrackKind::try_from(info.r#type())
        .map_err(|reason| format!("track {:?} has an unsupported type: {}", info.sid, reason))?;
    let sid = TrackSid::try_from(info.sid.clone())
        .map_err(|sid| format!("track entry with invalid sid: {:?}", sid))?;
    Ok((sid, kind))
}

// OWNCORD-PATCH (signal input): fails on an unusable entry instead of unwrapping.
pub(super) fn new_inner(
    info: proto::TrackInfo,
    track: Option<Track>,
) -> Result<Arc<TrackPublicationInner>, String> {
    let (sid, kind) = checked_track_ids(&info)?;
    let info = PublicationInfo {
        track,
        simulcasted: is_simulcasted(&info),
        proto_info: info.clone(),
        source: info.source().into(),
        kind,
        encryption_type: info.encryption().into(),
        name: info.clone().name,
        sid,
        dimension: TrackDimension(info.width, info.height),
        mime_type: info.mime_type.clone(),
        muted: info.muted,
        audio_features: info
            .audio_features()
            .into_iter()
            .map(|item| item.try_into().unwrap())
            .collect(),
        frame_metadata_features: info
            .packet_trailer_features
            .iter()
            .filter_map(|v| PacketTrailerFeature::try_from(*v).ok())
            .collect(),
    };

    Ok(Arc::new(TrackPublicationInner { info: RwLock::new(info), events: Default::default() }))
}

pub(super) fn update_info(
    inner: &TrackPublicationInner,
    _publication: &TrackPublication,
    new_info: proto::TrackInfo,
) {
    // OWNCORD-PATCH (signal input): an unusable update is skipped.
    let (sid, kind) = match checked_track_ids(&new_info) {
        Ok(ids) => ids,
        Err(reason) => {
            log::warn!("ignoring publication update: {}", reason);
            return;
        }
    };
    let mut info = inner.info.write();
    info.kind = kind;
    info.source = TrackSource::from(new_info.source());
    info.encryption_type = new_info.encryption().into();
    info.proto_info = new_info.clone();
    info.name = new_info.name.clone();
    info.sid = sid;
    info.dimension = TrackDimension(new_info.width, new_info.height);
    info.mime_type = new_info.mime_type.clone();
    info.simulcasted = is_simulcasted(&new_info);
    info.audio_features = new_info.audio_features().collect();
    info.frame_metadata_features = new_info
        .packet_trailer_features
        .iter()
        .filter_map(|v| PacketTrailerFeature::try_from(*v).ok())
        .collect();
}

pub(super) fn set_track(
    inner: &TrackPublicationInner,
    publication: &TrackPublication,
    track: Option<Track>,
) {
    let mut info = inner.info.write();
    if let Some(prev_track) = info.track.as_ref() {
        prev_track.on_muted(|_| {});
        prev_track.on_unmuted(|_| {});
    }

    info.track = track.clone();

    if let Some(track) = track.as_ref() {
        info.sid = track.sid();

        track.on_muted({
            let events = inner.events.clone();
            let publication = publication.clone();
            move |_| {
                if let Some(on_muted) = events.muted.lock().as_ref() {
                    on_muted(publication.clone());
                }
            }
        });

        track.on_unmuted({
            let events = inner.events.clone();
            let publication = publication.clone();
            move |_| {
                if let Some(on_unmuted) = events.unmuted.lock().as_ref() {
                    on_unmuted(publication.clone());
                }
            }
        });
    }
}

// OWNCORD-PATCH (signal input)
#[cfg(test)]
mod signal_input_tests {
    use super::*;

    fn track_entry(sid: &str, kind: proto::TrackType) -> proto::TrackInfo {
        proto::TrackInfo { sid: sid.to_string(), r#type: kind as i32, ..Default::default() }
    }

    #[test]
    fn a_track_entry_needs_a_track_sid_and_a_supported_type() {
        let (sid, kind) = checked_track_ids(&track_entry("TR_ok", proto::TrackType::Video))
            .expect("usable entry");
        assert_eq!(sid.as_str(), "TR_ok");
        assert_eq!(kind, TrackKind::Video);

        assert!(checked_track_ids(&track_entry("PA_not_a_track", proto::TrackType::Audio)).is_err());
        assert!(checked_track_ids(&track_entry("", proto::TrackType::Audio)).is_err());
        assert!(checked_track_ids(&track_entry("TR_data", proto::TrackType::Data)).is_err());
    }

    #[test]
    fn an_unusable_entry_builds_no_publication() {
        let bad_sid = track_entry("bad", proto::TrackType::Audio);
        assert!(RemoteTrackPublication::new(bad_sid, None, true).is_err());
        let data = track_entry("TR_data", proto::TrackType::Data);
        assert!(RemoteTrackPublication::new(data, None, true).is_err());
    }

    #[test]
    fn an_unusable_update_leaves_the_publication_as_it_was() {
        let entry = track_entry("TR_a", proto::TrackType::Audio);
        let publication = RemoteTrackPublication::new(entry, None, true).expect("usable entry");
        publication.update_info(track_entry("bad", proto::TrackType::Video));
        publication.update_info(track_entry("TR_a", proto::TrackType::Data));
        assert_eq!(publication.sid().as_str(), "TR_a");
        assert_eq!(publication.kind(), TrackKind::Audio);
    }
}
