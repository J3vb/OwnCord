---
date: 2026-03-30
severity: "low"
status: "open"
---

# BUG-064: Client integration test coverage thinner than test count suggests

## Description

Client integration coverage is concentrated in a single file (`stores.test.ts`) and some assertions are weak existence checks rather than behavioral validations.

## Steps to Reproduce

1. Review `tests/integration/stores.test.ts`
2. Note weak assertions like `stores.test.ts:202` (existence checks)
3. Compare integration test breadth to client feature surface area

## Expected Behavior

Integration tests should cover cross-module interactions: store ↔ dispatcher, store ↔ API, component ↔ store flows.

## Actual Behavior

Integration layer is one of the thinnest relative to client size. Useful flows are covered but breadth is insufficient.

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Component:** `tests/integration/`

## Root Cause

Integration test development has not kept pace with feature additions.

## Fix

Add integration tests for:
- Dispatcher → store state propagation (WS events)
- API call → store update → component re-render flows
- DM lifecycle (open → message → close)
- Voice session lifecycle integration

## Related

- [[Open Bugs 2]] item 7
