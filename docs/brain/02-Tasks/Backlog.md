# Backlog

**Goal:** Ship v1.2, then build gaming-native features that
differentiate OwnCord from Discord/TeamSpeak/Mumble.

Last task ID: T-457. New tasks start at T-458.

---

## Core Stability — Bugs Found 2026-03-28 (audit + Codex review)

- [x] **T-165:** Fix BUG-046 — wrap voice `switchActiveDevice` in try-catch with device fallback — 2026-03-28
- [x] **T-166:** Fix BUG-047 — block send until uploads complete or cancel in-flight uploads — 2026-03-28
- [x] **T-167:** Fix BUG-048 — add client-side file size/type validation before upload (incl. paste path) — 2026-03-28
- [x] **T-168:** Fix BUG-049 — migrate VAD from requestAnimationFrame to setTimeout — 2026-03-28
- [x] **T-169:** Fix BUG-050 — clear stale audio elements on voice auto-reconnect — 2026-03-28
- [x] **T-170:** Fix BUG-051 — add origin/path check to LiveKit HTTP proxy handler — 2026-03-28
- [x] **T-171:** Fix BUG-052 — replace swallowed `.catch(() => {})` with debug/warn logging — 2026-03-28
- [x] **T-172:** Fix BUG-053 — add TOFU fingerprint pinning to LiveKit TLS proxy — 2026-03-28
- [x] **T-173:** Fix BUG-054 — implement account deletion (server endpoint + client UI) — 2026-03-28

## Cleanup — Found 2026-03-28

- [x] **T-182:** Fix BUG-055 — remove 4 stale vitest coverage exclusions — 2026-03-28
- [x] **T-183:** Fix BUG-056 — fix livekit-session.test.ts proxy URL test (mock Tauri invoke) — 2026-03-28

## Refactoring

- [x] **T-184:** Refactor `livekitSession.ts` — remove duplicate audio pipeline fields/methods, delegate entirely to `_audioPipeline`. 1,438 → 1,171 lines (267 lines removed) — 2026-03-29
- [x] **T-185:** Add unit tests for delete account UI flow in `settings-overlay.test.ts` — 7 tests: trigger, cancel, password validation, callback, disabled state, error display, input clearing — 2026-03-29

## Code Quality — Found 2026-03-29 (full-project audit)

- [x] **T-190:** Propagate `context.Context` from WS upgrade through all handlers — added ctx to Client struct, updated MessageHandler signature, threaded ctx through all 17 WS handlers across 9 files. Added ExecContext/QueryRowContext/QueryContext/BeginTx to DB wrapper. — 2026-03-29
- [x] **T-191:** Add ESLint v9 config with `@typescript-eslint/no-floating-promises`, `no-unused-vars`, `consistent-return` — installed eslint v9.39.4 + typescript-eslint, created flat config, fixed 61 lint violations across 22 files — 2026-03-29

---

## 2FA Client Integration — 2026-03-29

### High Priority

- [x] **T-192:** Client 2FA enrollment/disable settings UI — AccountTab TOTP section, auth store state, SettingsOverlay wiring — 2026-03-29
- [x] **T-193:** Client 2FA test coverage — Unit tests for TOTP settings flows, api.ts TOTP methods, auth store totp_enabled state — 2026-03-29
- [x] **T-194:** Full regression validation pass — `go test ./...`, `npm test`, `golangci-lint`, `npm run lint` — 2026-03-29

### Medium Priority

- [ ] **T-195:** User profile/password/session management endpoints — PATCH /users/me, PUT /users/me/password, GET/DELETE /users/me/sessions (server-side)
- [ ] **T-196:** DM sidebar incremental DOM update — Replace full DOM rebuild at SidebarArea.ts:753 with reconciliation

## Bugs — 2026-03-29

### High Priority

- [ ] **T-202:** Admin panel tab navigation broken — Clicking Audit Logs, Members, or other tabs in the `/admin` panel does not switch pages. Likely regression from recent `handlers_settings.go` or `logstream.go` changes. Investigate JS console errors and admin static files.

## Code Review Findings — 2026-03-29

### High Priority

- [x] **T-197:** Fix double `updateUser` call on TOTP confirm/disable — Verified false positive: `updateUser` called once in MainPage.ts, `onEnrolled`/`onDisabled` only re-render UI — 2026-03-31
- [x] **T-198:** Add TOTP audit log events — Added `database.LogAudit(...)` calls for totp_verified, totp_enabled, totp_disabled — 2026-03-31
- [x] **T-199:** Safe default for `registration_open` on upgrade — Changed default from `false` to `true` in `isRegistrationOpen()` — 2026-03-31
- [x] **T-200:** Extract TOTP handlers to `totp_handler.go` — Moved 4 handlers + 4 types; auth_handler.go 829 → 583 lines — 2026-03-31

### Medium Priority

- [x] **T-201:** TOTP constant-time code comparison — Replaced `==` with `subtle.ConstantTimeCompare` in `totp.go:207` — 2026-03-31

---

## Project Map Dashboard Enhancements — 2026-03-31

*Transform `tools/project-map/` from a tool you visit into a daily driver.
Eliminate cold-start friction, capture bugs in real-time, automate scans,
and surface trends. See plan in session log for full rationale.*

### Phase PM-1: Morning Experience (the cold-start killer)

- [ ] **T-203:** Briefing as default landing view — Restructure dashboard.html renderSession() to lead with briefing content, not the session card. Briefing should be the top-level content on load.
- [ ] **T-204:** Last session summary inline — Enhance morning-briefing.mjs to include lastSession details: files touched, commits made, duration, modules worked on. Render as compact summary card.
- [ ] **T-205:** "Time since last session" prominent indicator — Upgrade from text greeting to colored badge (green <1d, yellow 2-3d, red >3d) with exact hours/days.
- [ ] **T-206:** Agent results surfaced at top — Move completed agent results above the session plan in briefing. Add result count badge to Session tab label.
- [ ] **T-207:** One-click "Start Session" with plan acceptance — Enhance Start Session button to auto-accept suggested plan. Add plan items to session start POST body.

### Phase PM-2: Bug Capture During Live Testing

