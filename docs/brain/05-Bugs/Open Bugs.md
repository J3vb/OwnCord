# Open Bugs

Bug tracker for the OwnCord project.

## Active

### Critical

(none)

### High

(none)

### Medium

(none)

### Low

(none)

## Resolved

- **BUG-054**: No account deletion — fixed 2026-03-28
  - Server: `DELETE /api/v1/auth/account` with password confirmation. Anonymizes user (username → `[deleted-{id}]`, clears password/avatar/TOTP, bans row). Soft-deletes messages, removes sessions/DM participation/reactions/read states. Blocks last-admin deletion.
  - Client: "Danger Zone" section in AccountTab with inline confirmation (password required). Post-deletion clears auth, disconnects WS, navigates to connect page.
- **BUG-046**: Invalid saved audio device crashes voice join — fixed 2026-03-28
  - Wrapped each `switchActiveDevice` in isolated try-catch with fallback to default device
- **BUG-047**: Orphaned file uploads on send — fixed 2026-03-28
  - Added `pendingUploadCount` tracking; `handleSend()` blocks until uploads complete
- **BUG-048**: No client-side file size/type validation (paste path) — fixed 2026-03-28
  - Added 100MB size limit and MIME type allowlist before `readFileAsDataUrl` on paste
- **BUG-049**: VAD breaks when app is backgrounded — fixed 2026-03-28
  - Replaced `requestAnimationFrame` with `setTimeout(poll, 16)` so VAD continues when minimized
- **BUG-050**: Auto-reconnect doesn't clear stale audio elements — fixed 2026-03-28
  - Added `remoteMicAudioElements`/`screenshareAudioElements` cleanup in `handleDisconnected()`
- **BUG-051**: LiveKit proxy HTTP path has no origin check — fixed 2026-03-28
  - Added `isOriginAllowed` check + path deny-list (`/admin`, `/metrics`, `/debug`, `/twirp`)
- **BUG-052**: Swallowed `.catch(() => {})` in voice code — fixed 2026-03-28
  - Replaced 6 silent catches with descriptive `log.warn`/`log.debug` messages
- **BUG-053**: LiveKit TLS proxy has no TOFU fingerprint pinning — fixed 2026-03-28
  - `livekit_proxy.rs` now uses `PinnedVerifier` with SHA-256 TOFU fingerprint check
- **BUG-055**: 4 stale vitest coverage exclusions — fixed 2026-03-28
  - Removed exclusions for `audio.ts`, `vad.ts`, `webrtc.ts`, `voiceSession.ts` (files deleted)
- **BUG-056**: `livekit-session.test.ts:434` proxy URL test failure — fixed 2026-03-28
  - Added `@tauri-apps/api/core` mock for `start_livekit_proxy`; fixed expected URL format

- **BUG-057**: CSS injection via custom theme JSON — fixed 2026-03-28
  - `lib/themes.ts` accepted arbitrary CSS values from user-uploaded theme JSON without sanitization. Malicious theme could inject CSS expressions. Fix: added CSS value sanitization before DOM injection.

- **BUG-039**: `switchOutputDevice` early return on partial failure — fixed 2026-03-18
  - Replaced `return` with error tracking; all elements attempted before reporting
- **BUG-040**: Stale `onErrorCallback` after MainPage destroy — fixed 2026-03-18
  - Added `clearOnError()` export; MainPage calls it on destroy to prevent stale refs
- **BUG-041**: Voice store `resetStore` missing new fields in tests — fixed 2026-03-18
  - Added `localCamera`/`localScreenshare` to resetStore; tests for setLocalCamera,
    setLocalScreenshare, setLocalSpeaking
- **BUG-042**: `updateUser` and UserBar option callbacks untested — fixed 2026-03-18
  - Added updateUser tests to auth.store.test.ts; added mute/deafen callback tests
    to user-bar.test.ts
- **BUG-043**: `switchInputDevice` triggers `getUserMedia` with no session — fixed 2026-03-18
  - Added `webrtcService === null` guard; skips mic acquisition when not in voice
- **BUG-044**: `confirm()` blocks Tauri WebView renderer — fixed 2026-03-18
  - Replaced synchronous `confirm()` with double-click-to-delete pattern using toast
- **BUG-045**: Image `att.url` not scheme-validated — fixed 2026-03-18
  - Added `isSafeUrl()` check; only http/https URLs render as images

- **BUG-031**: VoiceAudioTab device selection not applied to WebRTC — fixed 2026-03-18
  - Added `switchInputDevice`/`switchOutputDevice` to voiceSession; VoiceAudioTab
    calls on change
- **BUG-032**: No WS handlers for channel_create/update/delete — closed 2026-03-18
  - Handlers wired in dispatcher.ts:173-200; `wireDispatcher` called in main.ts:141
- **BUG-033**: No WS handlers for member_update/member_ban — closed 2026-03-18
  - Handlers wired in dispatcher.ts:219-229; `wireDispatcher` called in main.ts:141
- **BUG-034**: InviteManager mutates state before API resolves — closed 2026-03-18
  - Filter is inside `.then()` — only runs after promise resolves
- **BUG-035**: DmSidebar active highlight never updates — fixed 2026-03-18
  - Click handler now removes `.active` from siblings and adds to clicked item
