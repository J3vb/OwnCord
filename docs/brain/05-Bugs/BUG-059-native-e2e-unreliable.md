---
date: 2026-03-30
severity: "high"
status: "open"
---

# BUG-059: Native Tauri E2E too unreliable for release gate

## Description

Native Tauri E2E is not reliable enough to act as a release gate. Last run: 3 failed, 7 flaky, 57 not run, only 6 passed.

## Steps to Reproduce

1. Run `npm run test:e2e:native` in `Client/tauri-client`
2. Observe high failure/flake/skip rate

## Expected Behavior

Native E2E suite should be stable enough to gate releases with consistent pass/fail results.

## Actual Behavior

Multiple failure points:
- Hard 30s CDP bootstrap timeout in `native-fixture.ts:65`
- Fixed-delay timing in `smoke.spec.ts:125`
- Disabled-host-input race in `smoke.spec.ts:147`
- Saved-server assumptions in `auth-flow.spec.ts:113`

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Component:** Native E2E infrastructure

## Root Cause

Combination of aggressive timeouts, fixed delays instead of readiness conditions, and environment-dependent assumptions in test setup.

## Fix

- Increase CDP bootstrap timeout or add retry logic in `native-fixture.ts`
- Replace fixed delays with `waitForSelector`/`waitForFunction` conditions
- Remove saved-server assumptions; use deterministic test fixtures

## Related

- [[Open Bugs 2]] item 2
- [[BUG-063-native-e2e-skip-gates]] (excessive skips)
- [[BUG-065-e2e-fixed-sleeps]] (fixed sleep pattern)