- [ ] **T-208:** Persistent quick-add bug bar — Fixed-position bar at dashboard bottom (always visible). Text input + module dropdown + severity selector + submit.
- [ ] **T-209:** Bug creation backend endpoint — `POST /api/bugs` in server.mjs. New lib/bug-writer.mjs for ID generation (next T-XXX), markdown formatting, atomic file write to Backlog.md.
- [ ] **T-210:** Severity tags and auto-tagging — Support crash/broken/cosmetic severity. Auto-add `found-in-testing` tag. Update backlog-parser.mjs to recognize new tags.
- [ ] **T-211:** Mobile-friendly bug capture page — `GET /api/bugs/quick` serves minimal standalone HTML form. Responsive, large touch targets, no navigation chrome.
- [ ] **T-212:** SSE broadcast on bug creation — Broadcast `bug-created` event via SSE. Dashboard refreshes backlog data on receipt.

### Phase PM-3: Proactive Scanning

- [ ] **T-213:** Scan staleness configuration — New `.cache/scan-config.json` with per-scan-type day thresholds (security: 7d, code-review: 14d, debt: 3d, tests: 7d). `POST /api/scan-config` to override.
- [ ] **T-214:** Auto-scan on server start — New lib/scan-scheduler.mjs. On startup, check each module's last scan date against thresholds. Track timestamps in `.cache/scan-history.json`.
- [ ] **T-215:** Scan results auto-create backlog entries — Post-process completed agent results in agent-manager.mjs. Parse for issue indicators, auto-create backlog entries via bug-writer.mjs with `agent-discovered` tag.
- [ ] **T-216:** Dashboard "due scans" indicator — Show count of modules due for scanning in briefing. "Run all due scans" button batch-queues agent jobs for all due modules.

### Phase PM-4: Session Polish

- [ ] **T-217:** Session plan preview with editing — Add checkboxes to plan items. Unchecked items excluded from session. Pass accepted items to `POST /api/session/start` body.
- [ ] **T-218:** Browser tab title with session state — Update `document.title` dynamically. Active: `"▶ 47min | OwnCord"` (60s interval). Idle: `"Project Map | OwnCord"`.
- [ ] **T-219:** Session end summary with improvement metrics — Compute coverage deltas, backlog items closed (from commit task IDs), tests added (git diff stats). Display in summary modal.
- [ ] **T-220:** Smooth session auto-recovery UX — Visible notification bar when stale session detected. "Resume or discard?" with stale session stats (started at, files changed).

### Phase PM-5: Dashboard UX

- [ ] **T-221:** SSE-driven visible updates — Toast notifications on file-change events. Flash Agents tab on job-update. Small event log in header showing last 3 SSE events.
- [ ] **T-222:** Loading states with cached data — Show cached data from localStorage on initial load. Fetch fresh in background, swap in. Show "cached · refreshing..." indicator.
- [ ] **T-223:** Keyboard shortcuts — S: start/end session, Q: focus bug bar, N: Focus Next tab, R: refresh, 1-9: switch tabs. Help overlay on `?` key.
- [ ] **T-224:** Collapsible sections — Toggle buttons (▸/▾) on each card h2. Persist collapsed state in localStorage.
- [ ] **T-225:** Dark theme contrast audit — Verify CSS variables against WCAG AA (4.5:1). Adjust `--text-dim` and other colors if needed.

### Phase PM-6: Agent Workflow Improvements

- [ ] **T-226:** Batch queue endpoint — `POST /api/jobs/batch` with filter criteria (e.g. `coverage_below: 50`). Resolves filter against data, creates one job per matching module.
- [ ] **T-227:** Agent result diffing — Track result metadata (issue count, findings hash) in scan-history.json. Compare previous vs current results. Show added/removed issues in result overlay.
- [ ] **T-228:** Estimated completion indicator — Track actual job durations in scan-history.json per type. Compute rolling average. Display "~3m remaining" on running jobs.
- [ ] **T-229:** Browser notifications on job completion — Request `Notification.permission` on load. Fire `new Notification()` on completed job SSE events. Optional sound toggle.

### Phase PM-7: Data Continuity

- [ ] **T-230:** Weekly summary auto-generation — New lib/weekly-summary.mjs. Aggregate sessions, time, tasks closed, coverage deltas, bugs found. Write to `docs/brain/03-Sessions/weekly-YYYY-WW.md`. Trigger on server start if missing for previous week.
- [ ] **T-231:** Trend lines on dashboard — Mini sparkline charts for coverage, debt, velocity over time. Store historical snapshots in `.cache/trend-data.json` (appended each collectData, max 90 entries).
- [ ] **T-232:** Export/snapshot and restore — `GET /api/export` bundles all .cache/ JSON into single download. `POST /api/import` restores from snapshot. Dashboard button in header.

### Phase PM-8: Small but High-Impact

- [ ] **T-233:** Dynamic favicon — Two inline SVG favicons (cyan active, dim idle). Swap on session state change via `link[rel="icon"]`.
- [ ] **T-234:** "What did I do last week" view — Filtered History tab view for past 7 days. Aggregate files, commits, tasks, coverage changes. Auto-triggered when `daysSince > 1` in briefing.
- [ ] **T-235:** VS Code direct links — Wrap all file path displays (debt markers, churn, coverage) with `vscode://file/${ROOT}/${path}:${line}` links. Pass ROOT from server via `/api/data` response.
- [ ] **T-236:** New files: lib/bug-writer.mjs — Backlog entry creation with atomic writes, next-ID generation, markdown formatting
- [ ] **T-237:** New files: lib/scan-scheduler.mjs — Staleness tracking, threshold config, auto-scan scheduling logic
- [ ] **T-238:** New files: lib/weekly-summary.mjs — Weekly aggregate report generation and vault writing
- [ ] **T-239:** New files: .cache/scan-config.json, scan-history.json, trend-data.json — Persistent state for scanning and trends
- [ ] **T-240:** Dashboard.html size audit — If dashboard exceeds 1500 lines after all phases, split JS into separate file

---

## Unified Sidebar — Deferred Items (from 2026-03-27 redesign)

- [x] **T-161:** Relocate MemberList into unified sidebar as collapsible section — SidebarArea.ts:625-743, with resize handle and localStorage persistence — verified 2026-03-29
- [x] **T-162:** Wire DM conversations to real data source — SidebarArea.ts:408-419 reads from dmStore, renders with status/unread/timestamps — verified 2026-03-29
- [x] **T-163:** Wire quick-switch overlay disconnect/reconnect flow — SidebarArea.ts:844-850, stores target in sessionStorage, calls clearAuth() — verified 2026-03-29
- [x] **T-164:** Add per-server collapsible section state persistence to localStorage — ui.store.ts:124-176, keyed by server hostname — verified 2026-03-29

