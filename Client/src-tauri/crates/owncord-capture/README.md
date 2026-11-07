# Windows GPU capture experiment

A standalone Rust crate and command-line experiment, deliberately **not a dependency of the
OwnCord app**. No frontend files or existing Tauri commands are involved. The experiment captures a
selected window or monitor and writes an Annex B H.264 elementary stream.

## Design

The normal path is:

1. Select a window by HWND or an attached monitor by index. Create a D3D11 device on that monitor's
   adapter, with multithread protection for Media Foundation's worker threads.
2. Prefer Windows Graphics Capture (WGC), using a free-threaded frame pool with two buffers. If WGC
   cannot initialize or deliver its first usable frame within five seconds, try DXGI Desktop
   Duplication. `--dxgi` forces that path for comparison.
3. Copy the captured BGRA surface into an owned **D3D11 texture** before releasing the capture
   frame. This is a GPU copy, not a claim of literally zero copies. A two-entry, newest-wins queue
   releases superseded textures instead of accumulating latency.
4. A D3D11 video processor scales and converts BGRA to limited-range BT.709 NV12 on the GPU. Output
   never exceeds **3840×2160**, is never upscaled, and has even dimensions. For example,
   **5120×1440 becomes 3840×1080**. Rounding can change the aspect ratio by less than two pixels.
   Queued GPU work is explicitly submitted before handing the surface to Media Foundation; this
   flush does not wait for completion or map pixels.
5. Enumerate Media Foundation hardware H.264 MFTs, require D3D11 surface support, and pass the same
   device through an IMFDXGIDeviceManager. Inputs are DXGI-surface-backed samples, with low latency
   enabled and B frames disabled. Vendor encoders are used when exposed as compatible MFTs;
   there is no direct NVENC, AMF or QSV SDK integration.
6. If no hardware candidate can be configured, or hardware produces no output within two seconds,
   use the inbox Microsoft software H.264 MFT. A startup retry happens only before the first encoded
   packet, and discards the old pending inputs, preserving a single encoder stream in the file. Only
   this path maps an NV12 staging texture and copies its rows into CPU memory. It retains GPU
   capture/scaling but does **not** retain GPU-only encoder input. `--software` forces it.
7. Poll asynchronous MFT input/output events without blocking, with at most **four accepted frames
   in flight**. The 60 Hz rational pacer skips missed slots rather than issuing a catch-up burst.
   If the source has no new frame, reuse its last texture at the next slot. If the encoder is full,
   skip that slot. The cap is a target rate, not a guarantee that a slow GPU can encode 60 fps. An accepted input
   that remains unfinished for two seconds triggers that startup fallback, or aborts with a
   software-retry diagnostic if output has already begun.
8. Copy only compressed output bytes to the CPU and write them to the raw file. Drain accepted
   inputs on normal completion, with a five-second deadline. Existing output files are never
   overwritten.

All Windows APIs live behind `cfg(windows)`. Pacing, queue ownership and scaling use only the Rust
standard library. The crate reuses the workspace's existing windows 0.58 dependency version.

There are **no game hooks, DLL injection, process-memory reads, input hooks, or custom overlays**.
The standard Windows capture indicator is left alone. These API choices avoid those invasive
techniques; they do not establish certification or compatibility with any particular anti-cheat.
Protected content can still be blank or unavailable.

### What DXGI fallback means for a window

Desktop Duplication captures the visible monitor desktop. For a window target, this experiment crops
that desktop to the window's DWM frame bounds. Other windows covering that rectangle **will appear**.
The CLI reports this explicitly on stderr. A window must fit wholly inside one monitor; spanning or
partly offscreen windows are rejected. This is not WGC's isolated-window behavior.

After encoding starts, a source resize, device/display change or capture error stops the run with a
message. Automatic capture-session rebuilding and encoder replacement after the first encoded packet are
outside this experiment.
Rotated-monitor DXGI capture is rejected; WGC is the available route for that case. HDR, cursor
composition in DXGI, audio and multiple simultaneous captures are not implemented.

