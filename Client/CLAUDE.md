# OwnCord Client (Tauri v2)

TypeScript frontend (Vite, vanilla TS — no React/Vue) plus a deliberately thin
Rust backend in `src-tauri/` for native APIs only. LiveKit handles voice/video.

## Layout

- `src/stores/` observable stores · `src/lib/` protocol, WS, voice, E2EE ·
  `src/pages/`, `src/components/` UI · `src/features/voice/` modules
  extracted from `lib/livekitSession.ts` and `lib/livekitE2EE.ts` (the
  facades; the `e2ee*.ts` files are `E2EEManager`'s), with colocated
  `*.test.ts`; `src/features/{connection,direct-messages,channels,messaging,voice}/wsHandlers.ts`
  hold the WebSocket handler bodies extracted from `lib/dispatcher.ts`;
  `src/features/messaging/` also holds `stores/messages.store.ts`'s pure
  reducers and message model — the store stays the facade, so import its
  mutators from `@stores/messages.store`, never from the reducer modules; new
  or extracted code uses `src/features/`, relative imports
- `src/lib/protocolTypes.ts` is generated — see the root CLAUDE.md
- `tests/unit`, `tests/integration`, `tests/contract` (vitest, jsdom) ·
  `tests/e2e`, `tests/e2e/admin`, `tests/e2e/native` (Playwright) ·
  `tests/browser` (vitest browser mode)
- A test whose assertions read, import or execute a **`Server/`-owned**
  artifact belongs in `tests/contract`, not `tests/unit` — `src-tauri/` is
  part of this component, so reading it is an ordinary unit test. The rule
  is in [docs/contributing.md](../docs/contributing.md#testing)
- `src/platform/contracts/` holds the type-only desktop/browser seam
  interfaces (B7-3), and `src/platform/desktop/` implements every one of
  them (B7-4/B7-5). It is the only place under `src/` a `@tauri-apps` import
  may appear — eslint enforces it for static and dynamic imports. Feature
  code reaches native APIs through the `desktop` registry
  (`platform/desktop/index.ts`), which is statically reachable from the
  entry: keep a native module that is lazy today a dynamic `import()` inside
  its desktop method, or it lands in the startup chunk. Map and rules:
  [docs/architecture/platform-contracts.md](../docs/architecture/platform-contracts.md)

## Gotchas

- Node's native Web Storage (Node 22+) shadows jsdom's `localStorage` and
  `Storage`; `vitest.config.ts` appends `--no-experimental-webstorage` to
  `process.env.NODE_OPTIONS`, which every forked worker inherits, so jsdom's
  are the only ones present, and `tests/setup.ts` throws if the flag did not
  arrive (OC-0415). There is no shim any more. If storage tests fail en masse,
  check that `NODE_OPTIONS` block at the top of `vitest.config.ts` before your
  change (`poolOptions.forks.execArgv` does not work — vitest replaces it). CI
  pins Node 26.
- `src/lib/dispatcher.ts` is the single WS-event entry point **into the
  stores**: server events reach domain stores only through a `ws.on(...)`
  subscription registered there. The handler bodies live in
  `src/features/*/wsHandlers.ts` as plain functions that only `dispatcher.ts`
  may import and that never subscribe themselves
  (`src/features/dispatcherDoor.test.ts` enforces both). Other modules do register their own
  `ws.on(...)` handlers for page-local UI (`main.ts`, `MainPage.ts`,
  `ChannelController.ts` — ringing, overlays, slow-mode timers); that is fine
  as long as they only _read_ store state. Writing a store from one of those
  handlers is the violation, and `local/no-store-write-in-ws-on` now fails the
  build on it.
- `src/` has **no import cycles**: `npm run lint:cycles` (oxlint `import/no-cycle`)
  runs at `--max-warnings=0`, so a new cycle fails `npm run lint`. When a
  lower-level module has to trigger a higher one, invert the edge rather than
  import upward: `stores/auth.store.ts` imports neither `voice.store` nor
  `lib/notifications` — `voice.store.ts` registers its logout teardown through
  `registerVoiceLogoutTeardown` at load, and `main.ts` registers the
  notification-audio cleanup through `onAuthCleared`. In
  `components/message-list/`, `attachments.ts` is the leaf every renderer
  imports (it also owns the image lightbox, which `media.ts` re-exports), so it
  must not import a sibling renderer. `madge` still lists cycles that close only
  through a lazy `import()` or an `import type`; oxlint does not count those.
- Voice sessions are superseded, not cancelled. `LiveKitSession` re-entry
  points check whether a newer attempt owns the shared state before tearing
  anything down, so cleanup in an aborted path must be scoped to that attempt's
  own room — a global `leaveVoice()` there kills the live session.
- Voice E2EE is key-holder based with TOFU identity pinning. Anything touching
  `livekitE2EE.ts`, its `features/voice/e2ee*.ts` modules or `identity.ts`
  must preserve the epoch/keypair staleness guards and must never report an
  unverified peer as verified.
- On Linux the client links **livekit** (the Rust SDK) as a Linux-only
  dependency: the system WebKitGTK ships no WebRTC, so voice/video must run in
  this backend rather than the webview. `webrtc-sys` then needs **clang >= 21**
  and downloads a prebuilt **libwebrtc** (~148 MB, ~800 MB extracted); GCC is
  refused (Chromium's hermetic libc++ relies on `trivial_abi`).
  `Client/scripts/linux-webrtc-toolchain.sh` fetches libwebrtc and uses
  `CC`/`CXX`, an installed clang >= 21, or (Debian/Ubuntu only) apt.llvm.org's
  clang-21, in that order. Every Linux leg that builds the crate runs it (see
  the root CLAUDE.md for the local invocation). A non-Linux build is
  unaffected: the dependency is behind
  `[target.'cfg(target_os = "linux")'.dependencies]`. Design:
  [docs/architecture/voice-e2ee.md](../docs/architecture/voice-e2ee.md).
- Linux voice runs in that backend (`src-tauri/src/native_voice/`) behind the
  `livekitSession` facade: `features/voice/native/platform.ts`'s
  `isLinuxDesktop()` (the Tauri host on a Linux, non-Android user agent) is the
  only switch, `RoomLifecycle.createRoom` builds a `NativeRoom` adapter there,
  `E2EEWorker.applyRoomKey` sends the key over the `NativeVoice` platform
  contract, and audio device lists come from `native/devices.ts` (the device
  module's device names, not the webview's). Video frames never cross IPC:
  each native session serves them on a token-authenticated `127.0.0.1`
  WebSocket (`src-tauri/src/native_voice/video.rs`); remote tracks render
  through `native/videoRenderer.ts` (WebGL, exposed as a canvas
  `MediaStreamTrack` so the grid stays MediaStream-based) and the camera is
  the webview's own `getUserMedia` track, pumped up the socket by
  `native/cameraUplink.ts`. Screen share captures in the backend
  (`src-tauri/src/native_voice/screen.rs`, libwebrtc's `DesktopCapturer`):
  `native/screenPicker.ts` picks on X11, the xdg-desktop-portal dialog picks
  on Wayland, and `lib/screenShare.ts`'s one `isLinuxDesktop()` branch swaps
  `createLocalScreenTracks` for `NativeRoom`'s `createScreenTracks`; it is
  video only (no screen-share audio on Linux). Keep the state machine
  platform-blind: a Linux-only behaviour belongs in the adapter or the Rust
  session, never as a branch in `joinOrchestration`/`mediaControl`. The interop proof is
  `npm run test:e2e:native-voice` with `OWNCORD_E2E_LIVEKIT_BINARY` and
  `OWNCORD_NATIVE_VOICE_PEER=src-tauri/target/debug/examples/native_voice_interop`
  (built with `cargo build --example native_voice_interop`); it covers audio,
  video and a synthetic-source screen share, each with a wrong-key control.
  CI has no display: the X11 capturer runs only under
  `xvfb-run cargo test -- --ignored x11`, and the Wayland portal only on a
  real desktop.
- **Lifecycle ownership is enforced, not assumed (B7-11).** `Disposable`
  (`src/lib/disposable.ts`) owns component, overlay and render lifetimes;
  `SessionScope` (`src/lib/sessionScope.ts`) owns session-bound async work.
  `tests/unit/lifecycle-ownership.test.ts` classifies every production site
  from the syntax tree and fails on an unowned one that is not on an exact,
  shrink-only allowlist (R1 long-lived-target listeners need `signal`/`once`;
  R2 intervals keep their handle and clear it in-file; R3 `setTimeout` keeps
  its handle, or a signal owns it through `setOwnedTimeout` (`src/lib/dom.ts`);
  R4 `new AbortController` is only for the primitives and named cancellation
  tokens). A stale entry also fails, so the lists only shrink.
  `tests/helpers/lifecycle.ts` installs a guard from `tests/setup.ts` that
  fails a unit test leaving a bare `window`/`document` listener or a real
  interval alive, unless its file is on the shrink-only
  `tests/lifecycle-guard-baseline.json`, whose `reasons` justify each entry; do
  not add an entry without a reason. The runtime proof is the CDP soak
  (`tests/e2e/support/lifecycle-probe.ts`,
  `tests/e2e/fullstack/long-session.spec.ts`), which needs
  `OWNCORD_E2E_LIVEKIT_BINARY` and gates every `client-fullstack` PR.
- Do not run `npm run tauri build` locally; the desktop build is CI-only.
- Formatting is prettier-enforced; match the surrounding code rather than
  reasoning about style.
