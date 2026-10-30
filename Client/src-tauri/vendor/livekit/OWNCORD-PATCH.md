# Vendored livekit 0.10.0 (OwnCord patch)

This is the crates.io package `livekit-0.10.0` (checksum
`51f6a9dd86d3255487f778582ec0d631092fd379d781ae11995479498f12daf4`),
unpacked verbatim except for the files below and the removal of cargo's
`.cargo-ok` marker. It is wired in by `[patch.crates-io]` in
`Client/src-tauri/Cargo.toml`; the dependency stays `livekit = "=0.10.0"`.
Its own `Cargo.toml` is untouched, so every dependency resolves to the same
crates.io version `Cargo.lock` pins. Only the `livekit` crate is vendored.

## Why (WP LP-8d)

Upstream (still in 0.10.0) never sets `AddTrackRequest.stereo` or
`AudioTrackFeature::TfStereo`, so livekit-server strips `stereo=1` from the publisher's answer and libwebrtc
builds a mono opus encoder: a Linux screen share's stereo audio is downmixed
before it is sent. The patch adds `TrackPublishOptions::stereo` (default
`false`, audio tracks only). `native_voice/session.rs` sets it for the screen
share audio and nothing else. No C++/ABI change: webrtc-sys and libwebrtc are
the crates.io ones.

## Patch

All changes are marked `OWNCORD-PATCH`. Diff against the pristine package
(`diff -ru livekit-0.10.0 vendor/livekit`, paths trimmed):

```diff
--- src/room/options.rs
+++ src/room/options.rs
@@ -151,6 +151,11 @@
     /// - Screen share: `MaintainResolution` (clarity is critical for text/UI)
     /// - Other/unknown: `Balanced`
     pub degradation_preference: Option<DegradationPreference>,
+    // OWNCORD-PATCH (WP LP-8d): not in upstream livekit 0.10.0. See OWNCORD-PATCH.md.
+    /// Audio only; signals TF_STEREO (and `AddTrackRequest.stereo`) so the SFU
+    /// negotiates stereo Opus (`stereo=1`) for the published track. Ignored
+    /// for video tracks.
+    pub stereo: bool,
 }
 
 impl Default for TrackPublishOptions {
@@ -170,6 +175,7 @@
             video_encoder: VideoEncoderBackend::Auto,
             scalability_mode: None,
             degradation_preference: None,
+            stereo: false, // OWNCORD-PATCH (WP LP-8d)
         }
     }
 }
--- src/room/participant/local_participant.rs
+++ src/room/participant/local_participant.rs
@@ -398,6 +398,9 @@
             req.audio_features.push(proto::AudioTrackFeature::TfPreconnectBuffer as i32);
         }
 
+        // OWNCORD-PATCH (WP LP-8d): not in upstream livekit 0.10.0.
+        apply_stereo_request(&mut req, &options, matches!(track, LocalTrack::Audio(_)));
+
         req.packet_trailer_features =
             options.frame_metadata_features.to_proto().into_iter().map(|f| f as i32).collect();
 
@@ -1182,12 +1185,52 @@
     }
 }
 
+// OWNCORD-PATCH (WP LP-8d): not in upstream livekit 0.10.0. Marks an audio
+// track's AddTrackRequest as stereo, both ways livekit-client does, so the
+// SFU's publisher answer carries `stereo=1`. Video tracks are left alone.
+// `AddTrackRequest.stereo` is deprecated in favour of TF_STEREO, but the
+// server still reads it, so both are set.
+#[allow(deprecated)]
+fn apply_stereo_request(
+    req: &mut proto::AddTrackRequest,
+    options: &TrackPublishOptions,
+    is_audio: bool,
+) {
+    if options.stereo && is_audio {
+        req.stereo = true;
+        req.audio_features.push(proto::AudioTrackFeature::TfStereo as i32);
+    }
+}
+
 #[cfg(test)]
 mod tests {
     use super::*;
     use crate::options::FrameMetadataFeatures;
 
     #[test]
+    #[allow(deprecated)]
+    fn stereo_is_signalled_for_audio_only() {
+        let stereo = TrackPublishOptions { stereo: true, ..Default::default() };
+        let mono = TrackPublishOptions::default();
+        assert!(!mono.stereo);
+
+        let mut audio = proto::AddTrackRequest::default();
+        apply_stereo_request(&mut audio, &stereo, true);
+        assert!(audio.stereo);
+        assert_eq!(audio.audio_features, vec![proto::AudioTrackFeature::TfStereo as i32]);
+
+        let mut video = proto::AddTrackRequest::default();
+        apply_stereo_request(&mut video, &stereo, false);
+        assert!(!video.stereo);
+        assert!(video.audio_features.is_empty());
+
+        let mut off = proto::AddTrackRequest::default();
+        apply_stereo_request(&mut off, &mono, true);
+        assert!(!off.stereo);
+        assert!(off.audio_features.is_empty());
+    }
+
+    #[test]
     fn timing_subscribers_request_video_sender_transformer_without_frame_metadata() {
         let options = TrackPublishOptions {
             frame_metadata_features: FrameMetadataFeatures::default(),
```

## Dropping it

Remove `vendor/livekit` and the `[patch.crates-io]` table once a livekit
release ships an equivalent option (upstream PR to livekit/rust-sdks pending).
That is an SDK bump: re-verify the libwebrtc pin per the comment in
`Cargo.toml`. On any bump, re-apply the diff above to the new package.

## Tests

`stereo_is_signalled_for_audio_only` (in the patched `local_participant.rs`) covers the helper, but CI does not run it: the Rust job tests only the root package. Run it by hand with `cargo test --manifest-path vendor/livekit/Cargo.toml --lib stereo` after re-applying the patch. CI covers the behaviour through `session.rs`'s publish-options tests and the native-voice interop case "a native share's audio reaches the browser as stereo with the channels apart".

The crate's own `Cargo.lock` is upstream's, kept verbatim; nothing builds from it.