## Build and run

Use Windows 10 1903+ or Windows 11, Rust and the Windows C++ build tools/SDK. Media Foundation and a
D3D11 video-capable adapter must be available. Windows N installations may need the Media Feature
Pack. Run from `Client/src-tauri/`; no desktop installer build is needed:

```powershell
cargo build -p owncord-capture --example capture --release --locked
$cli = ".\target\release\examples\capture.exe"
& $cli --list

# Choose an index from --list; file paths must end in .h264 and not already exist.
& $cli --monitor 0 --seconds 10 --output .\target\monitor.h264 `
  1> .\target\monitor-timing.log 2> .\target\monitor-run.log

# Substitute an actual HWND from --list.
& $cli --hwnd 0x12345 --seconds 10 --output .\target\window.h264

# Exercise each fallback separately.
& $cli --monitor 0 --dxgi --seconds 10 --output .\target\dxgi.h264
& $cli --monitor 0 --software --seconds 10 --output .\target\software.h264
```

The default bitrate is 20,000,000 bits/s; `--bitrate` accepts 100,000–100,000,000. Duration is
1–3600 seconds. Choose exactly one target. `--help` prints the argument list. Monitor indices and
window handles are session-specific: rerun `--list` after changing displays or reopening a window.

With a full FFmpeg build, validate decoding and inspect dimensions/frame counts:

```powershell
ffmpeg -nostdin -v error -i .\target\monitor.h264 -f null -
ffprobe -v error -count_frames -select_streams v:0 `
  -show_entries stream=codec_name,profile,width,height,nb_read_frames `
  -of json .\target\monitor.h264
ffplay -framerate 60 .\target\monitor.h264
```

Raw H.264 has no container timestamps for skipped slots. Playback at a forced 60 fps can therefore
run shorter than the capture's wall-clock duration. Keep the per-frame PTS log when evaluating timing;
a future transport must carry those timestamps. Codec VUI timing alone is not a substitute for this.
Playwright's bundled FFmpeg does not include an H.264 demuxer and cannot perform this validation.

## Timing output

One stdout line per encoded frame contains:

| Field                   | Meaning                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pts_100ns`             | Scheduled output slot in Media Foundation's 100 ns units; gaps preserve skipped slots.                                                          |
| `capture_to_encoded_ms` | Native capture timestamp to observed encoded output, before writing this packet to disk. Includes startup, queuing and GPU work.                |
| `encode_ms`             | Time from entering encoder submission to observing output, including software readback and synchronous ProcessInput work.                       |
| `reused_capture`        | The last accepted frame used this same capture. Its original capture timestamp is retained, so a frozen source's age rises honestly.            |
| `fps`                   | Encoded frames divided by elapsed run time, including startup of the output loop and drain in the final summary.                                |
| `queue_dropped`         | Cumulative frames discarded by the explicit queue, including obsolete queued frames skipped when taking the newest.                             |
| `encoder_skipped`       | Cumulative slots skipped for encoder backpressure, plus accepted inputs discarded by a hardware startup retry.                                  |
| `missed_slots`          | Cumulative deadlines missed because the main loop ran late; not an extra queue of frames.                                                       |
| `cpu_one_core_pct`      | Average process kernel+user CPU time divided by wall time since the output loop began. 100% is one core; multiple worker threads can exceed it. |
| `gpu_pct`               | Unavailable. No GPU utilization claim is inferred from CPU use.                                                                                 |

Drop counters describe this process's explicit decisions. WGC/driver-internal loss is not included;
these are not measurements of every source presentation. Capture age on reused frames must be
analyzed separately from latency of fresh frames. Per-frame console/disk work and polling also affect
results. There is no end-to-end network or receiver timing in this experiment.

## Measured results

