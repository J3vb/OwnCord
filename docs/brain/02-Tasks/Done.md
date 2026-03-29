# Done

Completed tasks for the OwnCord project.

## Code Quality & Refactoring (2026-03-29)

- [x] **T-190:** Propagate `context.Context` from WS upgrade through all handlers — added `ctx context.Context` field to Client struct (set from `r.Context()` on WS upgrade), updated `MessageHandler` type signature, threaded ctx through all 17 WS handlers across 9 files (chat, presence, reaction, voice, ping). Added `ExecContext`/`QueryRowContext`/`QueryContext`/`BeginTx` context-accepting methods to DB wrapper. Go build + all ws/api/auth/db tests pass — completed 2026-03-29
- [x] **T-191:** Add ESLint v9 config for TypeScript client — installed eslint v9.39.4 + typescript-eslint v8.57.2, created flat config (`eslint.config.js`) with `no-floating-promises`, `no-unused-vars`, `consistent-return` as errors. Fixed 61 violations across 22 source files: 15 unused imports/vars removed, 5 floating promises fixed with `void`, 4 `let` → `const`, 2 missing default returns, unnecessary type assertions, useless escapes. Added `lint`/`lint:fix` npm scripts. Zero errors, 1,353 tests pass — completed 2026-03-29

## Refactoring & Tests (2026-03-29)

- [x] **T-184:** Refactor `livekitSession.ts` — removed 267 lines of duplicate audio pipeline code (fields, methods, VAD polling) that duplicated `AudioPipeline` class. All calls now delegate to `_audioPipeline`. File: 1,438 → 1,171 lines. Also upgraded VAD from setTimeout-only fallback to AudioWorklet-first with fallback — completed 2026-03-29
- [x] **T-185:** Add 7 unit tests for delete account UI flow in `settings-overlay.test.ts` — trigger button shows confirmation, cancel hides it, empty password validation, onDeleteAccount callback, disabled state during deletion, error display on failure, input clearing on reopen — completed 2026-03-29

## Security Audit & Hardening (2026-03-29)

- [x] **T-186:** Full-project security + code quality audit — 3 parallel agents (security, Go, TypeScript) + govulncheck + npm audit. Found 0 CRITICAL, 17 HIGH, 24 MEDIUM, 14 LOW — completed 2026-03-29
- [x] **T-187:** Fix 15 Go server review issues — path traversal, goroutine leak, SSE token exposure, username validation, voice cleanup errors, rate limiter bypass, presence validation, non-atomic updates, conn.Write checks, N+1 search, FTS5 errors, CORS warning — completed 2026-03-29
- [x] **T-188:** Fix 12 TypeScript client review issues — Content-Type validation, config race condition, lightbox listener leak, onErrorCallback misuse, as-any casts, acceptInvalidCerts scope, SSRF IPv6 gaps, memoryCache LRU, confirm() replacement, structured logging, OG image SSRF, channelCtrl assertions — completed 2026-03-29
- [x] **T-189:** Fix dependency vulnerabilities — npm audit fix (picomatch + brace-expansion), grpc v1.79.1 → v1.79.3 — completed 2026-03-29

## Core Implementation

- [x] **T-001**: Define WebSocket protocol spec ([[06-Specs/PROTOCOL|PROTOCOL.md]])
  - Full message format, payload shapes, rate limits
- [x] **T-002**: Implement Go server core (REST API, WebSocket Hub, SQLite)
  - All [[06-Specs/API|API.md]] endpoints, hub broadcasting, migrations
- [x] **T-003**: Implement auth system (bcrypt, sessions, invite codes)
  - Password hashing, session tokens, invite code generation/validation
- [x] **T-004**: Implement Tauri v2 client (UI, stores, WebSocket client)
  - Vanilla TypeScript components, reactive stores, WS connection management
- [x] **T-005**: Set up CI pipeline (GitHub Actions: build/test/lint + typecheck/test)
  - Parallel jobs for Go and Node, caching, artifact upload
- [x] **T-006**: Remove legacy WPF client code — completed 2026-03-17
  - Cleaned up all remaining WPF artifacts and references

## PR #2 Review Fixes (2026-03-17)

