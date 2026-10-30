//! Connection stats for the webview: ping, quality bars, the tile
//! chip and the Go Live readout.
//!
//! libwebrtc's stats reports are large (about 60 fields per entry, plus
//! certificates and candidates). The webview's poller (`connectionStats.ts`)
//! reads a handful of W3C fields, so this module keeps only those, in the
//! W3C shape and field names, and `NativeRoom` wraps each list as a stats
//! report. The loss, jitter and bar logic stays in the poller, so it has one
//! implementation on every platform. Pure reduction, no I/O.

use std::collections::BTreeMap;

use livekit::webrtc::stats::{QualityLimitationReason, RtcStats};
use serde::Serialize;

/// One W3C-shaped entry the webview's stats poller reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Entry {
    #[serde(rename_all = "camelCase")]
    CandidatePair {
        id: String,
        /// Seconds; the webview multiplies by 1000.
        current_round_trip_time: f64,
        bytes_sent: u64,
        bytes_received: u64,
    },
    #[serde(rename_all = "camelCase")]
    OutboundRtp {
        id: String,
        kind: String,
        packets_sent: u64,
        bytes_sent: u64,
    },
    #[serde(rename_all = "camelCase")]
    InboundRtp {
        id: String,
        kind: String,
        packets_received: u64,
        bytes_received: u64,
        packets_lost: i64,
        jitter: f64,
    },
    #[serde(rename_all = "camelCase")]
    RemoteInboundRtp {
        id: String,
        kind: String,
        /// The libwebrtc id of the outbound entry this one reports on; the
        /// poller joins on it, so it is passed through unchanged.
        local_id: String,
        packets_lost: i64,
        jitter: f64,
    },
}

/// One subscribed remote video track, as `getReceiverStats` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverSample {
    pub frame_width: u32,
    pub frame_height: u32,
    pub frames_decoded: u32,
    pub bytes_received: u64,
    pub packets_lost: i64,
    pub packets_received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// One encoder layer of a local video track (`shareSenderStats.ts`'s
/// `OutboundLayer`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderLayer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_per_second: Option<f64>,
    pub frame_width: u32,
    pub frame_height: u32,
    /// "none", "cpu", "bandwidth" or "other".
    pub quality_limitation_reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_implementation: Option<String>,
    pub active: bool,
}

/// The whole reply of `native_voice_get_stats`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Wall clock (ms since the epoch) at collection; every sample in the
    /// reply shares it.
    pub at_ms: f64,
    pub publisher: Vec<Entry>,
    pub subscriber: Vec<Entry>,
    /// Subscribed remote video tracks, by publication sid (the sid the
    /// `trackSubscribed` event carried).
    pub remote_video: BTreeMap<String, ReceiverSample>,
    /// Local video by source key: "camera", "screen_share".
    pub local_video: BTreeMap<&'static str, Vec<SenderLayer>>,
}

/// Keeps only the four entry types, and in them only the fields the poller
/// reads.
pub fn transport_entries(stats: &[RtcStats]) -> Vec<Entry> {
    stats
        .iter()
        .filter_map(|s| match s {
            RtcStats::CandidatePair(c) => Some(Entry::CandidatePair {
                id: c.rtc.id.clone(),
                current_round_trip_time: c.candidate_pair.current_round_trip_time,
                bytes_sent: c.candidate_pair.bytes_sent,
                bytes_received: c.candidate_pair.bytes_received,
            }),
            RtcStats::OutboundRtp(o) => Some(Entry::OutboundRtp {
                id: o.rtc.id.clone(),
                kind: o.stream.kind.clone(),
                packets_sent: o.sent.packets_sent,
                bytes_sent: o.sent.bytes_sent,
            }),
            RtcStats::InboundRtp(i) => Some(Entry::InboundRtp {
                id: i.rtc.id.clone(),
                kind: i.stream.kind.clone(),
                packets_received: i.received.packets_received,
                bytes_received: i.inbound.bytes_received,
                packets_lost: i.received.packets_lost,
                jitter: i.received.jitter,
            }),
            RtcStats::RemoteInboundRtp(r) => Some(Entry::RemoteInboundRtp {
                id: r.rtc.id.clone(),
                kind: r.stream.kind.clone(),
                local_id: r.remote_inbound.local_id.clone(),
                packets_lost: r.received.packets_lost,
                jitter: r.received.jitter,
            }),
            _ => None,
        })
        .collect()
}