Recorded on **7 November 2026**, Windows ARM64, Qualcomm Adreno 690, a 1920×1280 desktop,
Rust 1.98.1, release build, default 20 Mbit/s, two capture-queue entries and four encoder inputs.
These short developer-desktop runs overlapped repository compilation/formatting checks. They are
**not isolated encoder benchmarks**, a game workload, or proof of sustained 4K60. Throughput varied
with host load; the 60 fps target was not sustained in the final runs.

| Capture / encoder                           | Seconds | Frames | Actual fps | Fresh capture latency p50 / p95 (ms) | CPU (one-core %) | Queue drops / encoder skips / missed slots |
| ------------------------------------------- | ------: | -----: | ---------: | -----------------------------------: | ---------------: | ------------------------------------------ |
| Monitor WGC / QCOM hardware                 |      10 |    387 |      38.36 |                       70.41 / 203.74 |             9.91 | 12 / 19 / 191                              |
| Monitor DXGI / QCOM hardware                |      10 |    312 |      30.97 |                       70.60 / 162.19 |             6.98 | 3 / 4 / 280                                |
| Monitor WGC / Microsoft software            |       5 |     77 |      14.58 |                     131.39 / 1005.93 |           103.58 | 1 / 0 / 213                                |
| Window DXGI crop / QCOM hardware, 1920×1232 |       5 |    127 |      24.98 |                       88.82 / 141.48 |             3.69 | 4 / 3 / 170                                |

Latency percentiles exclude the first scheduled second and reused captures. The corresponding fresh
sample counts are 283, 256, 76 and 97. They use the sorted element at floor(N × percentile), clamped
to the last index. Reused captures retain their real source age but are excluded from this comparison.
The software p95 and missed-slot counts illustrate host/pipeline stalls, not an unbounded frame queue.
A separate five-second DXGI hardware run reached **292 frames / 58.19 fps**, showing why these variable
host-load results should not be presented as a stable codec throughput number.

Findings from exercising the pipeline:

- The QCOM hardware encoder accepted DXGI-surface-backed NV12 samples and produced decodable Main
  profile H.264. Uncompressed pixels stayed on the GPU on that path. Both WGC and forced DXGI monitor
  captures, WGC window capture and cropped DXGI window capture produced raw streams.
- A two-input encoder budget could stall before first output; a four-input budget enabled the
  successful monitor runs. A window run still buffered four inputs and requested additional input
  without producing output. The experiment keeps the bound and switches to software after two
  seconds **before any output packet**. That retry produced 40 decodable frames in a five-second run
  including its timeout/startup, at 7.82 fps overall. Low-latency configuration is reapplied after
  media-type negotiation; this is still an observed vendor-dependent startup behavior, not a
  universal minimum-buffer rule.
- The forced software path worked, with the expected NV12 readback and much higher CPU use. It did
  not meet 60 fps here. A hardware MFT being present is not itself evidence of usable low latency.
- Full FFmpeg 9.0.2 decoded the captured hardware, software, window and automatic-startup-fallback
  streams. Frame counts were checked against CLI logs. A decoded WGC frame was visually inspected
  for real content and color; capture files, timing logs and preview images remain local build
  artifacts and are not committed.
- Scaling arithmetic verifies 5120×1440 → 3840×1080. **No physical ultrawide/4K source, NVIDIA/AMD/Intel
  encoder, game, or anti-cheat system was available for this measurement.** GPU utilization and
  capture-to-receiver latency were not measured.

## Local verification limits

The standalone crate's six tests, strict Clippy, optimized CLI and stream decoding were verified on
Windows ARM64. The configured OSV scan and cargo-deny workspace checks passed, as did actionlint,
zizmor and the documentation checks. Linux runtime coverage is provided by the standalone CI job;
there was no running local Linux container engine.

