# TODOS

Deferred work items from engineering reviews.

## Completed (2026-03-29 voice/video polish pass)

- ~~Voice E2E Test Infrastructure~~ -- `tests/e2e/voice-lifecycle.spec.ts` (11 tests)
- ~~Voice Session Metrics~~ -- `voice_sessions` counter on `/api/v1/metrics`
- ~~Create DESIGN.md~~ -- full design system documentation at repo root
- ~~Extract AudioPipeline Class~~ -- `audioPipeline.ts`, `audioElements.ts`, `deviceManager.ts` (facade pattern)
- ~~Audio Pipeline + Event Handler Tests~~ -- `audio-pipeline.test.ts` (30 tests), `audio-elements.test.ts` (25 tests)
- ~~HTTPS Proxy Unit Tests~~ -- `livekit_proxy_test.go` (22 tests)
- ~~Migrate VAD to AudioWorklet~~ -- `public/vad-worklet.js` with setTimeout fallback

## Deferred (from 2026-03-29 CEO review)

### Simulcast on Camera Video

**What:** Enable simulcast (multiple quality layers) for camera video tracks so subscribers can receive lower quality when bandwidth is limited.
**Why:** Currently camera video is fixed quality -- no adaptive degradation on poor networks. Users see buffering/freezing instead of graceful quality reduction.
**Pros:** Matches Discord's adaptive video behavior. Better experience on poor connections.
**Cons:** Requires enabling LiveKit SDK's built-in simulcast support and verifying encoding pipeline. Architecture-level change.
**Context:** LiveKit SDK supports `simulcast: true` in Room options. Needs separate design doc to evaluate encoding CPU impact and subscriber-side quality switching.
**Depends on:** AudioPipeline refactor (done). Verify `livekit-client` v2.17.3 simulcast support.
**Added:** 2026-03-29 (CEO review of voice/video polish)

### Adaptive Bitrate on Screenshare

**What:** Enable LiveKit's dynacast for screenshare tracks so bitrate adapts to network conditions.
**Why:** Screenshare encoding is set once and doesn't adapt. If network degrades, frames drop instead of quality reducing.
**Pros:** Smoother screenshare on variable connections.
**Cons:** Needs testing with different content types (text vs video). Architecture-level change.
**Context:** LiveKit supports `dynacast: true` in Room options. Currently disabled.
**Depends on:** Simulcast evaluation (above) -- same architectural concerns.
**Added:** 2026-03-29 (CEO review of voice/video polish)

### LiveKit Proxy Port Exhaustion

**What:** Investigate connection reuse or port limiting in the Rust TLS proxy (`livekit_proxy.rs`).
**Why:** Frequent server switches allocate new proxy ports without reusing old ones. Long sessions with many switches could leak ports.
**Pros:** Prevents resource exhaustion on long-running sessions.
**Cons:** Requires Rust proxy architecture changes.
**Context:** Each `start_livekit_proxy` Tauri command binds a new TCP listener. Old listeners aren't cleaned up.
**Depends on:** Nothing -- can be investigated independently.
**Added:** 2026-03-29 (CEO review of voice/video polish)

### Voice E2E CI Integration

**What:** Set up LiveKit binary in CI so voice E2E tests run automatically on push.
**Why:** Voice E2E tests currently run locally only. CI integration catches regressions automatically.
**Pros:** Automated regression detection for voice flows.
**Cons:** Requires Docker-in-CI setup with LiveKit binary.
**Context:** Local voice E2E infra is done (`voice-lifecycle.spec.ts`). CI needs LiveKit `--dev` mode in a Docker container.
**Depends on:** Voice E2E test infrastructure (done).
**Added:** 2026-03-29 (eng review of voice/video polish)
