---
date: 2026-03-30
severity: "medium"
status: "open"
---

# BUG-062: Client unit suite has high concentration of low-signal assertions

## Description

Across the client test tree there are many low-signal assertion patterns that inflate test count without providing meaningful coverage.

## Metrics

- 187 `not.toHaveBeenCalled` assertions
- 52 `not.toThrow` assertions
- 37 "does nothing" test names
- 54 "no-op" test names
- 34 `toBeDefined` assertions

## Worst Clusters

- `audio-pipeline.test.ts:130`
- `channel-controller.test.ts:195`
- `livekit-session.test.ts:204`
- `device-manager.test.ts:60`

## Expected Behavior

Tests should assert meaningful behavioral outcomes — state changes, correct return values, proper side effects.

## Actual Behavior

Many tests only verify that "nothing bad happens" (no throw, no call, no-op) without checking that the *right thing* happens.

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Component:** Client unit tests (`tests/unit/`)

## Root Cause

Tests were written to increase coverage rather than verify behavior. Toast and audio-pipeline tests were partially cleaned in a prior session.

## Fix

Systematically audit and upgrade assertions in the worst-cluster files. Replace no-op checks with state/behavior assertions.

## Related

- [[Open Bugs 2]] item 5
- [[BUG-066-toast-audio-duplicated-noop]] (partially remediated)