- **BUG-036**: WebRTC failure silently disconnects user — fixed 2026-03-18
  - Added `setOnError` callback pattern; MainPage wires it to toast

- **BUG-026**: Image attachments render placeholder, not actual images — fixed 2026-03-18
  - Replaced placeholder `<div>` with `<img src=att.url>` + error fallback
- **BUG-030**: Orphaned MessageActionsBar + ReactionBar components — fixed 2026-03-18
  - Deleted dead code: both components and their tests (never imported anywhere)

- **BUG-024**: Reactions cannot be removed — fixed 2026-03-18
  - Toggles `reaction_add`/`reaction_remove` based on `me` field per PROTOCOL.md
- **BUG-028**: Message delete fires with no confirmation — fixed 2026-03-18
  - Added `confirm()` guard before sending `chat_delete`; success toast added
- **BUG-029**: Message edit sends without validation — fixed 2026-03-18
  - Added empty-check, no-op detection, and toast feedback
- **BUG-037**: Reaction rate limit silently swallows clicks — fixed 2026-03-18
  - Shows error toast when rate limited
- **BUG-038**: No toasts for chat edit/delete/reaction operations — fixed 2026-03-18
  - Added success toasts for delete and edit; error toast for rate-limited reactions

- **BUG-021**: Camera toggle hardcoded to `enabled: false` — fixed 2026-03-18
  - Added `localCamera` state to voice store; toggle reads actual state
- **BUG-022**: Screenshare handler completely empty — fixed 2026-03-18
  - Added `localScreenshare` state; sends `voice_screenshare` WS message
- **BUG-023**: UserBar mute/deafen buttons have no event listeners — fixed 2026-03-18
  - Added `UserBarOptions` interface; MainPage passes mute/deafen handlers
- **BUG-027**: VAD speaking state never sent to server — fixed 2026-03-18
  - Wired `vadDetector.onSpeakingChange` → `setLocalSpeaking` in voice store

- **BUG-020**: Account settings do nothing — fixed 2026-03-18
  - Wired `api.changePassword()` and `api.updateProfile()` into MainPage callbacks
  - Added `updateUser()` to auth store for username sync after profile edit
  - Added toast feedback for success/error on both operations
- **BUG-025**: Theme changes don't sync to uiStore — fixed 2026-03-18
  - Added `setTheme(name)` call in AppearanceTab click handler
  - Store now stays in sync with localStorage and applied CSS

- **BUG-001**: NilHub tests pass mockHub not nil — fixed 2026-03-18 (#12)
  - Added nil hub tests for PatchUser ban and role change paths
- **BUG-002**: window-state.ts untyped `any` — fixed (already resolved) (#10)
  - Code already uses proper types (`Record<string, unknown>`, `typeof import(...)`)
  - No `any` or `getInvoke()` pattern found — was fixed in a prior refactor

- **BUG-003**: Hub double-close panic — fixed 2026-03-17 (issue #3)
  - Added `sync.Once` guard on quit channel close
- **BUG-004**: golangci-lint version incompatibility — fixed 2026-03-17 (issue #4)
  - Pinned compatible linter version in CI
- **BUG-005**: SearchMessages missing validation — fixed 2026-03-17 (issue #5)
  - Added input length and channel access checks
- **BUG-006**: InviteManager unhandled rejections — fixed 2026-03-17 (issue #6)
  - Wrapped async calls with proper error handling
- **BUG-007**: Test schema missing columns — fixed 2026-03-17 (issue #7)
  - Synced test fixtures with production schema
- **BUG-008**: Capacity over-allocation in
  getReactionsBatch — fixed 2026-03-17 (#9)
  - Corrected slice capacity to match actual batch size
- **BUG-009**: golangci-lint violations blocking CI — fixed 2026-03-17 (issue #13)
  - Resolved all outstanding lint errors
- **BUG-010**: buildReady() silent hang — fixed 2026-03-17 (T-038)
  - Server now sends INTERNAL error to client on buildReady failure
- **BUG-011**: Banned user keeps chatting — fixed 2026-03-17 (T-044)
  - Added ban check to periodic session validation in WS handler
- **BUG-012**: Reaction error DB leak — fixed 2026-03-17 (T-039)
  - Sanitized error messages, raw DB errors logged server-side only
- **BUG-013**: WS proxy no connect timeout — fixed 2026-03-17 (T-046)
  - Added 10s connect timeout to Rust WS proxy
- **BUG-014**: Channel delete stale view — fixed 2026-03-17 (T-045)
  - Client auto-redirects to first text channel on active channel deletion
- **BUG-015**: Missing rate limits on chat_edit/chat_delete — fixed 2026-03-17 (#18)
  - Added rate limiting to edit and delete message endpoints
- **BUG-016**: Cert mismatch event not handled — fixed 2026-03-17 (#19)
  - TOFU flow now properly handles certificate mismatch events
- **BUG-017**: SHA-256 fingerprint validation incorrect — fixed 2026-03-17 (#20)
  - Fixed fingerprint comparison logic in cert pinning
- **BUG-018**: Session+ban query N+1 — fixed 2026-03-17 (#21)
  - Optimized with JOIN query instead of separate lookups
- **BUG-019**: Channel position sorting broken — fixed 2026-03-17 (#22)
  - Channels now sort correctly by position field
