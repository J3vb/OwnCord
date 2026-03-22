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
