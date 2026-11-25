# Vendored livekit 0.10.0 (OwnCord patch)

This is the crates.io package `livekit-0.10.0` (checksum
`51f6a9dd86d3255487f778582ec0d631092fd379d781ae11995479498f12daf4`),
unpacked verbatim except for the files below and the removal of cargo's
`.cargo-ok` marker. It is wired in by `[patch.crates-io]` in
`Client/src-tauri/Cargo.toml`; the dependency stays `livekit = "=0.10.0"`.
Its own `Cargo.toml` is untouched, so every dependency resolves to the same
crates.io version `Cargo.lock` pins. Only the `livekit` crate is vendored.

## Why (stereo publish)

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
+    // OWNCORD-PATCH (stereo publish): not in upstream livekit 0.10.0. See OWNCORD-PATCH.md.
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
+            stereo: false, // OWNCORD-PATCH (stereo publish)
         }
     }
 }
--- src/room/participant/local_participant.rs
+++ src/room/participant/local_participant.rs
@@ -398,6 +398,9 @@
             req.audio_features.push(proto::AudioTrackFeature::TfPreconnectBuffer as i32);
         }
 
+        // OWNCORD-PATCH (stereo publish): not in upstream livekit 0.10.0.
+        apply_stereo_request(&mut req, &options, matches!(track, LocalTrack::Audio(_)));
+
         req.packet_trailer_features =
             options.frame_metadata_features.to_proto().into_iter().map(|f| f as i32).collect();
 
@@ -1182,12 +1185,52 @@
     }
 }
 
+// OWNCORD-PATCH (stereo publish): not in upstream livekit 0.10.0. Marks an audio
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

## Dual PC stereo receive

OwnCord connects with `single_peer_connection = false` (see
`room_options` in `native_voice/session.rs`). Upstream adds `stereo=1` to the
Opus fmtp lines only in single PC mode, in the client's offer. In dual PC mode
the SFU offers to the subscriber transport and libwebrtc writes the answer
without `stereo=1`, so the receive Opus decoder runs mono and a stereo screen
share's audio reaches a Linux viewer downmixed. `PeerTransport::create_anwser`
now passes the answer through `stereo_receive_answer`, which applies the same
`munge_stereo_for_audio` to it. Only the subscriber transport answers, and its
audio m-lines only receive; a mono track decodes the same with the flag set.
Marked `OWNCORD-PATCH (dual PC stereo receive)` in
`src/rtc_engine/peer_transport.rs`. Covered by the native-voice interop case
"native and browser peers decode each other's audio with the same key", which
asserts the native receiver's negotiated Opus fmtp carries `stereo=1`.

## Key slots

OwnCord stages each new voice room key in its own key index and switches
sending to it a moment later, so receivers already hold the key every frame
names (see `E2EEWorker` and `native_voice_use_key_slot`). Upstream's sender
frame cryptors always encrypt with index 0 and expose no way to change that
for the room's tracks. `E2eeManager::set_sender_key_index` sets the index for
every local sender cryptor and for those created later; a cryptor created
while it runs reads the value again when it is stored. Marked
`OWNCORD-PATCH (key slots)` in `src/room/e2ee/manager.rs`. Covered by the
native-voice interop cases, which decode frames across the browser and native
engines.

