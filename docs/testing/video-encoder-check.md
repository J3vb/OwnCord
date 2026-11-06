# Windows screen-share and webcam encoder check

Prepared for local testing of `fix/video-encoder-monitoring`. Hardware results are pending.
The friend's RTX 4090 is not assumed to be the tester's hardware.

## What this patch changes

H.264 encoder checks now cover webcams as well as screen shares. Source, quality and
camera-device changes invalidate pending statistics and schedule a fresh check after
the change finishes. Disconnect invalidates both timers and pending results. Checks
remain bounded: one after four seconds, with one retry when the encoder is unnamed.
An observed OpenH264 encoder keeps the existing fallback to VP8, independently for
camera and screen. This is not a hardware encoder override or an FPS improvement claim.

The patch logs `H.264 encoder checked` with the media kind, encoder, encoded dimensions,
sent FPS and limitation. Camera evidence is in the logs; screen-share per-layer evidence
is also in the existing `share-diagnostics.json` export. Missing evidence means unknown.

## Build and environment

Patch review note: measured on base dev `f1cef74e`, the patched lazy `livekitSession`
chunk is 34,135 gzip bytes. Per the repository's documented 500-byte budget increments,
its allowance increases from 34,000 to 34,500 bytes for camera checks, capture-change
invalidation and encoder diagnostics. Startup remains within its existing budget
(120,848 / 121,000 bytes); no dependency or codec default changes. Carry this measured
reason into the eventual commit and PR description. The Windows mutation-shard helper
also converts file URLs and normalizes path separators so the validation command works
on Windows as well as Linux.

Use a Windows desktop test artifact built from this branch by the repository's CI.
The installed 2.8.0 release does not contain this patch. Record the artifact commit.
Desktop installer builds are CI-only; this patch does not publish or install a build.
For developers, use Node 26/npm 11, `npm ci` in `Client`, and `npm run check:client`
from the repository root before submitting the branch to CI.

Before each comparison, record:

- OwnCord version and commit, Windows build, WebView2 version and GPU driver.
- Every GPU in the PC, OwnCord's graphics-card selection, monitor pixel dimensions,
  refresh rate, scaling and HDR setting. Restart OwnCord after changing its GPU selection.
- Source type (window/monitor), selected codec, quality and FPS, and receiver details.
- Network arrangement and whether camera, shared audio or other recording software is on.

Keep these fixed between the release and patched build. Do not infer an encoder from
the GPU name or from overall GPU utilization. In Task Manager, inspect **Video Encode**
separately from **3D**, and close other encoders for the baseline.

## Source scene and diagnostics

1. Open [the local moving test scene](../../Client/tests/fixtures/video/encoder-motion.html)
   in a browser. Maximize it or use fullscreen on the monitor being tested. Keep it visible.
   Its counter measures the page's animation cadence, not transmitted FPS. A hidden tab
   or a 60 Hz monitor cannot validate a 120 FPS source.
2. In OwnCord, open **Settings > Diagnostics & logs** and enable **Record screen-share details**.
3. Join a test voice channel and have a second client actively watch the share. Prefer
   a second physical device on the same LAN. A second client on this PC is useful for
   functional checks but competes for GPU/CPU resources and is not a performance qualification.
4. Start each run afresh. Allow 15 seconds to settle, then keep the scene moving for
   120 seconds. Export the support bundle immediately after each run, before starting
   the next one. The screen-share recorder retains only the last three minutes.
5. Keep the bundle locally. Compare `share-diagnostics.json` and the encoder-check/fallback
   log entries. Record actual captured and encoded dimensions, not just the selected preset.

## Run matrix

Run each baseline on both release and patched builds. Repeat a failing cell three times.

| Run | Codec | Quality / FPS | Source                               | Camera |
| --- | ----- | ------------- | ------------------------------------ | ------ |
| A   | H.264 | High / 30     | Motion window                        | Off    |
| B   | H.264 | High / 60     | Same window                          | Off    |
| C   | H.264 | Source / 60   | Full ultrawide monitor, if available | Off    |
| D   | VP8   | High / 60     | Same window as B                     | Off    |
| E   | Auto  | High / 60     | Same window as B                     | Off    |
| F   | H.264 | High / 60     | Same window as B                     | On     |