---

## Phase 1: Fix Bugs & Wire Dead Features

*Everything that's broken or exists but isn't connected.*

### P0 — Bugs & Broken Code

- [x] **T-033**: Fix voice state broadcast silent DB failures — 2026-03-21
- [x] **T-034**: Fix file storage partial write cleanup — 2026-03-21
- [x] **T-053**: Voice leave ghost session cleanup — 2026-03-21
- [x] **T-054**: Dispatcher payload validation — 2026-03-21
- [x] **T-072**: Fix Arrow-up edit-last-message listener — 2026-03-21

### P0 — Dead Features (code exists, not wired)

- [x] **T-066**: Add pin button to message action bar — 2026-03-21
- [x] **T-067**: Wire MemberList context menu to AdminActions — 2026-03-21

---

## Phase 2: Server Reliability & Correctness

*Make the Go server robust and production-grade.*

### P1 — Critical Reliability

- [x] **T-031**: hub.GracefulStop() already called in main.go — verified 2026-03-21
- [x] **T-032**: Add panic recovery wrapper around Hub.Run() — 2026-03-21
- [x] **T-035**: Add WS invalid payload counter — 2026-03-21
- [x] **T-106**: Typed message structs in Go — 2026-03-21
- [x] **T-107**: Sentinel errors in db package — 2026-03-21

### P1 — Performance (free wins)

- [x] **T-108**: SQLite pragma tuning — 2026-03-21
- [x] **T-052**: Batch permission query — verified already done 2026-03-21

### P1 — Graceful Shutdown

- [x] **T-109**: Server graceful shutdown with connection draining — 2026-03-21

---

## Phase 3: Client Reliability & Performance

*Make the client robust for long sessions.*

### P1 — Memory & Lifecycle

- [x] **T-110**: Disposable component lifecycle pattern — 2026-03-21
- [x] **T-056**: Cap messages store per channel (500 max) — 2026-03-21
- [x] **T-055**: Orphaned attachment cleanup job — 2026-03-21

### P2 — Performance

- [x] **T-111**: Virtual scrolling — already implemented (verified 2026-03-21)
- [x] **T-112**: Lazy loading — already implemented (verified 2026-03-21)

---

## Phase 4: Protocol & Reconnection

*Make the WebSocket protocol resilient to disconnects.*

### P1 — Message Delivery Reliability

- [x] **T-113**: Sequence numbers on server broadcasts — 2026-03-21
- [x] **T-114**: Client reconnection with state recovery — 2026-03-21
- [x] **T-115**: Server-side heartbeat monitoring — 2026-03-21

---

## Phase 5: Code Quality & Standards

*Clean up code structure for maintainability.*

### P2 — Server Code Quality

- [x] **T-116**: Structured logging level audit — 2026-03-21
- [x] **T-036**: Add request correlation IDs — 2026-03-21
- [x] **T-050**: Extract WS error constants (14 constants) — 2026-03-21
- [x] **T-051**: Split voice_handlers.go into 4 files — 2026-03-21

### P2 — Client Code Quality

- [x] **T-117**: TypeScript strict mode — already enabled, removed 3 unnecessary casts — 2026-03-21
- [x] **T-049**: Refactor MainPage → ChatArea + SidebarArea — 2026-03-21
- [x] **T-118**: Shared protocol schema + 7 drift issues found — 2026-03-21
- [x] **T-119**: LiveKit track lifecycle — already correct, verified — 2026-03-21

### P2 — Store Improvements

- [x] **T-120**: shallowEqual comparator (Map/Set/Array/Object) — 2026-03-21

---

## Phase 6: Testing & Verification

*Ensure the solid base is verified.*

### P2 — Integration Tests

- [x] **T-121**: WebSocket integration tests — 2026-03-21
- [x] **T-122**: LiveKit voice test script — 2026-03-21

### P3 — Security Hardening

- [x] **T-123**: Tighten Tauri CSP — 2026-03-21
- [x] **T-057**: Presence update failure ack — 2026-03-21
- [x] **T-075**: Mic permission denial notification — 2026-03-21

---

## Phase 7: Polish & Remaining Items

*Nice-to-haves that improve the experience.*

### P3 — Client Polish

- [x] **T-073**: Persist LogsTab filter and level preferences — 2026-03-21
- [x] **T-058**: Metrics endpoint (/api/v1/metrics) — 2026-03-21

---

## Deferred (Pre-Roadmap Features)

*Existing deferred features from stabilization era. Still valid.*

- [ ] **T-059**: Implement User Profile Popup component
- [ ] **T-060**: Implement Friends/DMs View
- [ ] **T-061**: Implement Status Picker component
- [ ] **T-062**: Implement DM Profile Sidebar
- [ ] **T-063**: Implement Soundboard component (protocol types exist, no UI)
- [ ] **T-024**: Implement screen sharing
- [ ] **T-023**: Add TOTP 2FA support — Login challenge flow: DONE; Server enable/confirm/disable endpoints: DONE; Client enrollment UI: IN PROGRESS (see [[02-Tasks/In Progress|T-192]]); Client test coverage: TODO (see T-193)
- [ ] **T-027**: Code signing certificate for SmartScreen
- [ ] **T-028**: Windows Service mode
- [ ] **T-029**: Custom emoji support
- [ ] **T-030**: Client auto-update via Tauri updater

---

## Feature Roadmap — Community Essentials (Phase R1)

*Low effort, high impact. Complete before first public release.*
*See [[00-Overview/Feature-Roadmap]] for full context and research.*

### P2 — Core Community Features

- [ ] **T-124**: Native polls — new `poll` message type with question, options, real-time vote counts via WebSocket
- [ ] **T-125**: Media gallery — per-channel gallery view filtering messages by images/videos/GIFs, grid layout with lightbox
- [ ] **T-126**: Event/session scheduler — "Next LAN Party" scheduler with date, time, RSVP, countdown timer in sidebar
- [ ] **T-127**: Server activity feed — sidebar widget showing recent joins, voice sessions, files shared, milestones
- [ ] **T-128**: Pinned notes — simple markdown pages per channel, wiki-lite for server rules, game configs, network guides

---