```diff
--- src/room/e2ee/manager.rs
+++ src/room/e2ee/manager.rs
@@ -57,6 +57,8 @@
     dc_encryption_enabled: bool,
     frame_cryptors: HashMap<(ParticipantIdentity, TrackSid), FrameCryptor>,
     data_packet_cryptor: Option<DataPacketCryptor>,
+    // OWNCORD-PATCH (key slots): the key index every local sender encrypts with.
+    sender_key_index: i32,
 }
 
 #[derive(Clone)]
@@ -82,6 +84,7 @@
                 options,
                 frame_cryptors: HashMap::new(),
                 data_packet_cryptor,
+                sender_key_index: 0, // OWNCORD-PATCH (key slots)
             })),
             state_changed: Default::default(),
         }
@@ -198,9 +201,27 @@
         self.setup_cryptor(&frame_cryptor);
 
         let mut inner = self.inner.lock();
+        // OWNCORD-PATCH (key slots): a set_sender_key_index that ran after
+        // setup_rtp_sender but before this insert did not see this cryptor.
+        frame_cryptor.set_key_index(inner.sender_key_index);
         inner.frame_cryptors.insert((identity, publication.sid()), frame_cryptor.clone());
     }
 
+    // OWNCORD-PATCH (key slots): not in upstream livekit 0.10.0.
+    /// Encrypt every local track, and every one published later, with the
+    /// shared key at `index`. Receivers decrypt by the index each frame names,
+    /// so a key staged in another index first reaches every peer before the
+    /// sender switches to it.
+    pub fn set_sender_key_index(&self, local_identity: &ParticipantIdentity, index: i32) {
+        let mut inner = self.inner.lock();
+        inner.sender_key_index = index;
+        for ((identity, _), cryptor) in inner.frame_cryptors.iter() {
+            if identity == local_identity {
+                cryptor.set_key_index(index);
+            }
+        }
+    }
+
     fn setup_cryptor(&self, frame_cryptor: &FrameCryptor) {
         let state_changed = self.state_changed.clone();
         frame_cryptor.on_state_change(Some(Box::new(move |participant_identity, state| {
@@ -278,6 +299,7 @@
             options.key_provider.handle.clone(),
             sender,
         );
+        frame_cryptor.set_key_index(inner.sender_key_index); // OWNCORD-PATCH (key slots)
         frame_cryptor.set_enabled(inner.enabled);
         frame_cryptor
     }
```

## Video bitrate in place

A live change of the server's per-person video cap must change a published
camera's or share's encoder rate with no republish (a republish gives viewers
a new publication and a keyframe). libwebrtc has `RtpSender::set_parameters`,
but upstream keeps a local video track's sender `pub(crate)`, so nothing
outside the crate can reach it. `LocalVideoTrack::sender_layers` reads
each sender encoding's `max_bitrate` and scale-down (the SDK lists the
full-size layer first, so callers find it by scale) and
`set_sender_max_bitrates` writes the rates
back in place, built like the SDK's own dynacast `set_parameters` call (a
length mismatch or a missing transceiver is a no-op). Marked
`OWNCORD-PATCH (video bitrate)` in `src/room/track/local_video_track.rs`. No C++ or
ABI change. The rule that decides the rates is
`native_voice/session/video_bitrate.rs` (`capped_layers`), which has unit tests.

```diff
--- src/room/track/local_video_track.rs
+++ src/room/track/local_video_track.rs
@@ -361,6 +361,41 @@
+    // OWNCORD-PATCH (video bitrate): not in upstream livekit 0.10.0. See OWNCORD-PATCH.md.
+    pub fn sender_layers(&self) -> Vec<(Option<u64>, f64)> {
+        let Some(transceiver) = self.transceiver() else {
+            return Vec::new();
+        };
+        transceiver
+            .sender()
+            .parameters()
+            .encodings
+            .iter()
+            .map(|e| (e.max_bitrate, e.scale_resolution_down_by.unwrap_or(1.0)))
+            .collect()
+    }
+
+    // OWNCORD-PATCH (video bitrate): not in upstream livekit 0.10.0. See OWNCORD-PATCH.md.
+    pub fn set_sender_max_bitrates(&self, rates: &[Option<u64>]) -> RoomResult<()> {
+        // no transceiver or a length mismatch: Ok(()), nothing changed;
+        // otherwise write each encoding's max_bitrate and set_parameters
+        // only when one differs
+    }
```

## Signal input

Invalid or missing fields in server signal messages are logged and skipped, or
end the session through the normal reconnect path, instead of stopping the
handler. Marked `OWNCORD-PATCH (signal input)` in
`src/rtc_engine/rtc_session.rs` and `src/room/mod.rs`:

