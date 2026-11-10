//! What video codecs this build's libwebrtc can send and receive.
use serde::Serialize;

/// Which video codecs the native engine can encode beyond VP8.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCodecs {
    /// libwebrtc's sender capabilities list `video/H264`: its software
    /// encoder (OpenH264) is built in.
    pub h264: bool,
    /// libwebrtc's sender capabilities list `video/VP9`.
    pub vp9: bool,
    /// The lowercased codec subtypes (`vp8`, `h264`, `vp9`, ...) libwebrtc's
    /// receiver capabilities list, without the rtx, red and fec entries. The
    /// webview intersects it with what it can decrypt before announcing it.
    pub decode: Vec<String>,
}

/// Whether a sender-capability mime type is H.264, ignoring case.
pub(super) fn is_h264_mime(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("video/H264")
}

/// Whether a sender-capability mime type is VP9, ignoring case.
pub(super) fn is_vp9_mime(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("video/VP9")
}

/// The codec subtype of a receiver-capability mime type, lowercased, or
/// `None` for the retransmission and redundancy entries that are not codecs.
pub(super) fn decode_codec_name(mime: &str) -> Option<String> {
    let name = mime.split('/').nth(1)?.to_ascii_lowercase();
    let is_support =
        matches!(name.as_str(), "rtx" | "red" | "ulpfec") || name.starts_with("flexfec");
    if name.is_empty() || is_support {
        None
    } else {
        Some(name)
    }
}

/// The distinct decodable codec names of a receiver-capability mime list, in
/// the order libwebrtc lists them.
pub(super) fn decode_names<'a>(mimes: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in mimes.filter_map(decode_codec_name) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Ask libwebrtc which video codecs it can send. Synchronous: callers off the
/// async runtime (the interop example) use it directly.
pub fn probe_video_codecs() -> VideoCodecs {
    // Outside a call this makes `LkRuntime::instance()` build the libwebrtc
    // factory just for the probe; acceptable, as the webview asks once (memoised).
    let runtime = livekit::rtc_engine::lk_runtime::LkRuntime::instance();
    let factory = runtime.pc_factory();
    let send = factory.get_rtp_sender_capabilities(livekit::webrtc::MediaType::Video);
    let receive = factory.get_rtp_receiver_capabilities(livekit::webrtc::MediaType::Video);
    VideoCodecs {
        h264: send.codecs.iter().any(|c| is_h264_mime(&c.mime_type)),
        vp9: send.codecs.iter().any(|c| is_vp9_mime(&c.mime_type)),
        decode: decode_names(receive.codecs.iter().map(|c| c.mime_type.as_str())),
    }
}