## Feature Roadmap — Gaming DNA (Phase R2)

*Revive the Xfire spirit. What made Xfire special, brought to 2026.*
*See [[00-Overview/Feature-Roadmap]] for Xfire research.*

### P2 — Game Integration

- [ ] **T-129**: Game detection + "Now Playing" — Rust-side process scanner detects running games, shows in user status, configurable game library
- [ ] **T-130**: Game time tracking — track playtime per game per user, lifetime stats on profile, server-wide "most played" leaderboard
- [ ] **T-131**: LAN game server browser — mDNS/UDP broadcast auto-discovery of game servers on LAN, show name/map/players/ping, click to join
- [ ] **T-132**: Screenshot capture + gallery — global hotkey to capture screenshot (Rust), auto-upload to channel, shared gallery with captions
- [ ] **T-133**: Friends activity view — "Friends of Friends Playing" tab, see what friends' friends are playing, one-click join or add friend

---

## Feature Roadmap — Voice Power Features (Phase R3)

*Features from TeamSpeak/Mumble that Discord lacks.*
*See [[00-Overview/Feature-Roadmap]] for competitive analysis.*

### P2 — Voice Enhancements

- [ ] **T-134**: Whisper lists — bind hotkey to whisper to specific users/groups across channels, stay in your channel but talk privately
- [ ] **T-135**: Positional/spatial audio — 3D audio positioning based on in-game coordinates, voices from player direction
- [ ] **T-136**: Voice channel nesting — sub-channels within voice channels (Team 1, Team 2), drag-and-drop between sub-channels
- [ ] **T-137**: Priority speaker — designated users talk over others, auto-duck other voices when priority speaker talks

---

## Feature Roadmap — LAN Party Toolkit (Phase R4)

*The killer differentiator. No competitor offers this integrated experience.*
*See [[00-Overview/Feature-Roadmap]] for LAN party tool research.*

### P3 — LAN Party Features

- [ ] **T-138**: Tournament brackets — single/double elimination, round robin, Swiss, auto-generated schedule, report results in-chat, live bracket display
- [ ] **T-139**: Seat map — visual seat map for venue, claim/reserve seats, see who sits where, show online status per seat
- [ ] **T-140**: Local leaderboard — per-event scoring across games, configurable points system, live leaderboard widget
- [ ] **T-141**: LanCache status widget — integration with LanCache.NET, show cache hit rate, downloaded games, bandwidth saved
- [ ] **T-142**: Shared music queue — collaborative playlist for venue, vote to skip, "now playing" display

---

## Feature Roadmap — Platform & Extensibility (Phase R5)

*Turn OwnCord from a product into a platform.*
*See [[00-Overview/Feature-Roadmap]] for platform research.*

### P3 — Extensibility

- [ ] **T-143**: Custom themes — theme engine with CSS variables, community theme sharing, dark/light/custom palettes
- [ ] **T-144**: Webhook integrations — incoming webhooks (post from external services), outgoing webhooks (trigger actions on events)
- [ ] **T-145**: Bot framework — bot accounts via REST API, slash commands, interactive messages, scheduled tasks
- [ ] **T-146**: Plugin system — server-side (Go) + client-side (TypeScript) plugins, API for custom channel types and widgets
- [ ] **T-147**: Backup/restore — one-command backup of SQLite DB + uploads + config, restore to new machine, scheduled backups
- [ ] **T-148**: Admin monitoring dashboard — CPU, RAM, disk, connected users, voice channels, bandwidth, Prometheus export

---

## Feature Roadmap — Future Vision (Phase R6)

*Exploratory. Emerging tech for long-term differentiation.*
*See [[00-Overview/Feature-Roadmap]] for trend research.*

### P4 — Exploratory

- [ ] **T-149**: AI noise cancellation — on-device noise suppression using lightweight ML models, no cloud dependency
- [ ] **T-150**: Real-time voice translation — AI-powered live translation between languages in voice chat
- [ ] **T-151**: In-game overlay — transparent overlay with voice controls, chat, FPS/ping via Rust DirectX/Vulkan hooks
- [ ] **T-152**: Local streaming — stream screen to a channel within OwnCord, LAN-optimized, LiveKit-based
- [ ] **T-153**: Chat summarization — AI-powered "catch up" on missed messages, local model or optional cloud

---

## Code & Security Review — 2026-04-01

Full codebase review across 4 sections: Server Core, Server Realtime, Client & Tauri, Security.
Reviewed by 4 parallel agents. Findings deduplicated and prioritized below.

### CRITICAL (P0) — Must Fix

- [x] **T-241:** Fix hub panic recovery loop — added `h.Stop()` in defer when `panicCount >= 3` — 2026-04-01
- [x] **T-242:** Fix ring buffer `EventsSince` replay — returns non-nil empty slice instead of nil — 2026-04-01
- [x] **T-243:** Fix PTT event listener leak — stores unsubscribe handle, calls it in `stopPtt()` and before re-init — 2026-04-01
- [x] **T-244:** Fix `verifyTotp` hardcoded `acceptInvalidCerts: true` — now respects `config.allowSelfSigned` — 2026-04-01
- [x] **T-245:** Fix `ptt_listen_for_key` blocking Tauri thread pool — moved to `tokio::task::spawn_blocking` — 2026-04-01

### HIGH (P1) — Fix Before Release

**Server Core:**
- [x] **T-246:** Fix TOTP rate-limit slot consumed before body decode — moved limiter check after body decode — 2026-04-01
- [x] **T-247:** Fix TOTP dual rate-limit counters — added `limiter.Reset(totpKey)` on successful verification — 2026-04-01
- [x] **T-248:** Fix TOTP enable allows silent secret rotation — returns 409 if `TOTPSecret` already set — 2026-04-01
- [x] **T-249:** Fix global search leaks restricted channel content — pre-computes accessible channel IDs for FTS WHERE clause — 2026-04-01
- [x] **T-250:** Fix `DeleteAccount` hard-coded role IDs — queries roles by name instead of ID — 2026-04-01
- [x] **T-251:** Fix `BackupToSafe` relative path — uses `absClean` in allowlist check and VACUUM INTO — 2026-04-01