/// The video inbound-rtp with the most bytes (a track has one, but a
/// republish can briefly leave a stale one), with its codec's mime type.
pub fn receiver_sample(stats: &[RtcStats]) -> Option<ReceiverSample> {
    let inbound = stats
        .iter()
        .filter_map(|s| match s {
            RtcStats::InboundRtp(i) if i.stream.kind == "video" => Some(i),
            _ => None,
        })
        .max_by_key(|i| i.inbound.bytes_received)?;
    let mime_type = stats
        .iter()
        .find_map(|s| match s {
            RtcStats::Codec(c) if c.rtc.id == inbound.stream.codec_id => {
                Some(c.codec.mime_type.clone())
            }
            _ => None,
        })
        .filter(|m| !m.is_empty());
    Some(ReceiverSample {
        frame_width: inbound.inbound.frame_width,
        frame_height: inbound.inbound.frame_height,
        frames_decoded: inbound.inbound.frames_decoded,
        bytes_received: inbound.inbound.bytes_received,
        packets_lost: inbound.received.packets_lost,
        packets_received: inbound.received.packets_received,
        mime_type,
    })
}

/// Every video outbound-rtp as a layer. Unreported values read 0 in the
/// crate's types, so a zero frame rate or an empty encoder name is "not
/// reported", which the web path leaves undefined too.
pub fn sender_layers(stats: &[RtcStats]) -> Vec<SenderLayer> {
    stats
        .iter()
        .filter_map(|s| match s {
            RtcStats::OutboundRtp(o) if o.stream.kind == "video" => Some(SenderLayer {
                frames_per_second: (o.outbound.frames_per_second > 0.0)
                    .then_some(o.outbound.frames_per_second),
                frame_width: o.outbound.frame_width,
                frame_height: o.outbound.frame_height,
                quality_limitation_reason: limitation(o.outbound.quality_limitation_reason),
                encoder_implementation: Some(o.outbound.encoder_implementation.clone())
                    .filter(|e| !e.is_empty()),
                active: o.outbound.active,
            }),
            _ => None,
        })
        .collect()
}