- [x] **T-007**: Fix Hub double-close panic (issue #3) — completed 2026-03-17
  - Added `sync.Once` guard to prevent double-close on quit channel
- [x] **T-008**: Fix golangci-lint version incompatibility (issue #4) — 2026-03-17
  - Pinned linter version compatible with project Go version
- [x] **T-009**: Add SearchMessages input validation (issue #5) — completed 2026-03-17
  - Validate query length and channel access before executing search
- [x] **T-010**: Fix InviteManager promise rejections (issue #6) — completed 2026-03-17
  - Added proper error handling for async invite operations
- [x] **T-011**: Fix test schema missing columns (issue #7) — completed 2026-03-17
  - Aligned test fixture schema with production migrations
- [x] **T-012**: Fix capacity over-allocation in getReactionsBatch (#9) — 2026-03-17
  - Corrected slice capacity calculation to match actual result size
- [x] **T-013**: Resolve all golangci-lint issues (issue #13) — completed 2026-03-17
  - Fixed all linter violations blocking CI
- [x] **T-014**: GitHub community templates and CI optimization — completed 2026-03-17
  - Added issue/PR templates, optimized workflow caching

## CEO Review Fixes (2026-03-17) — [[04-Decisions/DEC-006-ceo-review-fix-list|DEC-006]]

- [x] **T-015**: Server test coverage raised to 80%+ — completed 2026-03-17
  - ws: 55.5% → 80.9%, admin: 50.3% → 81.7%, api: 79.5% → 83.4%
  - Merge blocker resolved per [[04-Decisions/DEC-005-merge-blocked-on-coverage|DEC-005]]
- [x] **T-037**: Move settings cache from package globals to Hub struct — 2026-03-17
- [x] **T-038**: Send error message on buildReady() failure — 2026-03-17
- [x] **T-039**: Sanitize reaction error messages — 2026-03-17
- [x] **T-040**: Fix edit broadcast failure notification — 2026-03-17
- [x] **T-041**: Add slog.Error to channel_handler.go and invite_handler.go — 2026-03-17
- [x] **T-042**: Implement TOFU cert pinning (Rust + TypeScript) — 2026-03-17
- [x] **T-043**: Normalize reaction error responses (IDOR prevention) — 2026-03-17
- [x] **T-044**: Add ban check to periodic session validation — 2026-03-17
- [x] **T-045**: Auto-redirect when active channel is deleted — 2026-03-17
- [x] **T-046**: Add connect timeout to Rust WS proxy — 2026-03-17
- [x] **T-047**: Add index on channel_overrides(channel_id, role_id) — 2026-03-17
- [x] **T-048**: Add broadcast buffer overflow logging — 2026-03-17

## PR #2 Review Backlog Cleanup (2026-03-17)

- [x] **T-016**: Add ClientCount to HubBroadcaster — 2026-03-17 (issue #8)
- [x] **T-017**: Fix window-state.ts untyped any — 2026-03-17 (issue #10)
- [x] **T-018**: Replace custom contains with strings.Contains — (issue #11)
- [x] **T-019**: Fix NilHub tests using mockHub not nil — (issue #12)

## PR #15 Review Fixes (2026-03-17)

- [x] **T-059**: Fix all 8 GitHub issues (#16-#23) to unblock PR #15 — 2026-03-17
  - #16: golangci-lint CI blockers resolved
  - #17: Added KeybindsTab/LogsTab unit tests
  - #18: Rate limiting for chat_edit/chat_delete endpoints
  - #19: Cert mismatch event handling in TOFU flow
  - #20: SHA-256 fingerprint validation fix
  - #21: Session+ban JOIN query optimization
  - #22: Channel position sorting fix
  - #23: Admin test file renames for consistency

## Features & Polish (2026-03-18)

- [x] **T-064**: Integrate FileUpload into MessageInput — 2026-03-18
  - Clipboard paste, attach button, preview bar, native save dialog
- [x] **T-069**: Fix deafen implementation — 2026-03-18
  - replaceTrack(null) muting, deafen+mute linked, icons
- [x] **T-070**: Wire AudioManager to VoiceAudioTab — 2026-03-18
  - Re-apply mute state after device switch
- [x] **T-074**: Add toast/error for silent voice disconnect — 2026-03-18
  - WebRTC failure now shows error toast
- [x] **T-076**: Channel management — 2026-03-18
  - Create/edit/delete modals, context menu, drag reorder
- [x] **T-077**: Server category-type validation — 2026-03-18
  - Text channels only under text categories, voice under voice
- [x] **T-078**: File upload server endpoint — 2026-03-18
  - POST /api/v1/uploads, GET /api/v1/files/{id}, magic-byte validation
- [x] **T-079**: URL previews and YouTube embeds — 2026-03-18
  - OG metadata extraction, YouTube oEmbed, iframe player
- [x] **T-080**: Emoji search by keyword — 2026-03-18
  - 160+ emoji mapped to searchable names
- [x] **T-081**: Image lightbox with zoom/pan — 2026-03-18
  - Click-to-zoom, scroll wheel, drag pan, keyboard shortcuts
- [x] **T-082**: Persistent image cache (IndexedDB) — 2026-03-18
  - Three-layer cache: memory, IndexedDB, network
- [x] **T-083**: Native file download dialog — 2026-03-18
  - tauri-plugin-dialog + tauri-plugin-fs for save-as
- [x] **T-084**: Disable browser context menu — 2026-03-18
  - Global contextmenu preventDefault, custom menus only
- [x] **T-085**: Fix message sort order — 2026-03-18
  - Reverse server DESC order to chronological, scroll to bottom
- [x] **T-086**: Voice mute/deafen UX — 2026-03-18
  - Deafen mutes mic, unmute unmutes both, crossed icons

## Voice & Audio Overhaul (2026-03-18)

- [x] **T-087**: Fix voice chat over NAT — 2026-03-18
  - Added Google public STUN, fixed signaling race on join
- [x] **T-088**: Fix GainNode silence — 2026-03-18
  - WebView2 silences WebRTC streams through Web Audio pipeline;
    switched to direct `<audio>` playback ([[04-Decisions/DEC-008-direct-audio-playback|DEC-008]])
- [x] **T-089**: replaceTrack for device switching — 2026-03-18
  - Seamless track swap without SDP renegotiation
- [x] **T-090**: Fix speaking indicator flicker — 2026-03-18
  - setSpeakers skips local user; local VAD is sole authority
- [x] **T-091**: Safe switchInputDevice with rollback — 2026-03-18
  - Stop old tracks only after new pipeline is fully wired
- [x] **T-092**: clearAuth voice session cleanup — 2026-03-18
  - leaveVoice(false) called before resetVoiceStore
- [x] **T-093**: VAD 48kHz sample rate fix — 2026-03-18
  - Force 48kHz AudioContext; was using system 192kHz
- [x] **T-094**: CSP wasm-unsafe-eval for RNNoise — 2026-03-18
  - WASM compilation requires wasm-unsafe-eval in script-src
- [x] **T-095**: ICE rate limit separation — 2026-03-18
  - ICE candidates at 50/s; was sharing 20/s with offers
- [x] **T-096**: Comprehensive voice debug logging — 2026-03-18
  - Client: WebRTC, VAD, audio, noise suppression, voiceSession
  - Server: SFU, RTP forwarding, voice room, ICE candidates
- [x] **T-097**: Logs tab Copy All + Voice Diagnostics — 2026-03-18
  - Copy All, diagnostics panel, Probe Audio Levels, Direct Playback test
- [x] **T-098**: Per-user volume context menu in sidebar — 2026-03-18
  - Was only in unused VoiceChannel component; added to ChannelSidebar

## Server Review & Admin Panel (2026-03-19)

- [x] **T-099**: Go server code review — 4 passes, 19 fixes — 2026-03-19
  - CRIT: header injection; HIGH: hub shutdown, double send, nil panic,
    ErrNoRows, RTP leak; MEDIUM: 12 fixes (rows.Err, IPv6, io.Copy,
    batch perms, settings tx, etc.); Final verdict: APPROVE
- [x] **T-100**: Admin panel redesign from mockup — 2026-03-19
  - Discord-style dark theme, stat cards, modals, toast notifications
  - All 7 sections: Dashboard, Users, Channels, Audit, Settings, Backups, Updates
- [x] **T-101**: Live server log streaming — 2026-03-19
  - RingBuffer (2000 entries) + MultiHandler (tees slog to stdout + buffer)
  - SSE endpoint /admin/api/logs/stream with auth + keepalive
  - Viewer: level filters, search, auto-scroll, pause/resume, copy, clear
- [x] **T-102**: Audit log filters and export — 2026-03-19
  - Search, action type dropdown, Copy All, Export CSV
- [x] **T-103**: Console output cleanup — 2026-03-19
  - JSON to human-readable text (slog.TextHandler), banner before init logs
- [x] **T-104**: Fix 3 pre-existing test failures — 2026-03-19
  - handleVoiceICE no-PC, GetAttachmentByID not-found convention
- [x] **T-105**: Documentation update for v1.0.0 release — 2026-03-19
  - Session log, Dashboard, Requirements, README, CLAUDE.md, Done.md

## Phase 1 Stabilization — Bug Fixes & Dead Features (2026-03-21)

- [x] **T-033**: Fix voice state broadcast silent DB failures — 2026-03-21
  - broadcastVoiceStateUpdate now sends error to client on DB failure
- [x] **T-034**: Fix file storage partial write cleanup — 2026-03-21
  - os.Remove error now logged via slog.Error instead of swallowed
- [x] **T-053**: Voice leave ghost session cleanup — 2026-03-21
  - DB failure now logged with ghost-session warning + client notified
- [x] **T-054**: Dispatcher payload validation — 2026-03-21
  - Added hasFields() runtime validator to 7 critical WS handlers
- [x] **T-072**: Fix Arrow-up edit-last-message listener — 2026-03-21
  - Wired listener in ChannelController to find last user message and start edit
- [x] **T-066**: Add pin button to message action bar — 2026-03-21
  - Pin/unpin toggle in action bar, optimistic store update, toast feedback
- [x] **T-067**: Wire MemberList context menu to AdminActions — 2026-03-21
  - Right-click context menu on members (admin/owner only), kick/ban/role change
  - Added adminKickMember, adminBanMember, adminChangeRole to API client

## Phase 2 Stabilization — Server Reliability & Correctness (2026-03-21)

- [x] **T-031**: hub.GracefulStop() already called in main.go — verified 2026-03-21
- [x] **T-032**: Add panic recovery wrapper around Hub.Run() — 2026-03-21
  - Defer/recover with 5-in-60s panic threshold, full stack trace logging
- [x] **T-035**: Add WS invalid payload counter — 2026-03-21
  - Client kicked after 10 consecutive invalid JSON messages
- [x] **T-106**: Typed message structs in Go — 2026-03-21
  - 19 buildXxx functions refactored from map[string]any to typed structs
  - 18 payload structs with json tags matching PROTOCOL.md
- [x] **T-107**: Sentinel errors in db package — 2026-03-21
  - ErrNotFound, ErrForbidden, ErrConflict, ErrBanned sentinel errors
  - Wrapped in EditMessage, DeleteMessage, RemoveReaction, UseInviteAtomic, GetSetting
- [x] **T-108**: SQLite pragma tuning — 2026-03-21
  - synchronous=NORMAL, temp_store=MEMORY, mmap_size=256MB, cache_size=64MB
  - PRAGMA optimize on Close()
- [x] **T-052**: Batch permission query — verified already done 2026-03-21
- [x] **T-109**: Server graceful shutdown with connection draining — 2026-03-21
  - BroadcastServerRestart on shutdown, 5s grace period, force-close remaining

## Phase 3 Stabilization — Client Reliability & Performance (2026-03-21)

- [x] **T-110**: Disposable component lifecycle pattern — 2026-03-21
  - Created Disposable class with addCleanup, onStoreChange, onEvent, onInterval
  - Migrated MemberList, TypingIndicator, UserBar to use it
- [x] **T-056**: Cap messages store per channel — 2026-03-21
  - MAX_MESSAGES_PER_CHANNEL = 500, eviction in addMessage, setMessages, prependMessages
  - Sets hasMore=true when eviction occurs for seamless scroll-up fetch
- [x] **T-055**: Orphaned attachment cleanup job — 2026-03-21
  - DeleteOrphanedAttachments DB method + file cleanup on 15-min maintenance ticker
  - 1-hour cutoff to avoid deleting in-flight uploads
- [x] **T-111**: Virtual scrolling — verified already implemented 2026-03-21
- [x] **T-112**: Lazy loading — verified already implemented 2026-03-21

## Phase 4 Stabilization — Protocol & Reconnection (2026-03-21)

- [x] **T-113**: Sequence numbers on server broadcasts — 2026-03-21
  - Atomic seq counter on Hub, wrapWithSeq JSON injection, 1000-event ring buffer
  - All broadcasts now carry monotonic `seq` field
- [x] **T-114**: Client reconnection with state recovery — 2026-03-21
  - Client tracks lastSeq, sends last_seq in auth on reconnect
  - Server replays missed events from ring buffer; falls back to full ready if too old
  - No member_join re-broadcast on successful replay
- [x] **T-115**: Server-side heartbeat monitoring — 2026-03-21
  - lastActivity timestamp per client, updated on every received message
  - 30s sweep ticker, 90s stale threshold (3x client ping interval)
  - Ghost connections automatically kicked

## Phase 5 Stabilization — Code Quality & Standards (2026-03-21)

- [x] **T-116**: Structured logging level audit — 2026-03-21
  - Demoted 4 per-message logs from Info→Debug (chat_send, chat_edit, chat_delete, channel_focus)
- [x] **T-036**: Request correlation IDs — 2026-03-21
  - reqLog with user_id, msg_type, req_id in handleMessage dispatch
- [x] **T-050**: Extract WS error constants — 2026-03-21
  - 14 constants in ws/errors.go, 50 inline strings replaced across handlers
- [x] **T-051**: Split large handler files — 2026-03-21
  - voice_handlers.go → voice_join.go, voice_leave.go, voice_controls.go, voice_broadcast.go
  - handlers.go and ConnectPage.ts assessed — already manageable size
- [x] **T-117**: TypeScript strict mode — verified already enabled 2026-03-21
  - Removed 3 unnecessary casts in media.ts and profiles.ts
- [x] **T-049**: Refactor MainPage → sub-orchestrators — 2026-03-21
  - Split 637 lines into MainPage (371) + SidebarArea.ts (211) + ChatArea.ts (196)
- [x] **T-118**: Shared protocol schema — 2026-03-21
  - Created docs/protocol-schema.json with all 36 message types
  - Found 7 client-server drift issues documented in drift_notes
- [x] **T-119**: LiveKit track lifecycle — verified already correct 2026-03-21
- [x] **T-120**: Store shallowEqual comparator — 2026-03-21
  - Map/Set/Array/Object shallow comparison, default for subscribeSelector

## Phase 6 Stabilization — Testing & Verification (2026-03-21)

- [x] **T-121**: WebSocket integration tests — 2026-03-21
  - MessageRoundTrip (2 clients, chat_send → chat_message) + SequenceNumbers test
- [x] **T-122**: LiveKit voice test script — 2026-03-21
  - scripts/voice-test.sh with lk CLI load testing (2 publishers, 10s)
- [x] **T-123**: Tighten Tauri CSP — 2026-03-21
  - Added media-src, font-src, object-src 'none', base-uri 'self'
- [x] **T-057**: Presence update failure ack — 2026-03-21
  - Returns error to client + prevents stale broadcast on DB failure
- [x] **T-075**: Mic permission denial notification — 2026-03-21
  - NotAllowedError/NotFoundError handling with user-friendly error callback

## Phase 7 Stabilization — Polish (2026-03-21)

- [x] **T-073**: Persist LogsTab filter and level preferences — 2026-03-21
  - Filter level + min level saved/restored from localStorage
- [x] **T-058**: Metrics endpoint — 2026-03-21
  - GET /api/v1/metrics (admin IP restricted) with uptime, goroutines, heap, GC, connected users

## Spec Audit, Tests & E2E Overhaul (2026-03-28)

- [x] **T-174**: Spec audit — 18 spec files updated/created, 50 fixes — 2026-03-28
  - 15 existing specs aligned with codebase, 3 new specs created (DM-SYSTEM, THEME-SYSTEM, RECONNECTION)
- [x] **T-175**: 143 new unit tests (Go + TypeScript) — 2026-03-28
  - Go server: handlers, DB, auth, WS test expansion
  - TypeScript client: stores, lib, components vitest coverage
- [x] **T-176**: E2E infrastructure overhaul — 2026-03-28
  - Persistent fixture pattern, login-once auth reuse
  - 22 new mocked E2E specs + 3 native E2E spec files
  - Fixed selectors and assertions for current DOM
- [x] **T-177**: CSS injection security fix in themes.ts — 2026-03-28
  - Sanitize CSS values from user-uploaded theme JSON before DOM injection
- [x] **T-178**: Login rate limit increased 5 -> 60/min — 2026-03-28
  - Unblocks native E2E tests; still provides brute-force protection
- [x] **T-179**: New spec files: DM-SYSTEM, THEME-SYSTEM, RECONNECTION — 2026-03-28
  - DM architecture/auth, theming/CSS injection prevention, reconnection protocol
- [x] **T-180**: E2E-BEST-PRACTICES spec created — 2026-03-28
  - Persistent fixtures, login-once, selector best practices, assertion patterns
- [x] **T-181**: Documentation updates — 2026-03-28
  - CLAUDE.md, Dashboard.md, TESTING-STRATEGY.md, Open Bugs, Done.md
