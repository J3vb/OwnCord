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