**Server Realtime:**
- [x] **T-252:** Fix voice join camera slot TOCTOU — atomic `EnableCameraIfUnderLimit` DB method with conditional UPDATE — 2026-04-01
- [x] **T-253:** Fix readPump replaced-connection TOCTOU — snapshots voiceChID before unregister, guards handleVoiceLeave — 2026-04-01
- [x] **T-254:** Fix voice join sets state before token — moved `setVoiceState` after token send, rollback takes broadcast flag — 2026-04-01
- [x] **T-255:** Fix updater `downloadFile` overflow — uses probe pattern like storage.Save — 2026-04-01
- [x] **T-256:** Fix LiveKit webhook reads body before auth — checks Authorization header first — 2026-04-01
- [x] **T-257:** Fix `storage.Save` fsync + double close — added `f.Sync()`, used closed flag to prevent double close — 2026-04-01

**Client & Tauri:**
- [x] **T-258:** Fix WS event race — generation counter discards stale events from previous connections — 2026-04-01
- [x] **T-259:** Fix AudioWorklet load race — pipeline generation counter guards stale `.then()` callbacks — 2026-04-01
- [x] **T-260:** Fix screenshare mute state lost on reconnect — only clears mute map in full `leaveVoice()`, not reconnect — 2026-04-01
- [x] **T-261:** Fix `handleVoiceToken` unbounded recursion — replaced with iterative `while (pendingJoin)` loop — 2026-04-01
- [x] **T-262:** Fix `store.ts` re-entrant setState — added updating guard with pending queue — 2026-04-01
- [x] **T-263:** Fix notification AudioContext leak — exported `cleanupNotificationAudio()`, called on logout — 2026-04-01

**Security:**
- [x] **T-264:** SEC: Fix default WS origin — empty `allowedOrigins` now denies cross-origin (safe default) — 2026-04-01

### MEDIUM (P2) — Fix When Possible

**Server Core:**
- [ ] **T-265:** Fix `handleDeleteAccount` lockout key allows DoS — attacker with stolen token sends 3 bad passwords to lock out legitimate deletion. Consider IP+userID key — `Server/api/auth_handler.go:452-488`
- [ ] **T-266:** Fix `handleUpload` leaks internal storage error details in 400 response — log raw error, return generic message — `Server/api/upload_handler.go:117-124`
- [ ] **T-267:** Document `handleServeFile` intentional `Cache-Control` override of global `no-store` header — `Server/api/upload_handler.go:203`
- [ ] **T-268:** Fix `parseBooleanSettingValue` blocks all logins on typo — log warning and return safe default instead of 500 — `Server/api/auth_handler.go:575-584`
- [ ] **T-269:** Fix `handleCloseDM` raw JSON via `fmt.Sprintf` — use typed struct + `json.Marshal` — `Server/api/dm_handler.go:216`
- [ ] **T-270:** Fix rate limiter timestamps slice never shrinks memory — periodically replace with new slice — `Server/auth/ratelimit.go:60-65`

**Server Realtime:**
- [ ] **T-271:** Fix `wrapWithSeq` produces invalid JSON `{"seq":N,}` for empty objects — handle `msg == "{}"` case — `Server/ws/hub.go:446-458`
- [ ] **T-272:** Fix `handleReconnect` registers client before `writePump` starts — messages queued in 256-buffer can overflow under burst — `Server/ws/serve.go:119-127`
- [ ] **T-273:** Fix `handleChatEdit` permission check inconsistency — checks `SendMessages` only, inconsistent with delete handler's `ManageMessages || isOwner` — `Server/ws/handlers_chat.go:281-288`
- [ ] **T-274:** Fix stale voice sweep broadcasts `voice_leave` to all clients including those who never saw the join — `Server/ws/hub.go:533-535`
- [ ] **T-275:** Fix LiveKit YAML credential sanitization incomplete — expand blocklist to include `>`, `|`, `!`, `%` or use proper YAML library — `Server/ws/livekit_process.go:82-108`
- [ ] **T-276:** Fix updater `CheckForUpdate` cache stampede — multiple goroutines call `fetchLatestRelease` concurrently. Use `singleflight.Group` — `Server/updater/updater.go:121-152`

**Client & Tauri:**
- [ ] **T-277:** Fix WS dedup cache unreliable eviction — single-entry Set eviction under flood loses coverage. Use bounded LRU — `Client/tauri-client/src/lib/ws.ts:204-207`
- [ ] **T-278:** Fix `AudioPipeline.setupAudioPipeline` — `source` node not stored/disconnected on teardown — `Client/tauri-client/src/lib/audioPipeline.ts:89-138`
- [ ] **T-279:** Refactor `verifyTotp` to use `doFetch` instead of duplicating fetch logic — `Client/tauri-client/src/lib/api.ts:208-249`
- [ ] **T-280:** Fix `prependMessages` `hasMore` wrong when channel has exactly MAX+1 messages — `Client/tauri-client/src/lib/stores/messages.store.ts:170-183`
- [ ] **T-281:** Fix `DeviceManager` fallback unmutes user silently — check `localMuted` before re-enabling mic on device removal — `Client/tauri-client/src/lib/deviceManager.ts:87-93`
- [ ] **T-282:** Fix PTT `initPtt` double listener race — set `listening = true` before first await, or use promise lock — `Client/tauri-client/src/lib/ptt.ts:47-75`
- [ ] **T-283:** Fix `ws_disconnect` asymmetric cleanup — proxy loop exit leaves `inner.port` stale — `Client/tauri-client/src-tauri/src/livekit_proxy.rs:297-315`

**Security:**
- [ ] **T-284:** SEC: Add per-username login failure tracking to complement per-IP tracking — `Server/api/auth_handler.go:306`
- [ ] **T-285:** SEC: Lower login route-level rate limit from 60/min to 10/min — `Server/api/auth_handler.go:76`
- [ ] **T-286:** SEC: Add admin role hierarchy check — prevent non-owner admins from assigning Owner role — `Server/admin/handlers_users.go:100`
- [ ] **T-287:** SEC: Add MIME type allowlist for served files — prevents stored XSS via upload in browser contexts — `Server/api/upload_handler.go:104`
- [ ] **T-288:** SEC: Bind partial tokens to IP address — `Server/api/totp_handler.go:89`
- [ ] **T-289:** SEC: Add per-user session cap — no limit on concurrent sessions currently — `Server/db/auth_queries.go:184`
- [ ] **T-290:** SEC: Add WS message flood limit — no per-client message rate enforcement in hub — `Server/ws/serve.go:201`
- [ ] **T-291:** SEC: Sanitize error messages in update handler response — `Server/admin/update_handlers.go:44`
- [ ] **T-292:** SEC: Review config startup logging for secrets exposure — `Server/config/config.go:231`