- An unusable publisher answer or subscriber offer (unknown SDP type or
  unparsable SDP) is validated before any session state is updated, sends a
  `Close` event with `Action::Disconnect` and returns an error. The signal task
  only logs a returned error, so the event is what ends the session: the engine
  stops reconnecting and reports a terminal disconnect. A reconnect is not
  used because a server that keeps sending unusable descriptions would loop.
- An unusable trickle candidate, a room-update message without its room, and a
  subscriber message without a subscriber connection are logged and skipped.
  A track-published response without track info drops the pending sender, and
  `add_track` now returns "track publication cancelled" immediately instead of
  waiting for its timeout (its `select!` no longer ignores a dropped sender).
- A join response without a room closes the engine and fails `Room::connect`.
  A missing participant or invalid participant sid is already rejected earlier
  by `SessionParticipantInfo::from_join`; `split_join_response` only repeats
  that check so the later code needs no unwraps. Participant, speaker, connection
  quality, track-subscribed, transcription and remote-track entries with an
  invalid sid are skipped; non-finite speaker levels count as 0 and speakers
  sort with `total_cmp`. A restarted join response missing a part skips that
  part and still completes the restart.
- Pure helpers (`parse_sdp_type`, `parse_remote_description`,
  `parse_ice_candidate_json`, `split_join_response`, `sanitize_audio_level`)
  have unit tests in both files.

## Marker index

Every marker in the source reads `OWNCORD-PATCH (tag)`. The tag is the key:
`scripts/checks/check-vendor-patches.test.mjs` fails when a tag in `src` has no
entry here, when an entry here has no marker left, or when a marker has no tag.
Add the entry in the same change as the marker. Each entry says where the patch
is, why it exists, the test that covers it and when it can go. The bullets
below must stay in this form, one per tag.

- `OWNCORD-PATCH (stereo publish)`
  - Where: `src/room/options.rs` (`TrackPublishOptions::stereo` and its default);
    `src/room/participant/local_participant.rs` (the `apply_stereo_request` call
    in the add-track path, and the function itself).
  - Why: upstream never signals stereo, so the SFU strips `stereo=1` and a share's
    audio is sent mono. See "Why (stereo publish)" above.
  - Test: `stereo_is_signalled_for_audio_only` in `local_participant.rs`; the
    publish-options tests in `src/native_voice/session/tests.rs`; the native-voice
    interop case "a native share's audio reaches the browser as stereo with the
    channels apart".
  - Drop when: a livekit release sets `TfStereo` and `AddTrackRequest.stereo` from
    a publish option. None known yet.
- `OWNCORD-PATCH (dual PC stereo receive)`
  - Where: `src/rtc_engine/peer_transport.rs` (`create_anwser` and
    `stereo_receive_answer`).
  - Why: dual PC mode answers without `stereo=1`, so the receive decoder is mono.
    See "Dual PC stereo receive" above.
  - Test: the stereo munge tests in `peer_transport.rs`
    (`stereo_is_added_for_opus_fmtp_only_once` and the idempotence one) cover
    `munge_stereo_for_audio`, not `stereo_receive_answer` itself; the native-voice
    interop case "native and browser peers decode each other's audio with the same
    key" covers the whole path.
  - Drop when: upstream munges the subscriber answer in dual PC mode. None known yet.
- `OWNCORD-PATCH (key slots)`
  - Where: `src/room/e2ee/manager.rs` (the `sender_key_index` field,
    `set_sender_key_index`, and where a sender frame cryptor is created and stored).
  - Why: OwnCord stages a new room key in its own index and switches sending to it
    later; upstream always encrypts with index 0. See "Key slots" above.
  - Test: none in the vendored crate. `src/native_voice/tests.rs` covers the slot
    bookkeeping on our side; the native-voice interop cases cover the encryption.
  - Drop when: upstream lets the sender key index be set for a room's local tracks.
    None known yet.
