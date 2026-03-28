# Open Bugs

Bug tracker for the OwnCord project.

## Active

### Critical

(none)

### High

- **BUG-046**: Invalid saved audio device crashes voice join — `livekitSession.ts` calls `switchActiveDevice` for saved input/output after connect; if the saved device ID no longer exists, the exception bubbles to the outer try-catch and triggers `leaveVoice(false)`. Users cannot join voice until they manually clear prefs. Fix: wrap each `switchActiveDevice` in isolated try-catch with fallback to default device.
- **BUG-047**: Orphaned file uploads on send — `MessageInput.ts` `handleSend()` calls `clearPendingAttachments()` even if uploads are still in flight. The upload resolves but can't attach to any message, leaving unreferenced files on the server. Also happens when a user removes a preview mid-upload. Fix: block send until uploads complete, or cancel in-flight uploads on clear.
- **BUG-048**: No client-side file size/type validation (paste path) — `MessageInput.ts` has no size/type check before `onUploadFile`. The `accept` attribute only affects the file picker, not clipboard paste. Pasting a huge file reads it into memory (`readFileAsDataUrl`) and attempts upload, which can hang the UI. Fix: add size check (match server's 100MB limit) and type allowlist before preview/upload.

### Medium

- **BUG-049**: VAD breaks when app is backgrounded — `livekitSession.ts` VAD uses `requestAnimationFrame` which pauses when the Tauri window is minimized or behind other windows. Mic state gets stuck in whatever it was when backgrounded. Fix: migrate to `AudioWorklet` (see TODOS.md).
- **BUG-050**: Auto-reconnect doesn't clear stale audio elements — on unexpected voice disconnect, `remoteMicAudioElements` and `screenshareAudioElements` are not cleaned up. If LiveKit doesn't emit unsubscribe events before disconnect, elements accumulate across reconnects (DOM/memory leak, possible duplicate audio). Fix: clear audio element maps at the start of auto-reconnect.
- **BUG-051**: LiveKit proxy HTTP path has no origin check — `Server/api/livekit_proxy.go` WS path checks `OriginPatterns`, but the HTTP reverse proxy path (`httputil.ReverseProxy`) has no origin enforcement. If LiveKit exposes admin/metrics endpoints on the same port, they become reachable via the unauthenticated proxy. Fix: add origin check or path allowlist to HTTP proxy handler.
- **BUG-052**: Swallowed `.catch(() => {})` in voice code — 6 instances in `livekitSession.ts` where errors are silently dropped (`room.disconnect`, `room.startAudio`, `replaceTrack`, `stop_livekit_proxy`). Makes debugging connection issues very hard. Fix: replace with `log.debug`/`log.warn` with context.
- **BUG-053**: LiveKit TLS proxy has no TOFU fingerprint pinning — `livekit_proxy.rs` `InsecureVerifier` accepts ALL server certs without validation, unlike `ws_proxy.rs` which does TOFU pinning. A network MitM could intercept LiveKit signaling. Fix: add TOFU fingerprint check using the cert store from `ws_proxy.rs`. Documented in DEC-010.
- **BUG-054**: No account deletion — users cannot delete their own account. No server API endpoint or client UI exists. GDPR concern for EU users. Fix: add `DELETE /api/v1/auth/account` endpoint + confirmation UI in AccountTab.

### Low

- **BUG-055**: 4 stale vitest coverage exclusions — `vitest.config.ts` excludes files that may no longer need exclusion. Cleanup: review each exclusion, remove stale entries, verify coverage stays above 80%.
- **BUG-056**: `livekit-session.test.ts:434` proxy URL test failure — unit test for LiveKit proxy URL construction fails. Needs investigation of expected vs actual URL format.

## Resolved

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
