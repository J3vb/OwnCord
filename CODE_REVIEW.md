# Code Review Findings (2026-03-16)

Scope: server (Go), Tauri client (TS/Rust), spec/docs.
No tests run.

> **Status: ALL RESOLVED** (2026-03-16).
> Commits: `0680a32`, `0bd9165`, `642cd54`.

## Critical

1. Auth bypass: any client can `channel_focus` any channel
   and REST returns data without permission checks.
   Impact: cross-channel data exposure.
   Fix: enforce `READ_MESSAGES` on focus, GET channels,
   messages, and search; track access in hub routing.
2. WS auth failure mismatch: server sends `type: "error"`
   with `AUTH_ERROR`; client expects `auth_error` type.
   Impact: infinite reconnect with bad token.
   Fix: emit `auth_error` per spec; client stops on it.
3. Member/role protocol mismatch: server sends flat
   `member_join` with `role_id`; client expects nested
   `payload.user` with role string.
   Impact: runtime crash on join, wrong role display.
   Fix: align payloads to `UserWithRole` shape.
4. `chat_message` omits `attachments`; client iterates
   it unconditionally. Impact: crash on render.
   Fix: always include `attachments: []` in payloads.

## High

1. REST message/search responses diverge from API spec.
   Missing `user` object, attachments, reactions, pinned,
   deleted fields. Impact: clients mis-parse data.
   Fix: update handlers/queries to match spec shapes.
2. Health endpoint mismatch: server `/health`, client
   `/api/v1/health`, docs `/api/health`.
   Impact: health checks always fail.
   Fix: pick one canonical path, update all.
3. Attachments parsed on `chat_send` but never persisted.
   Impact: attachments silently dropped.
   Fix: validate IDs, persist, include in responses.

## Medium

1. WS heartbeat `ping` treated as unknown by server.
   Impact: noisy error logs.
   Fix: add `ping` handler or disable client heartbeat.
2. API base path inconsistent: docs say `/api`, code
   uses `/api/v1`. Impact: wrong integration URLs.
   Fix: pick one path, update code and docs.

**Low**

1. `auth_ok` does not include role, but UI expects role-based color coding. Even if `member_join` and `ready` are fixed, initial auth state will still lack role. Impact: inconsistent role display until ready arrives. Evidence: `D:\Local-Lab\Coding\Repos\OwnCord\Server\ws\serve.go:171-191`, `D:\Local-Lab\Coding\Repos\OwnCord\Client\tauri-client\src\lib\types.ts:163-167`, `D:\Local-Lab\Coding\Repos\OwnCord\Client\tauri-client\src\lib\dispatcher.ts:55-63`. Recommendation: include role in `auth_ok` or adjust client to tolerate missing role until ready.

**Test Gaps**

1. No automated coverage for authorization of channel read access (REST and WS channel focus). Given the permission system, this should have dedicated tests to prevent regressions. Suggested targets: `D:\Local-Lab\Coding\Repos\OwnCord\Server\api\channel_handler_test.go` and WS tests in `D:\Local-Lab\Coding\Repos\OwnCord\Server\ws\handlers_test.go`.
2. No contract tests asserting server responses match `API.md` and `PROTOCOL.md`. The current drift would have been caught by simple golden tests.