The full desktop-app `npm run check:rust` was attempted with the pinned toolchain and installed Clang.
Its existing app test executable failed to load with Windows STATUS_ENTRYPOINT_NOT_FOUND
(0xc0000139), before running tests. This is separate from the successfully running capture-crate test
executable. The app code and existing Tauri commands are outside this change.

## Tests and CI

From `Client/src-tauri/`, on Linux or Windows:

```text
cargo test -p owncord-capture --all-targets --locked
cargo clippy -p owncord-capture --all-targets --locked -- -D warnings
cargo fmt --all -- --check
```

Tests cover oversized/odd/invalid dimensions, a slow consumer keeping the freshest frame within its
capacity, release of superseded frame resources, and an hour of simulated 60 Hz scheduling without
drift or catch-up bursts. The standalone CI matrix runs these tests on Linux and Windows. Windows
also compiles/lints the capture and encoder implementation; Linux compiles only the portable pieces.
CI has no interactive GPU capture assertion. The crate is included in the local `check:rust` task.

## LiveKit handoff questions

OwnCord currently publishes through livekit-client JS in WebView2 on Windows. Neither a D3D11 texture
nor this raw H.264 file can simply be passed to that SDK as a MediaStreamTrack. Three routes deserve
separate measurements:

| Route                           | What could be reused                                                                                                                                          | Open questions                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native LiveKit Rust track       | Native capture, device ownership and pacing. The existing [Linux backend](../../src/native_voice/camera.rs) demonstrates a NativeVideoSource/raw-frame route. | Does the Windows SDK path accept GPU-backed buffers without I420 readback? Does the chosen SDK expose encoded H.264 input, or will it re-encode? How are keyframe requests, bitrate feedback, congestion control and simulcast connected?                                                                                                             |
| WebView2 texture stream         | The uncompressed GPU capture/conversion path, with Chromium/LiveKit JS retaining WebRTC encoding and transport.                                               | Microsoft's experimental TextureStream API exposes a JS stream from shared native textures. Which deployed runtime/SDK versions support it? Which origin restrictions, texture lifetime/fence rules and adapter matching are required? Does it remain usable while the app is hidden? This is an experimental API, not a shipped OwnCord integration. |
| Feed standard WebView2 web APIs | Application-owned raw frames could be transferred to JS and a supported video-track generator or canvas capture route.                                        | How many CPU/GPU copies and how much IPC bandwidth are needed? Are the APIs available in the deployed WebView2 version, and do hidden-window throttling or background suspension break pacing? A WebCodecs decoder would decode this H.264 first and WebRTC would generally encode again.                                                             |

A native publisher also needs an explicit room/participant ownership design, token lifetime,
permissions, share metadata, subscription behavior and OwnCord's E2EE key lifecycle. Reusing the
existing Linux approach is evidence of a possible integration pattern, not proof of Windows GPU
buffer or pre-encoded-frame support. Test browser/native E2EE interoperability before choosing it.

Before choosing a route: test NVIDIA, AMD, Intel and hybrid adapters; real borderless/exclusive games;
minimize/restore and resize; 5120×1440 and 3840×2160 hardware sources; sustained overload; and capture
restart after access/device loss. Measure fresh-frame latency percentiles, GPU copy/encode engines,
CPU and receiver timing. A shader fallback may be needed on adapters without the required video
processor conversion. Texture pooling and event-driven waits are candidates for reducing allocation
and polling overhead after the current limits are characterized.

## References

- [WGC free-threaded frame pools](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)
- [Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-duplication-api)
- [Media Foundation D3D11 support](https://learn.microsoft.com/en-us/windows/win32/medfound/supporting-direct3d-11-video)
- [Asynchronous MFT event protocol](https://learn.microsoft.com/en-us/windows/win32/medfound/asynchronous-mfts)
- [Microsoft H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
- [LiveKit raw video sources](https://docs.livekit.io/robotics/media/video/video-tracks/)
- [WebView2 experimental TextureStream](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2experimentaltexturestream?view=webview2-1.0.4071-prerelease)
