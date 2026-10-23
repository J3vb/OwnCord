# Linux native voice and global keys

Moved from `Client/CLAUDE.md` on 2026-10-21 so client sessions that do not
touch Linux voice do not load it. `Client/CLAUDE.md` keeps the short rule.

- On Linux the client links **livekit** (the Rust SDK) as a Linux-only
  dependency: the system WebKitGTK ships no WebRTC, so voice/video must run in
  this backend rather than the webview. `webrtc-sys` then needs **clang >= 21**
  and downloads a prebuilt **libwebrtc** (~148 MB, ~800 MB extracted); GCC is
  refused (Chromium's hermetic libc++ relies on `trivial_abi`).
  `Client/scripts/linux-webrtc-toolchain.sh` fetches libwebrtc and the CUDA headers (so NVENC is built) and uses
  `CC`/`CXX`, an installed clang >= 21, or (Debian/Ubuntu only) apt.llvm.org's
  clang-21, in that order. Every Linux leg that builds the crate runs it (see the root CLAUDE.md for the local invocation). A non-Linux build is
  unaffected: the dependency is behind
  `[target.'cfg(target_os = "linux")'.dependencies]`. Design:
  [docs/architecture/voice-e2ee.md](voice-e2ee.md).
- Linux voice runs in that backend (`src-tauri/src/native_voice/`) behind the
  `livekitSession` facade: `features/voice/native/platform.ts`'s
  `isLinuxDesktop()` (the Tauri host on a Linux, non-Android user agent) is the
  only switch, `RoomLifecycle.createRoom` builds a `NativeRoom` adapter there,
  `E2EEWorker.applyRoomKey` sends the key over the `NativeVoice` platform
  contract, and audio device lists come from `native/devices.ts` (`cpal`'s
  device ids, not the webview's). Audio I/O is the session's own `cpal`
  streams, not the SDK's device module: `native_voice/capture.rs` (APM, then
  RNNoise) and `native_voice/playout.rs` (per-user volume mixer, which also
  feeds the echo canceller its reference). Video frames never cross IPC:
  each native session serves them on a token-authenticated `127.0.0.1`
  WebSocket (`src-tauri/src/native_voice/video.rs`); remote tracks render
  through `native/videoRenderer.ts` (WebGL; the canvas itself is shown
  beside the tile's `<video>` via `lib/videoSurface.ts`, while a frameless
  canvas `MediaStreamTrack` keeps the grid MediaStream-based) and camera capture
  runs in the backend (`src-tauri/src/native_voice/camera.rs`, GStreamer:
  `GstDeviceMonitor`/`v4l2src`/`pipewiresrc` → `decodebin` → I420 `appsink`),
  so the camera keeps working while the window is hidden; the
  `NativeCameraTrack` (`native/nativeCameraTrack.ts`) is its preview, read
  back over the frame socket. Screen share captures in the backend
  (`src-tauri/src/native_voice/screen.rs`, libwebrtc's `DesktopCapturer`):
  `native/screenPicker.ts` picks on X11, the xdg-desktop-portal dialog picks
  on Wayland, and `lib/screenShare.ts`'s one `isLinuxDesktop()` branch swaps
  `createLocalScreenTracks` for `NativeRoom`'s `createScreenTracks`; the
  picker's Share audio switch (on when a PulseAudio-protocol sound server
  answers) adds a `NativeScreenAudioTrack` that follows the share. Change source there is the
  track's own (`NativeScreenTrack.changeSource`, the host's
  `native_voice_change_screen`), reached through `lib/screenShare.ts`'s
  capability check `inPlaceSourceChange`, never an `isLinuxDesktop()` branch.
  A camera switch is the track's own too (`NativeCameraTrack.setDeviceId`, the
  host's `native_voice_change_camera`); `mediaControl` restarts the camera only
  when it rejects `CameraSwitchUnavailable`, and goes back to the track's
  previous device when that restart fails too. `CameraDeviceUnusable` (the
  picked device opened but gave no frame, such as an infrared sensor) keeps
  the live camera with no restart. The camera list marks greyscale-only
  devices `infrared` and lists them after the colour cameras, so the default
  camera is never one.
  The codec is the same: `resolvePreferredCodec` returns H.264 or VP9 on Linux
  only when chosen and `native_voice_video_codecs` says the engine has it (Auto
  and a saved H.265 are VP8; a native VP9 publish is one L1T3 SVC layer, never
  simulcast); a live codec switch unpublishes without stopping
  the capture (`unpublishTrack(track, false)`).
  The Linux decode list the announce reports (`features/voice/decodeCaps.ts`) is
  the native receiver's list from the same probe, narrowed to VP8, H.264 and
  VP9; a failed or slow probe reports the baseline.
  Keep the state machine platform-blind: a Linux-only behaviour belongs in
  the adapter or the Rust session, never as a branch in
  `joinOrchestration`/`mediaControl`. The interop proof is
  `npm run test:e2e:native-voice` with `OWNCORD_E2E_LIVEKIT_BINARY` and
  `OWNCORD_NATIVE_VOICE_PEER=src-tauri/target/debug/examples/native_voice_interop`
  (built with `cargo build --example native_voice_interop`); it covers audio,
  video and a synthetic-source screen share, each with a wrong-key control.
  CI has no display: the X11 capturer runs only under
  `xvfb-run cargo test -- --ignored x11`, and the Wayland portal only on a
  real desktop.
- Global push to talk and mute/deafen keys come from one of three backends,
  named by `desktop.globalShortcuts.status().backend`: `polling` (Windows,
  X11), `portal` (Wayland, the xdg-desktop-portal GlobalShortcuts interface:
  GNOME 48+ and KDE Plasma) or `none`. The Keybinds UI (`pttControls.ts`,
  `KeybindsTab.ts`) and `MainPage` choose by that capability, never by an
  `isLinuxDesktop()` branch. On `portal` the desktop owns and consumes the
  keys: PTT is limited to function keys, `globalKeysPortalBound` remembers a
  successful bind so startup rebinds silently, and `pushToTalkService.ts`
  re-arms on `global-keys-changed` (loss arrives as the host's `ptt-error`).
  Host side: `src-tauri/src/portal_shortcuts.rs`; only a real GNOME 48+/KDE
  Wayland desktop proves the dialog and key delivery.