### LOW (P3) — Nice to Have

- [ ] **T-293:** Add max bound to invite `ExpiresInHours` (cap at 8760 = 1 year) — `Server/api/invite_handler.go:72-75`
- [ ] **T-294:** Propagate `context.Context` through `GetServerStats` (6 sequential queries without cancellation) — `Server/db/admin_queries.go:27-54`
- [ ] **T-295:** Document lock ordering invariant (`hub.mu` → `c.mu`) at top of `hub.go` — `Server/ws/hub.go`

---

## Task Summary

| Phase | Focus | Tasks | Priority | Status |
|-------|-------|-------|----------|--------|
| 1-7 | Stabilization (original) | 37 | P0-P3 | All done |
| Audit | Security + code quality (2026-03-29) | 8 done | P1 | All done |
| PM-1–8 | Project Map Dashboard Enhancements | 38 | P2 | Pending |
| Deferred | Pre-roadmap features | 11 | P2-P3 | Pending |
| R1 | Community Essentials | 5 | P2 | Pending |
| R2 | Gaming DNA (Xfire) | 5 | P2 | Pending |
| R3 | Voice Power Features | 4 | P2 | Pending |
| R4 | LAN Party Toolkit | 5 | P3 | Pending |
| R5 | Platform & Extensibility | 6 | P3 | Pending |
| R6 | Future Vision | 5 | P4 | Pending |
| Review | Code & Security Review (2026-04-01) | 55 | P0-P3 | Pending |
| **Total new** | | **134 tasks** | |

Recommended order for PM phases: PM-8 (quick wins) → PM-1 → PM-5 → PM-4 → PM-2 → PM-3 → PM-7 → PM-6.
Recommended order for features: Deferred (quick wins) → R1 → R2 → R3 → R4 → R5 → R6.
Within each phase, tasks are independent and can be parallelized.

---

## Client Full Review — 2026-04-01

4-agent parallel review (security, code quality, bugs, architecture).
Findings below are NEW items not already tracked in the 2026-04-01 server+client review above.

### CRITICAL (P0) — Must Fix

- [ ] **T-382:** Fix BUG-082 — Remove `devtools` from default Cargo features; use `cfg(debug_assertions)` gate — `src-tauri/Cargo.toml:15`, `src-tauri/src/commands.rs:145-152`
- [ ] **T-383:** Fix BUG-076 — Add ref count decrement in drag-reorder cleanup; abort controller when count hits 0 — `src/components/channel-sidebar/drag-reorder.ts:26-31`
- [ ] **T-384:** Fix BUG-077 — Add null guard before `connect(config!)` in WS reconnect — `src/lib/ws.ts:154`

### HIGH (P1) — Fix Before Release

**Security:**
- [ ] **T-385:** SEC: Make HTTP `dangerous-settings` opt-in per-request — Remove from `Cargo.toml` default, pass cert settings per-request instead of globally — `src-tauri/Cargo.toml:25`, `src/lib/api.ts:94`
- [ ] **T-386:** SEC: Add HTTP certificate pinning — Extend TOFU fingerprint store to cover REST API / file upload calls, not just WebSocket — `src/lib/api.ts:81-107`
- [ ] **T-387:** SEC: Add WebSocket message authentication — Sign/HMAC critical message types to prevent injection via compromised proxy — `src/lib/ws.ts:165-241`

**Bugs:**
- [ ] **T-388:** Fix BUG-078 — Add abort check after room creation in LiveKit reconnect; wrap in try/finally — `src/lib/livekitSession.ts:350-397`
- [ ] **T-389:** Fix BUG-079 — Call `removeAutoplayUnlock()` in all voice cleanup paths, not just `handleDisconnected` — `src/lib/livekitSession.ts:280-308`
- [ ] **T-390:** Fix BUG-080 — Clear both `intervalId` and `qualityDebounceTimer` in connection stats cleanup — `src/lib/connectionStats.ts:130-192`
- [ ] **T-391:** Fix BUG-081 — Call `stopVadPolling()` at start of `teardownAudioPipeline()` — `src/lib/audioPipeline.ts:30,315,345`

**Code Quality:**
- [ ] **T-392:** Add logging to ~20 silent catch blocks in message-list components — `src/components/message-list/media.ts:46,85,150,204`, `attachments.ts:59,101,132,157,172`, `embeds.ts:152,220,247,319`
- [ ] **T-393:** Replace 2 unsafe `as any` casts with proper types — `src/lib/audioPipeline.ts:75` (LiveKit processor), `src/lib/livekitSession.ts:103` (pendingJoin)

### MEDIUM (P2) — Fix When Possible

**Code Quality:**
- [ ] **T-394:** Split `livekitSession.ts` further — Still 1,293 lines after T-184 reduction. Extract `VoiceChannelManager` and `TrackManager` sub-modules (~430 lines each)
- [ ] **T-395:** Split `SidebarArea.ts` (919 lines) and `ChannelSidebar.ts` (864 lines) — Extract sub-components: `SidebarHeader`, `ChannelSidebarManager`, `DmSidebarManager`
- [ ] **T-396:** Fix array mutations in store updates — Use spread operator instead of `.push()` — `src/stores/channels.store.ts:169`, `src/stores/members.store.ts:168-171`
- [ ] **T-397:** Standardize error narrowing — Replace bare `catch { }` with `catch (err: unknown)` across codebase — `src/main.ts:160,198`, `src/lib/api.ts:152`, others

**Security:**
- [ ] **T-398:** SEC: Tighten settings key validation — Replace prefix allowlist with explicit key allowlist — `src-tauri/src/commands.rs:21-29`

**Bugs (Potential):**
- [ ] **T-399:** Fix AdminActions context menu listener leaks — Add `signal` parameter to `addEventListener` calls — `src/components/AdminActions.ts:63,104,107`
- [ ] **T-400:** Fix unhandled promise in image fetch — Add `.catch()` to `fetchImageAsDataUrl` void call — `src/components/message-list/attachments.ts:323-326`

### LOW (P3) — Nice to Have