fn limitation(reason: QualityLimitationReason) -> &'static str {
    match reason {
        QualityLimitationReason::None => "none",
        QualityLimitationReason::Cpu => "cpu",
        QualityLimitationReason::Bandwidth => "bandwidth",
        QualityLimitationReason::Other => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// libwebrtc parses each stats report with an `unwrap()` inside a cxx
    /// callback, so a report type or enum value its `RtcStats` does not know
    /// aborts the app. The parse was checked against this exact pair (0.3.55 /
    /// 0.3.52 leave `RtcStats` unchanged; the prebuilt libwebrtc tag moves to
    /// webrtc-a545de4, the same m150 branch with refreshed TLS roots); a bump must re-check
    /// `RtcStats` against the new WebRTC stats before landing.
    #[test]
    fn the_stats_parser_is_the_reviewed_libwebrtc() {
        let lock = include_str!("../../Cargo.lock");
        for (name, version) in [("libwebrtc", "0.3.55"), ("webrtc-sys", "0.3.52")] {
            let entry = format!("name = \"{name}\"\nversion = \"{version}\"\n");
            assert!(
                lock.contains(&entry),
                "{name} moved off {version}: re-check its stats parsing, then update this test"
            );
        }
    }

    fn parse(items: Vec<Value>) -> Vec<RtcStats> {
        items
            .into_iter()
            .map(|v| serde_json::from_value(v).expect("a valid stats entry"))
            .collect()
    }

    fn transport_fixture() -> Vec<RtcStats> {
        parse(vec![
            json!({"type":"candidate-pair","id":"CP1","currentRoundTripTime":0.042,"bytesSent":900,"bytesReceived":1200,"nominated":true}),
            json!({"type":"outbound-rtp","id":"OA1","kind":"audio","packetsSent":50,"bytesSent":4000,"ssrc":7}),
            json!({"type":"inbound-rtp","id":"IA1","kind":"audio","packetsReceived":40,"packetsLost":3,"jitter":0.004,"bytesReceived":3000}),
            json!({"type":"remote-inbound-rtp","id":"RIA1","kind":"audio","localId":"OA1","packetsLost":2,"jitter":0.006,"roundTripTime":0.05}),
            json!({"type":"codec","id":"C1","mimeType":"audio/opus"}),
            json!({"type":"transport","id":"T1"}),
            json!({"type":"certificate","id":"CF1"}),
            json!({"type":"local-candidate","id":"LC1"}),
        ])
    }

    #[test]
    fn transport_entries_keep_the_poller_fields_and_drop_the_rest() {
        let entries = transport_entries(&transport_fixture());
        assert_eq!(
            entries,
            vec![
                Entry::CandidatePair {
                    id: "CP1".into(),
                    current_round_trip_time: 0.042,
                    bytes_sent: 900,
                    bytes_received: 1200,
                },
                Entry::OutboundRtp {
                    id: "OA1".into(),
                    kind: "audio".into(),
                    packets_sent: 50,
                    bytes_sent: 4000,
                },
                Entry::InboundRtp {
                    id: "IA1".into(),
                    kind: "audio".into(),
                    packets_received: 40,
                    bytes_received: 3000,
                    packets_lost: 3,
                    jitter: 0.004,
                },
                Entry::RemoteInboundRtp {
                    id: "RIA1".into(),
                    kind: "audio".into(),
                    local_id: "OA1".into(),
                    packets_lost: 2,
                    jitter: 0.006,
                },
            ]
        );
    }

    #[test]
    fn remote_inbound_keeps_its_outbound_local_id() {
        let entries = transport_entries(&transport_fixture());
        let outbound_id = entries.iter().find_map(|e| match e {
            Entry::OutboundRtp { id, .. } => Some(id.clone()),
            _ => None,
        });
        let local_id = entries.iter().find_map(|e| match e {
            Entry::RemoteInboundRtp { local_id, .. } => Some(local_id.clone()),
            _ => None,
        });
        assert_eq!(outbound_id, local_id);
        assert_eq!(local_id.as_deref(), Some("OA1"));
    }

    #[test]
    fn receiver_sample_takes_the_video_inbound_and_its_codec_mime() {
        let stats = parse(vec![
            json!({"type":"inbound-rtp","id":"IA","kind":"audio","bytesReceived":999999,"codecId":"CA"}),
            json!({"type":"inbound-rtp","id":"IV","kind":"video","bytesReceived":250000,
                   "framesDecoded":120,"frameWidth":1280,"frameHeight":720,
                   "packetsReceived":300,"packetsLost":4,"codecId":"CV"}),
            json!({"type":"codec","id":"CA","mimeType":"audio/opus"}),
            json!({"type":"codec","id":"CV","mimeType":"video/VP8"}),
        ]);
        assert_eq!(
            receiver_sample(&stats),
            Some(ReceiverSample {
                frame_width: 1280,
                frame_height: 720,
                frames_decoded: 120,
                bytes_received: 250000,
                packets_lost: 4,
                packets_received: 300,
                mime_type: Some("video/VP8".into()),
            })
        );
    }

    #[test]
    fn receiver_sample_has_no_mime_without_its_codec_entry() {
        let stats = parse(vec![
            json!({"type":"inbound-rtp","id":"IV","kind":"video","bytesReceived":1,"codecId":"CV"}),
        ]);
        assert_eq!(receiver_sample(&stats).and_then(|r| r.mime_type), None);
    }

    #[test]
    fn receiver_sample_is_none_without_a_video_inbound() {
        let stats = parse(vec![
            json!({"type":"inbound-rtp","id":"IA","kind":"audio","bytesReceived":10}),
            json!({"type":"codec","id":"C1","mimeType":"video/VP8"}),
        ]);
        assert_eq!(receiver_sample(&stats), None);
        assert_eq!(receiver_sample(&[]), None);
    }

    #[test]
    fn sender_layers_map_each_layer_and_drop_unreported_fps() {
        let stats = parse(vec![
            json!({"type":"outbound-rtp","id":"O0","kind":"video","framesPerSecond":30.0,
                   "frameWidth":1920,"frameHeight":1080,"qualityLimitationReason":"cpu",
                   "encoderImplementation":"libvpx","active":true}),
            json!({"type":"outbound-rtp","id":"O1","kind":"video","framesPerSecond":15.0,
                   "frameWidth":960,"frameHeight":540,"qualityLimitationReason":"bandwidth",
                   "encoderImplementation":"libvpx","active":true}),
            json!({"type":"outbound-rtp","id":"O2","kind":"video","framesPerSecond":0.0,
                   "frameWidth":480,"frameHeight":270,"qualityLimitationReason":"none",
                   "encoderImplementation":"","active":false}),
            json!({"type":"outbound-rtp","id":"OA","kind":"audio"}),
        ]);
        let layers = sender_layers(&stats);
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0].frames_per_second, Some(30.0));
        assert_eq!(layers[0].quality_limitation_reason, "cpu");
        assert_eq!(layers[0].encoder_implementation.as_deref(), Some("libvpx"));
        assert_eq!(layers[1].quality_limitation_reason, "bandwidth");
        assert_eq!(layers[2].frames_per_second, None);
        assert_eq!(layers[2].encoder_implementation, None);
        assert_eq!(layers[2].quality_limitation_reason, "none");
        assert!(!layers[2].active);
    }

    #[test]
    fn reply_serializes_in_the_w3c_shape() {
        let mut reply = Stats {
            at_ms: 1234.0,
            publisher: transport_entries(&transport_fixture()),
            ..Default::default()
        };
        reply.remote_video.insert(
            "TR_V1".into(),
            ReceiverSample {
                frame_width: 640,
                frame_height: 360,
                frames_decoded: 9,
                bytes_received: 10,
                packets_lost: 0,
                packets_received: 5,
                mime_type: None,
            },
        );
        reply.local_video.insert(
            "screen_share",
            vec![SenderLayer {
                frames_per_second: Some(30.0),
                frame_width: 1920,
                frame_height: 1080,
                quality_limitation_reason: "none",
                encoder_implementation: None,
                active: true,
            }],
        );
        let v = serde_json::to_value(&reply).expect("serializes");
        assert_eq!(v["atMs"], json!(1234.0));
        assert_eq!(v["publisher"][0]["type"], "candidate-pair");
        assert_eq!(v["publisher"][0]["currentRoundTripTime"], json!(0.042));
        assert_eq!(v["publisher"][3]["type"], "remote-inbound-rtp");
        assert_eq!(v["publisher"][3]["localId"], "OA1");
        assert_eq!(v["subscriber"], json!([]));
        assert_eq!(v["remoteVideo"]["TR_V1"]["frameWidth"], 640);
        assert!(v["remoteVideo"]["TR_V1"].get("mimeType").is_none());
        assert_eq!(v["localVideo"]["screen_share"][0]["framesPerSecond"], 30.0);
        assert_eq!(
            v["localVideo"]["screen_share"][0]["qualityLimitationReason"],
            "none"
        );
        assert!(v["localVideo"]["screen_share"][0]
            .get("encoderImplementation")
            .is_none());
    }
}
