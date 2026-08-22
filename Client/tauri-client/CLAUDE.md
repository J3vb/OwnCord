# OwnCord Client (Tauri v2)

TypeScript frontend (Vite, vanilla TS — no React/Vue) plus a deliberately thin
Rust backend in `src-tauri/` for native APIs only. LiveKit handles voice/video.

## Layout

- `src/stores/` observable stores · `src/lib/` protocol, WS, voice, E2EE ·
  `src/pages/`, `src/components/` UI
- `src/lib/protocolTypes.ts` and `src/generated/` are generated — see the root
  CLAUDE.md
- `tests/unit`, `tests/integration` (vitest, jsdom) · `tests/e2e` (Playwright) ·
  `tests/browser` (vitest browser mode)

## Gotchas

- Node's native Web Storage (Node 22+) shadows jsdom's `localStorage`;
  `tests/setup.ts` replaces it with an in-memory shim, so the suite runs on
  modern Node without `--no-experimental-webstorage`. If storage tests fail
  en masse, suspect that shim before your change. CI pins Node 24.
- `src/lib/dispatcher.ts` is the single WS-event entry point **into the
  stores**: server events reach domain stores only through a `ws.on(...)`
  subscription registered there. Other modules do register their own
  `ws.on(...)` handlers for page-local UI (`main.ts`, `MainPage.ts`,
  `ChannelController.ts` — ringing, overlays, slow-mode timers); that is fine
  as long as they only *read* store state. Writing a store from one of those
  handlers is the violation, and `local/no-store-write-in-ws-on` now fails the
  build on it.
- Voice sessions are superseded, not cancelled. `LiveKitSession` re-entry
  points check whether a newer attempt owns the shared state before tearing
  anything down, so cleanup in an aborted path must be scoped to that attempt's
  own room — a global `leaveVoice()` there kills the live session.
- Voice E2EE is key-holder based with TOFU identity pinning. Anything touching
  `livekitE2EE.ts` or `identity.ts` must preserve the epoch/keypair staleness
  guards and must never report an unverified peer as verified.
- Do not run `npm run tauri build` locally; the desktop build is CI-only.
- Formatting is prettier-enforced; match the surrounding code rather than
  reasoning about style.