- [ ] **T-401:** Replace PTT polling (254 keys per 20ms) with `SetWindowsHookEx` WH_KEYBOARD_LL for efficiency — `src-tauri/src/ptt.rs:36-50`
- [ ] **T-402:** Add client unit test infrastructure — Currently 0 unit tests; add initial coverage for stores, lib/api.ts, lib/ws.ts
- [ ] **T-403:** Add IPC command rate limiting in Tauri backend — Prevent renderer spam of expensive commands — `src-tauri/src/lib.rs`

---

## Server Deep Review — 2026-04-01

Full server review by 3 parallel agents: security, code quality, bug hunt.
Findings: 2 CRITICAL security, 5 HIGH security, 6 HIGH bugs, 4 MEDIUM bugs, 12 MEDIUM quality, 7 MEDIUM security, 5 LOW security, 8 LOW quality.

### P0 — Bugs (HIGH) — Fix Immediately

- [ ] **T-404:** Fix BUG-084 — broadcast filter silently drops messages for clients with `channelID==0` (no `channel_focus` sent) — `Server/ws/hub.go:562`
- [ ] **T-405:** Fix BUG-085 — ring buffer `EventsSince` off-by-one: oldest boundary event dropped on reconnect. Change `<` to `<=` — `Server/ws/ringbuffer.go:54`
- [ ] **T-406:** Fix BUG-086 — `leaveVoiceChannelWithRetry` goroutine has no context/cancellation, leaks on hub stop — `Server/ws/voice_leave.go:71-93`
- [ ] **T-407:** Fix BUG-087 — `GracefulStop` not idempotent, `lkProcess.Stop()` called twice on concurrent shutdown. Wrap in `sync.Once` — `Server/ws/hub.go:213-234`
- [ ] **T-408:** Fix BUG-088 — voice channel capacity check unreliable during channel switch when DB leave fails — `Server/ws/voice_join.go:74-98`
- [ ] **T-409:** Fix BUG-089 — `go RemoveParticipant` goroutine in `handleFreshConnect` races with `registerNow` voice state transfer — `Server/ws/serve.go:153`

### P0 — Security (CRITICAL) — Fix Immediately

- [ ] **T-410:** SEC: Make `BackupTo` unexported or accept `time.Time` only — exported function with raw string path is SQL injection risk for future callers — `Server/db/admin_queries.go:369`
- [ ] **T-411:** SEC: Add localhost fallback for LiveKit webhook CIDR — empty `AdminAllowedCIDRs` exposes webhook to public internet — `Server/api/middleware.go:255-257`

### P1 — Security (HIGH) — Fix Before Release

- [ ] **T-412:** SEC: Block SVG/HTML uploads or force `Content-Disposition: attachment` — stored XSS via malicious SVG — `Server/storage/storage.go` + `Server/api/upload_handler.go:202`
- [ ] **T-413:** SEC: Add rate limiting to TOTP confirmation endpoint — brute-forceable 6-digit code space — `Server/api/totp_handler.go:180-238`
- [ ] **T-414:** SEC: Add auth middleware to LiveKit proxy endpoint — unauthenticated WS connections accepted — `Server/api/livekit_proxy.go`
- [ ] **T-415:** SEC: Move GitHub token from config YAML to environment variable — plaintext secret in config file — `Server/config/config.go:31`
- [ ] **T-416:** SEC: Persist brute-force lockouts to SQLite — in-memory rate limiter wiped on restart — `Server/auth/ratelimit.go`

### P1 — Bugs (MEDIUM)

- [ ] **T-417:** Fix BUG-090 — `sanitizeFTSQuery` truncates at byte boundary, not rune boundary — invalid UTF-8 for multi-byte chars — `Server/db/message_queries.go:23`
- [ ] **T-418:** Fix rate limiter `Check` vs `Allow` window pruning divergence — overly aggressive rate limiting at boundary — `Server/api/totp_handler.go:70`
- [ ] **T-419:** Fix BUG-091 — updater `downloadFile` double-closes `*os.File` on error — unsafe on Windows — `Server/updater/updater.go:416`
- [ ] **T-420:** Fix `refreshSettingsLocked` called without lock in `NewHub` — latent data race if settings read before `Run()` — `Server/ws/hub.go:74`

### P2 — Security (MEDIUM)

- [ ] **T-421:** SEC: Add per-connection bandwidth throttle on WS — 1MB messages at rate limit = excessive data — `Server/ws/serve.go:38`
- [ ] **T-422:** SEC: Sanitize `handleLiveKitHealth` error details — leaks internal hostnames/ports to admin callers — `Server/api/router.go:237-256`
- [ ] **T-423:** SEC: Log warning when WS session token sent over plaintext (TLS off) — `Server/ws/serve.go:277-303`
- [ ] **T-424:** SEC: Add emoji length validation before DB insert — no cap on emoji string length — `Server/db/message_queries.go:149`
- [ ] **T-425:** SEC: Omit token hash from admin session listings — `Server/db/admin_queries.go:126`
- [ ] **T-426:** SEC: Tighten `data/` directory permissions from 0o755 to 0o700 — `Server/main.go:72`
- [ ] **T-427:** SEC: Add `Vary: Origin` header to file serving endpoint — CORS caching issue — `Server/api/upload_handler.go:205`

### P2 — Code Quality (MEDIUM)

- [ ] **T-428:** Extract `handleSearch` into `searchSingleChannel`/`searchAllChannels` helpers — 180 lines, 4+ nesting levels — `Server/api/channel_handler.go:261-441`
- [ ] **T-429:** Extract `generateAndSendVoiceToken` from `handleVoiceJoin` — 186 lines with 9 steps — `Server/ws/voice_join.go:32-186`
- [ ] **T-430:** Move `refreshSettingsLocked` to use `db.GetSetting()` instead of raw SQL — `Server/ws/hub.go:105-108`
- [ ] **T-431:** Add `slog.Warn` wrapper for `LogAudit` failures instead of `_ =` — `Server/api/auth_handler.go:212+`
- [ ] **T-432:** Extract DM participant authorization check into shared helper — copy-pasted in 3 REST handlers — `Server/api/channel_handler.go:170,470,558`
- [ ] **T-433:** Consolidate 4 voice control toggle handlers into table-driven `handleVoiceToggle` — `Server/ws/voice_controls.go`
- [ ] **T-434:** Add named constants for ring buffer size (1000), broadcast channel (256), login lockout (9) — `Server/ws/hub.go:68-69`
- [ ] **T-435:** Remove duplicate `ClearVoiceState` — identical to `LeaveVoiceChannel` — `Server/db/voice_queries.go:82,217`

