//! The publish options of each local track, from the same presets the web
//! path hands `publishTrack`.

use super::*;
use livekit::options::{
    AudioEncoding, DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoding,
    VideoPreset,
};

/// The video codec a publish asks for. VP8 is the default and what
/// a webview that sends no `codec` gets; H.264 is sent only when
/// `native_voice_video_codecs` says the engine can encode it; so is VP9,
/// which goes out as one SVC layer and never simulcast.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PublishCodec {
    #[default]
    Vp8,
    H264,
    Vp9,
}

impl PublishCodec {
    pub(super) fn video_codec(self) -> VideoCodec {
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
    pub(super) fn svc(self) -> Option<String> {
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
/// the budget. Like the web path's `screenShareDegradation`, every rate keeps
/// its frame rate and gives up resolution when the encoder or link falls
/// behind.
pub(super) fn screen_publish_options(opts: &ScreenOptions) -> TrackPublishOptions {
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
        // Smooth motion first: a slow link softens or shrinks the picture
        // instead of dropping it to a few frames a second.
        degradation_preference: Some(DegradationPreference::MaintainFramerate),
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
pub(super) fn camera_publish_options(opts: &CameraOptions) -> TrackPublishOptions {
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
/// `stereo` is the flag of the vendored livekit crate
/// (`vendor/livekit/OWNCORD-PATCH.md`): it makes the SFU's publisher answer
/// carry `stereo=1`, so the encoder is built with two channels instead of
/// downmixing the share to mono. The mic, camera and screen video options
/// leave it off.
pub(super) fn screen_audio_publish_options() -> TrackPublishOptions {
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

/// The microphone's publish options: the channel's configured bitrate
/// (`voice_config`, the web path's `audioPreset`), or the SDK's own default
/// (48 kbps) when no config reached the client.
pub(super) fn mic_publish_options(bitrate: Option<u64>) -> TrackPublishOptions {
    TrackPublishOptions {
        source: TrackSource::Microphone,
        audio_encoding: bitrate.map(|max_bitrate| AudioEncoding { max_bitrate }),
        ..Default::default()
    }
}