- `OWNCORD-PATCH (video bitrate)`
  - Where: `src/room/track/local_video_track.rs` (`sender_layers` and
    `set_sender_max_bitrates`).
  - Why: a live bitrate cap change must reach the encoder without a republish, and
    upstream keeps the sender `pub(crate)`. See "Video bitrate in place" above.
  - Test: none for the two methods. `capped_layers` in
    `src/native_voice/session/video_bitrate.rs`, which decides the rates, has unit
    tests.
  - Drop when: upstream exposes the video sender or its encoding parameters. None
    known yet.
- `OWNCORD-PATCH (signal input)`
  - Where: `src/room/mod.rs` (join, update, speaker, connection quality,
    track-subscribed, transcription and restart handling, `sanitize_audio_level`,
    `split_join_response`); `src/rtc_engine/rtc_session.rs` (SDP and candidate
    parsing helpers, answer and offer handling, trickle, track-published response,
    the `add_track` wait, the terminal disconnect path).
  - Why: a bad or incomplete server message must not stop the handler or panic. See
    "Signal input" above.
  - Test: `signal_input_tests` in `room/mod.rs`; in `rtc_session.rs`
    `sdp_type_accepts_known_values_and_rejects_others`,
    `remote_description_with_unknown_type_is_an_error` and
    `ice_candidate_json_requires_all_fields`. The terminal disconnect and the
    dropped sender wait have no test.
  - Drop when: upstream handles these inputs without unwrap or panic. Check each
    site; some may already be fixed.

- `OWNCORD-PATCH (lint scope)`
  - Where: `src/lib.rs` (the crate-level `#![allow(warnings, clippy::...)]`).
  - Why: the crate is a workspace member so its tests can run against the root
    `Cargo.lock`, and that puts it under the root `cargo clippy --all-targets --
    -D warnings` run. Upstream code is linted upstream; this keeps the root lint
    run about OwnCord's own code. Our patches are reviewed through their tests.
  - Test: the Rust Unit Tests job's clippy step stays green with the crate in the
    workspace.
  - Drop when: the vendored crate leaves the workspace.

## Dropping it

Remove `vendor/livekit` and the `[patch.crates-io]` table once a livekit
release ships an equivalent option (upstream PR to livekit/rust-sdks pending).
Upstream livekit 0.11.0 is the candidate to re-check every marker against when the crate is next bumped.
That is an SDK bump: re-verify the libwebrtc pin per the comment in
`Cargo.toml`. On any bump, re-apply the diff above and the `OWNCORD-PATCH (signal input)`
markers (`grep -rn 'signal input' src`), and the two `OWNCORD-PATCH (video bitrate)` methods (`grep -rn 'video bitrate' src`) to the new package.

## Tests

The patched crate is a member of the root workspace, so its tests build against the root `Cargo.lock` and the pinned libwebrtc. From `Client/src-tauri/` (after the Linux toolchain step in `CLAUDE.md`):

```
cargo test -p livekit --lib -- signal_input stereo rtc_session
```

This runs the signal input helpers (`signal_input_tests`), the `rtc_session` tests and `stereo_is_signalled_for_audio_only`. CI runs it in the Rust Unit Tests job when anything under `vendor/livekit/` or `Cargo.lock` changes (the `livekitvendor` selection in `scripts/ci-select.mjs`), and every night in `nightly-test-depth.yml`. Run it after re-applying the patch to a new upstream version. CI also covers the behaviour through `session.rs`'s publish-options tests and the native-voice interop case "a native share's audio reaches the browser as stereo with the channels apart".

The crate's own `Cargo.lock` is upstream's, kept verbatim; nothing builds from it. The workspace membership, the crate-level lint allow and the three formatting-only edits that keep `cargo fmt --all -- --check` clean (`sanitize_audio_level`, `parse_remote_description`, the subscriber answer in `rtc_session.rs`) are part of the patch.