---

## Deep Research Pass 3 — Beyond Linters & Checkers (2026-04-01)

Tools that find bugs linters fundamentally cannot. Full research report: `docs/research/deep-research-pass3-beyond-linters.md`

### Phase 1 — Done (2026-04-01)

- [x] **T-436:** Add goleak goroutine leak detection — `TestMain` in all 9 test packages — 2026-04-01
- [x] **T-437:** Add go-deadlock detection — `syncutil/` package with build-tagged mutex shims, updated 8 files (13 mutexes), CI step with `-tags deadlock` — 2026-04-01

### Phase 2 — Go Native Fuzzing (HIGH, low effort)

- [ ] **T-438:** Write `Fuzz*` tests for WS message handlers — target `ws/handlers.go` (main dispatch), `handlers_chat.go`, `handlers_presence.go`, `handlers_reaction.go`, `voice_controls.go` — find panics/nil derefs from malformed input
- [ ] **T-439:** Write `Fuzz*` tests for REST API JSON parsers — target `api/auth_handler.go`, `dm_handler.go`, `profile_handler.go`, `totp_handler.go`, `invite_handler.go`, `upload_handler.go`
- [ ] **T-440:** Add fuzz CI step — `go test -fuzz=Fuzz -fuzztime=30s` per package in `.github/workflows/ci.yml` (or separate scheduled workflow)

### Phase 3 — Authorization Matrix Testing (CRITICAL)

- [ ] **T-441:** Write table-driven authz matrix tests — exhaustive role/endpoint permutations for all REST endpoints (admin vs member vs guest vs unauthenticated) — `Server/api/authz_matrix_test.go`
- [ ] **T-442:** Write WS authz matrix tests — verify members can't perform admin-only WS operations (channel create/delete, kick, ban) — `Server/ws/authz_matrix_test.go`

### Phase 4 — Mutation Testing (HIGH)

- [ ] **T-443:** Add go-gremlins mutation testing — `.gremlins.yaml` config targeting ws/, api/, auth/, db/ packages. Separate weekly CI workflow `.github/workflows/mutation.yml`
- [ ] **T-444:** Add Stryker mutation testing for client — `stryker.config.mjs`, run against Vitest suite. Add to weekly mutation workflow

### Phase 5 — Protocol Contract Testing (HIGH)

- [ ] **T-445:** Formalize WebSocket protocol schema — expand `docs/protocol-schema.json` to full JSON Schema for all 40 message types. Add Go contract test (`ws/contract_test.go`) and Vitest contract test. Add Zod runtime validation on client

### Phase 6 — Load & Chaos Testing (MEDIUM-HIGH)

- [ ] **T-446:** Add k6 WebSocket load tests — `Server/scripts/k6/ws-load.js` simulating 500 concurrent users: connect, auth, send, receive. Manual-trigger CI workflow
- [ ] **T-447:** Add toxiproxy chaos tests — integration tests for reconnection/replay buffer under network faults (latency, drops, resets). Build-tagged `//go:build integration`

### Phase 7 — Defense in Depth (MEDIUM)

- [x] **T-448:** Add Coraza WAF middleware — embed `corazawaf/coraza/v3` as chi middleware with OWASP CRS rules. Config toggle `waf_enabled` + `waf_paranoia_level` — 2026-04-01
- [ ] **T-449:** Tauri security audit — audit CSP in `tauri.conf.json`, check `withGlobalTauri`, scope HTTP permissions, validate IPC command inputs. Write report to `docs/security/tauri-audit.md`
- [ ] **T-450:** Tauri production capability hardening — create tightened `capabilities/production.json`, restrict `connect-src`/HTTP permissions to configured server URL only

---

## Mutation Testing — Surviving Mutants (2026-04-01)

Stryker mutation testing results. Files below 60% mutation score need
additional tests to kill surviving mutants. LiveKit/browser-API files
require deeper SDK mocking.

### P1 — High Survivor Count (170+ mutants)

- [ ] **T-451:** Kill surviving mutants in `livekitSession.ts` (25.88%, 170 survivors) — largest gap. Needs deep LiveKit SDK mocking: Room, LocalParticipant, RemoteParticipant, Track lifecycle. Focus on voice join/leave, camera toggle, reconnect, and cleanup paths — `src/lib/livekitSession.ts`

### P2 — Medium Survivor Count (14-44 mutants)

- [ ] **T-452:** Kill surviving mutants in `media-visibility.ts` (52.63%, 44 survivors) — IntersectionObserver-dependent. Mock observer callbacks, test visibility transitions, lazy-load triggers — `src/lib/media-visibility.ts`
- [ ] **T-453:** Kill surviving mutants in `streamPreview.ts` (55.37%, 37 survivors) — LiveKit video track preview. Mock track attach/detach, element creation, thumbnail rendering — `src/lib/streamPreview.ts`
- [ ] **T-454:** Kill surviving mutants in `screenShare.ts` (9.68%, 30 survivors) — Needs getDisplayMedia mock, track lifecycle, screenshare toggle, and spotlight view logic — `src/lib/screenShare.ts`
- [ ] **T-455:** Kill surviving mutants in `safe-render.ts` (54.84%, 14 survivors) — DOM rendering edge cases, sanitization guards, fallback rendering — `src/lib/safe-render.ts`

### P3 — Low Survivor Count (6-7 mutants, mostly no-coverage)

- [ ] **T-456:** Kill surviving mutants in `roomEventHandlers.ts` (8.08%, 7 survivors) — LiveKit room event callbacks. Mock Room.on() events: participantConnected/Disconnected, trackSubscribed/Unsubscribed — `src/lib/roomEventHandlers.ts`
- [ ] **T-457:** Kill surviving mutants in `livekitDiagnostics.ts` (3.19%, 6 survivors) — LiveKit diagnostics. Mock preflight checks, network quality indicators — `src/lib/livekitDiagnostics.ts`

### Completed (2026-04-01)

- [x] **notifications.ts** — improved 39.36% → 79.79% (+40.43%) — 32 tests added
- [x] **audioPipeline.ts** — improved 53.61% → 64.43% (+10.82%) — 61 tests added
- [x] **ws.ts** — improved 46.67% → 50.39% (+3.72%) — 50 tests added
