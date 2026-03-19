# E2E Test Status — 2026-03-18

## 209 tests: 209 passed (100%)

All E2E tests now pass. Previous issues from 2026-03-15 have been resolved.

## Resolved Issues

### Fixed — Voice widget selector mismatches (2 tests)

- `voice-widget.spec.ts:30` — Removed `.voice-users-list` assertion.
  Voice users render in the sidebar (`VoiceChannel.ts`), not in VoiceWidget.
- `voice-widget.spec.ts:80` — Replaced `[data-testid='voice-user-3']` with
  `.voice-user-item .vu-name` text matcher. VoiceChannel doesn't use
  per-user data-testid attributes.

### Previously fixed (2026-03-15 → 2026-03-17)

| Root Cause | Tests Fixed |
| ---------- | ----------- |
| No channel auto-selected on login | ~35 tests |
| Settings overlay toggle broken | 24 tests |
| Quick Switcher Ctrl+K not wired | 9 tests |
| Voice widget stays hidden | 4 of 6 tests |
| Member list not rendering members | 7 tests |
| `.status-dot` selector mismatch | 1 test |

## Anti-Flakiness Improvements (2026-03-18)

- **Config**: Added `actionTimeout: 10s`, `navigationTimeout: 15s`,
  local retry (1), video on first retry, JUnit XML reporter for CI
- **Helpers**: Added `waitForWsReady()`, `navigateToMainPageReady()`,
  `emitWsMessageAndWait()` for timing-safe WS event testing
- **Patterns applied**: Web-first assertions, DOM-signal polling
  instead of hardcoded delays, text content matchers over missing
  data-testid attributes

## Remaining Improvement Plan

See `docs/brain/02-Tasks/PLAN-E2E-improvement.md` for Phases 2-6:

- Phase 2: Add `data-testid` to 12 components
- Phase 3: Page Object helpers + dedup
- Phase 4: Strengthen assertions
- Phase 5: Toast coverage
- Phase 6: Migrate to `data-testid` selectors
