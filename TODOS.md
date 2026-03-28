# TODOS

Deferred work items from engineering review (2026-03-21).

## Voice E2E Test Infrastructure

**What:** Add E2E test infrastructure for voice flows (voice_join → LiveKit connect → audio → voice_leave).
**Why:** The voice path is critical UX with zero automated E2E coverage. Unit tests cover handlers and controllers, but nothing tests the full integration.
**Pros:** Catches integration bugs between server + LiveKit + client.
**Cons:** Requires LiveKit binary in CI, WebRTC support in test browser, ~200 lines of test infra.
**Context:** The existing native E2E infrastructure (WebView2 CDP) could be extended. Needs CI setup first.
**Depends on:** LiveKit binary available in CI environment.
**Added:** 2026-03-21 (eng review of feature/livekit-migration)

## Voice Session Metrics

**What:** Add voice session count and duration metrics to the /metrics endpoint.
**Why:** No way to know how many voice sessions happen or how long they last without reading logs. Useful for understanding usage patterns and catching degradation.
**Pros:** Visibility into voice health (shorter sessions = potential problem).
**Cons:** Requires tracking join/leave timestamps in memory (~10 LOC).
**Context:** /metrics already has connected users and LiveKit health. This adds voice-specific counters.
**Depends on:** /metrics endpoint (already implemented).
**Added:** 2026-03-22 (CEO review of feature/livekit-migration)

## Create DESIGN.md

**What:** Run /design-consultation to generate DESIGN.md from the existing tokens.css and ui-mockup.html.
**Why:** The 114-token design system exists in CSS but the reasoning, usage guidelines, and component vocabulary aren't documented. Future contributors (including AI) will guess which tokens to use.
**Pros:** Prevents design drift, makes the design language explicit, helps AI tools generate consistent UI.
**Cons:** ~15 min CC time. Must be kept up-to-date as tokens evolve.
**Context:** tokens.css was extracted from ui-mockup.html. Discord-inspired dark theme with Windows-first typography (Segoe UI Variable).
**Depends on:** feature/livekit-migration merged to main.
**Added:** 2026-03-22 (design review of feature/livekit-migration)

## Extract AudioPipeline Class

**What:** Extract ~200 lines of audio pipeline code (setupAudioPipeline, teardownAudioPipeline, VAD polling, volume control) from LiveKitSession into a separate AudioPipeline class in audioprocessing.ts.
**Why:** livekitSession.ts is 837 lines (exceeds 800-line max). The audio pipeline is independently testable but currently untested because it's entangled with session lifecycle. This is also a prerequisite for AudioWorklet migration.
**Pros:** Brings livekitSession.ts under 800 lines, enables independent testing, cleaner separation of concerns.
**Cons:** Requires careful interface design between LiveKitSession and AudioPipeline (~30 min CC).
**Context:** The audio pipeline was the source of prior regressions (commits c496f83, d498e8f). Extracting it makes both testing and future AudioWorklet migration easier.
**Depends on:** Nothing — can be done immediately.
**Added:** 2026-03-26 (eng review of feature/livekit-migration)

## Audio Pipeline + Event Handler Tests

**What:** Write unit tests for setupAudioPipeline, VAD polling, teardownAudioPipeline, and Room event handlers (TrackSubscribed, TrackUnsubscribed, Disconnected, ActiveSpeakersChanged) using AudioContext mocks.
**Why:** These are the most regression-prone codepaths with zero test coverage. Audio pipeline bugs caused two prior fix commits on this branch.
**Pros:** Catches regressions in the most bug-prone voice code. Enables confident refactoring.
**Cons:** Requires AudioContext mock infrastructure (~50 lines of test setup).
**Context:** The public API of LiveKitSession is well-tested (~80%), but the internal audio processing and event handling is entirely untested.
**Depends on:** AudioPipeline extraction (above) — tests will be much cleaner against the extracted class.
**Added:** 2026-03-26 (eng review of feature/livekit-migration)

## HTTPS Proxy Unit Tests

**What:** Add unit tests for the LiveKit HTTPS proxy (livekit_proxy in API package) covering WebSocket upgrade detection, header/subprotocol forwarding, bidirectional copy, and error paths.
**Why:** The proxy is the critical path for all non-localhost voice connections. A broken proxy means voice doesn't work for remote clients.
**Pros:** Validates the proxy works correctly for WebSocket upgrades and data forwarding.
**Cons:** Requires httptest-based WebSocket test setup (~100 lines).
**Context:** The proxy terminates TLS and forwards to LiveKit's local WebSocket port. It's used when clients connect over HTTPS (non-localhost).
**Depends on:** Nothing — can be done immediately.
**Added:** 2026-03-26 (eng review of feature/livekit-migration)

## Migrate VAD to AudioWorklet

**What:** Move voice activity detection from requestAnimationFrame polling on the main thread to an AudioWorklet running on the audio thread.
**Why:** rAF pauses when the browser/Tauri window is backgrounded — VAD stops working, mic stays stuck in its last gated/ungated state. For a gaming chat app, the window is often backgrounded. AudioWorklet runs independently of the main thread and tab focus.
**Pros:** VAD works correctly when app is backgrounded. Zero main-thread CPU cost. Proper architecture for audio processing.
**Cons:** Requires separate AudioWorklet JS file, MessagePort communication, more complex setup (~300 lines total).
**Context:** Current VAD polls at ~60 FPS via rAF (3-7x more than needed). AudioWorklet can process every audio frame natively. This is the industry-standard approach for browser audio processing.
**Depends on:** AudioPipeline extraction (above) — AudioWorklet replaces the VAD polling inside the extracted class.
**Added:** 2026-03-26 (eng review of feature/livekit-migration)
