---
date: 2026-03-30
severity: "medium"
status: "open"
---

# BUG-065: E2E specs rely on fixed sleeps instead of readiness conditions

## Description

Several E2E specs use fixed `sleep`/`waitForTimeout` instead of explicit readiness conditions, causing flaky tests.

## Affected Locations

- `smoke.spec.ts:125`
- `helpers.ts:81`
- `voice-lifecycle.spec.ts:400`

## Expected Behavior

Tests should wait for specific DOM conditions (`waitForSelector`, `waitForFunction`, network idle) rather than arbitrary time delays.

## Actual Behavior

Fixed sleeps introduce timing-dependent flakes — tests pass on fast machines, fail on slow ones or CI.

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Component:** E2E specs

## Root Cause

Quick-fix timing workarounds that were never replaced with proper readiness conditions.

## Fix

Replace each fixed sleep with the appropriate Playwright wait:
- `waitForSelector` for DOM element readiness
- `waitForFunction` for JS state conditions
- `waitForResponse` for API/WS readiness

## Related

- [[Open Bugs 2]] item 8
- [[BUG-059-native-e2e-unreliable]] (contributes to flakiness)
