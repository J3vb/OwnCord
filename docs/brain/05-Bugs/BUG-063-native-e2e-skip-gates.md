---
date: 2026-03-30
severity: "medium"
status: "open"
---

# BUG-063: Native E2E uses excessive skip gates masking regressions

## Description

62 `test.skip` calls across native E2E specs, many data-dependent rather than environment-only. Regressions can disappear as skips instead of surfacing as failures.

## Examples

- "No saved server profiles" in `auth-flow.spec.ts:116`
- "Need at least 2 text channels" in `channel-navigation.spec.ts:26`

## Expected Behavior

Tests should set up their own preconditions (fixtures, seeds) rather than skipping when data isn't present. Environment-only skips (e.g., "no Tauri binary") are acceptable.

## Actual Behavior

Data-dependent skips mean tests silently pass in environments where the preconditions aren't met, hiding real regressions.

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Component:** Native E2E specs (`tests/e2e/native/`)

## Root Cause

Tests were written assuming pre-existing server state rather than creating their own fixtures.

## Fix

1. Categorize skips into environment-only vs data-dependent
2. Convert data-dependent skips to proper test fixtures/setup
3. Remove skips that are no longer needed

## Related

- [[Open Bugs 2]] item 6
- [[BUG-059-native-e2e-unreliable]] (related reliability issue)
