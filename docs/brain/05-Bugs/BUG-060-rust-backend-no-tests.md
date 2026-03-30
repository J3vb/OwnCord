---
date: 2026-03-30
severity: "medium"
status: "open"
---

# BUG-060: Rust backend has zero behavioral test coverage

## Description

`cargo test` passes but runs 0 tests. The Rust test tier currently only proves the code compiles, not that it behaves correctly.

## Steps to Reproduce

1. Run `cargo test` in `Client/tauri-client/src-tauri`
2. Observe "0 tests run" in output

## Expected Behavior

Rust backend should have unit tests covering key behaviors (TOFU pinning, proxy logic, PTT, IPC commands).

## Actual Behavior

Zero tests exist. `cargo test` passes vacuously.

## Environment

- **OS:** Windows
- **Client:** Tauri v2 (Rust backend)
- **Component:** `src-tauri/src/`

## Root Cause

No test files have been written for the Rust backend code.

## Fix

Add behavioral tests for critical Rust modules:
- `ptt.rs` — PTT key state polling
- `livekit_proxy.rs` — TLS proxy + TOFU pinning
- `ws_proxy.rs` — WebSocket proxy connect/timeout
- IPC command handlers

## Related

- [[Open Bugs 2]] item 3
