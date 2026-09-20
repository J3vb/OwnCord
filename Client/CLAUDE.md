# OwnCord Client (Tauri v2)

TypeScript frontend (Vite, vanilla TS — no React/Vue) plus a deliberately thin
Rust backend in `src-tauri/` for native APIs only. LiveKit handles voice/video.

## Layout

- `src/stores/` observable stores · `src/lib/` protocol, WS, voice, E2EE ·
  `src/pages/`, `src/components/` UI
- `src/lib/protocolTypes.ts` is generated — see the root CLAUDE.md
- `tests/unit`, `tests/integration`, `tests/contract` (vitest, jsdom) ·
  `tests/e2e`, `tests/e2e/admin`, `tests/e2e/native` (Playwright) ·
  `tests/browser` (vitest browser mode)
- A test whose assertions read, import or execute a **`Server/`-owned**
  artifact belongs in `tests/contract`, not `tests/unit` — `src-tauri/` is
  part of this component, so reading it is an ordinary unit test. The rule
  is in [docs/contributing.md](../docs/contributing.md#testing)
- `src/platform/` does **not** exist yet. Where the desktop/browser seam will
  go, and which 21 files hold the native imports that must move behind it, is
  recorded in
  [docs/architecture/platform-contracts.md](../docs/architecture/platform-contracts.md).
  Building it is B7 — do not start it as a side effect of another change.

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
  subscription registered there. Other modules do register their own
  `ws.on(...)` handlers for page-local UI (`main.ts`, `MainPage.ts`,
  `ChannelController.ts` — ringing, overlays, slow-mode timers); that is fine
  as long as they only _read_ store state. Writing a store from one of those
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
