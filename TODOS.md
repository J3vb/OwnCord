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

## Already Implemented (discovered 2026-03-29 — code analysis was stale)

- ~~Simulcast on Camera Video~~ -- `simulcast: quality !== "source"` in publishTrack options (livekitSession.ts:852)
- ~~Adaptive Bitrate on Screenshare~~ -- `dynacast: !isSource` + `adaptiveStream: !isSource` in Room options (livekitSession.ts:187-188)
- ~~LiveKit Proxy Port Exhaustion~~ -- already handles reuse (same host) + cleanup via shutdown channel (different host) in livekit_proxy.rs:196-208

## Deferred (from 2026-03-31 eng review — Mission Control)

### Auto-Pilot Token/Cost Tracking

**What:** Parse Claude CLI output for token usage and display estimated cost per agent job in the Mission Control dashboard.
**Why:** Auto-pilot spawns agents autonomously overnight. Without cost visibility, runs could burn through API credits unexpectedly. A simple per-job token counter provides awareness.
**Pros:** Cost awareness prevents bill shock. Enables setting daily budget limits in auto-pilot config.
**Cons:** Claude CLI output format may change. Token counts are approximate. Anthropic dashboard already shows global usage.
**Context:** Deferred from Mission Control Phase 2 (auto-pilot). Only matters if auto-pilot runs frequently. Consider as Phase 2.5 after auto-pilot ships and usage patterns are clear.
**Depends on:** Auto-pilot scheduler (Phase 2 of Mission Control design).
**Added:** 2026-03-31 (eng review of Mission Control design)

## Deferred (from 2026-03-30 eng review)

### Remote Video Stream Reuse (getRemoteVideoStream)

**What:** The `getRemoteVideoStream(userId, type)` accessor added for sidebar preview can be reused for PiP, mini-player, or notification previews.
**Why:** Currently only used by stream preview hover. Future features (PiP mode, floating mini-player, notification thumbnails) would benefit from the same API.
**Pros:** Zero additional work — the export already exists in livekitSession.ts. This TODO just tracks the reuse opportunity.
**Cons:** None — purely informational. No code change needed.
**Context:** Added during sidebar stream preview eng review (2026-03-30). The method is exported as a bound module-level function, consistent with getLocalCameraStream/getLocalScreenshareStream. Any future consumer can import it directly.
**Depends on:** Sidebar stream preview feature (this PR).
**Added:** 2026-03-30 (eng review of sidebar stream preview)

## Deferred (from 2026-03-29 CEO review)

### Voice E2E CI Integration (narrowed scope)

**What:** Set up LiveKit binary in CI for WebRTC-specific regression testing only.
**Why:** Mocked E2E tests (24 tests in `voice-lifecycle.spec.ts`) cover 90%+ of voice UI regressions. Real LiveKit CI is only needed for audio pipeline bugs, LiveKit SDK regressions, or WebRTC transport issues that mocks can't catch.
**Pros:** Catches WebRTC-specific regressions (codec negotiation, ICE failures, audio pipeline).
**Cons:** Requires Docker-in-CI setup with LiveKit binary. High maintenance for low-frequency bugs.
**Context:** Mocked voice E2E covers: join/leave flow, speaker indicators, permission recovery, device hot-swap, quality warnings, timer, token refresh, channel switching. Only pursue real LiveKit CI if evidence emerges of WebRTC-specific regressions that mocked tests miss.
**Depends on:** Voice E2E test infrastructure (done), mocked voice E2E expansion (done).
**Added:** 2026-03-29 (eng review of voice/video polish), **updated:** 2026-03-29 (scope narrowed after mocked E2E expansion)
**Added:** 2026-03-29 (eng review of voice/video polish)

## Deferred (from 2026-04-01 eng review — Open Source Ready)

### DM Sidebar Incremental Reconciliation

**What:** Replace O(n) DOM rebuild of DM sidebar with incremental reconciliation (differ/patch per DM item).
**Why:** Current implementation at SidebarArea.ts destroys and recreates the entire DM sidebar on every store change. Causes visual flicker with many DMs.
**Pros:** Smooth UI, reduced DOM churn, better perceived performance.
**Cons:** Complex refactor across multiple files. Risk of stale state bugs.
**Context:** Marked TODO(H16) in code. The SidebarArea.ts file split is complete (747 lines, SidebarDmSection.ts extracted). Consider the `reconcile.ts` utility that already exists in `lib/`.
**Depends on:** SidebarArea.ts file split (done).
**Added:** 2026-04-01 (eng review of Open Source Ready plan)

### API + WS Test Coverage Push to 80%

**What:** Push api package from 75.4% to 80%+ and ws package from 77.9% to 80%+.
**Why:** These are the only 2 Go packages below the 80% coverage target. All other packages (auth 94.9%, storage 85.1%, config 84.7%, db 80.6%, updater 87.3%, permissions 100%) meet the target.
**Pros:** Uniform 80%+ coverage across all packages.
**Cons:** Remaining gaps are in complex stateful handlers with diminishing returns.
**Context:** API gaps are in deep handler paths (register edge cases, DM list errors, TOTP flows, search rate limiting). WS gaps are in voice control success paths and buildReady filtering. TypeScript client is at 93.3% — well above target.
**Depends on:** Nothing.
**Added:** 2026-04-01 (eng review of Open Source Ready plan)
