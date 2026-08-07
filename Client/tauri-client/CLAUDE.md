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

- **On Node 22+ you must run `NODE_OPTIONS=--no-experimental-webstorage npm test`.**
  Native Web Storage shadows jsdom's `localStorage` and fails ~478 tests that
  have nothing to do with your change. That is a local toolchain artifact, not
  a regression — do not "fix" those failures. CI pins Node 20.
- `src/lib/dispatcher.ts` is the single WS-event entry point: server events
  reach the stores only through a `ws.on(...)` subscription registered there.
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