If your monitor is not ultrawide, mark C unavailable. A large browser window on a smaller
display does not prove behavior of an actual ultrawide monitor capture. Source H.264
currently has a 3840×2160 capture ceiling; record the resulting aspect-preserving size.
Do not raise that ceiling or enable 120 FPS for this comparison.

For lifecycle checks, first confirm a hardware H.264 run, then change window → monitor
and High → Source → High without stopping. Expect a new encoder-check log after each
completed change. Repeat with a webcam device change where a second device exists.
Stop sharing or leave the call during a change; no stopped capture may resume and a new
session must not inherit an old result. Perform 20 start/change/stop cycles.

## Interpret the result

| Evidence                                                                         | Interpretation / next action                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OpenH264` then VP8 fallback log                                                 | Software H.264 was observed. Investigate negotiated profile, dimensions and GPU/runtime selection. |
| Hardware encoder evidence, capture near 60, encoded/sent FPS low, CPU limitation | Investigate encoder load, scaling, simultaneous layers and camera coexistence.                     |
| Captured FPS low while the source scene is smooth                                | Investigate capture/backend cadence before changing encoder policy.                                |
| Sender healthy, receiver poor                                                    | Investigate downlink, layer selection, decode and presentation on the receiver.                    |
| Bandwidth limitation                                                             | Repeat on clean LAN and verify sender/receiver capacity; do not classify as GPU failure.           |
| No encoder name or hardware indicator                                            | Unknown, not proof of either hardware or software encoding.                                        |

Use per-layer `powerEfficient`, encoder names and actual rates together. A configured
capture rate (`captureFpsSource: configured`) is not measured source throughput. An
aggregate encoder name can describe a mixture of hardware and software layers.

For each run copy this row into your notes:

| Run / build | Actual capture → encoded size | Capture / sent / received FPS | Encoder + hardware indicator | Limitation | Video Encode / CPU load | Bundle filename |
| ----------- | ----------------------------- | ----------------------------- | ---------------------------- | ---------- | ----------------------- | --------------- |
| Pending     |                               |                               |                              |            |                         |                 |

Functional acceptance: checks occur after changes; stale checks never alter new sessions;
camera and screen fallback independently; unsupported/missing statistics cause no forced
switch. Performance acceptance is separate: for a moving 1080p60 scene on clean LAN,
target median sent/decoded/presented FPS ≥55 with no unplanned freeze >500 ms, verified
using the broader [pipeline qualification plan](../plans/screen-sharing-pipeline-2026-10-25.md).
The support bundle alone does not measure presentation cadence or glass-to-glass latency.

## Native Rust decision

OwnCord already has a Linux native LiveKit media backend. Windows currently uses WebView2.
A Windows native prototype could use Windows Graphics Capture / D3D textures, GPU scaling
and hardware encoding, keeping raw full-resolution frames out of JavaScript and Tauri IPC.
The integration must prove that the selected LiveKit/libwebrtc build accepts the required
GPU surfaces or encoded frames while retaining congestion control, timestamps, keyframes,
layer selection, audio synchronization and E2EE. Rust alone provides none of these guarantees.

H.265 is already a conditional option in the web path, but every viewer must decode it:
the encrypted SFU path cannot transcode for incompatible receivers. Linux currently does
not advertise H.265. 120 FPS is deliberately hidden in `shareFps.ts`; changing that flag
does not make capture deliver 120 frames. Qualify capture, encode, transmit, decode and
presentation independently on a display above 120 Hz before exposing it.

Proceed with a narrowly scoped Windows native feasibility experiment only if the paired
measurements localize a browser-path limitation. Preserve the existing web path as fallback.
Do not rewrite chat, UI or the server to address a client media bottleneck.

References: [Windows capture frame pool](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool),
[LiveKit publish options](https://docs.livekit.io/reference/client-sdk-js/interfaces/TrackPublishDefaults.html),
[NVIDIA Video Codec SDK](https://developer.nvidia.com/video-codec-sdk).
