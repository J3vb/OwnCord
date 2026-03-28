# Backlog

**Goal:** Ship v1.2, then build gaming-native features that
differentiate OwnCord from Discord/TeamSpeak/Mumble.

Last task ID: T-183. New tasks start at T-184.

---

## Core Stability — Bugs Found 2026-03-28 (audit + Codex review)

- [ ] **T-165:** Fix BUG-046 — wrap voice `switchActiveDevice` in try-catch with device fallback
- [ ] **T-166:** Fix BUG-047 — block send until uploads complete or cancel in-flight uploads
- [ ] **T-167:** Fix BUG-048 — add client-side file size/type validation before upload (incl. paste path)
- [ ] **T-168:** Fix BUG-049 — migrate VAD from requestAnimationFrame to AudioWorklet
- [ ] **T-169:** Fix BUG-050 — clear stale audio elements on voice auto-reconnect
- [ ] **T-170:** Fix BUG-051 — add origin/path check to LiveKit HTTP proxy handler
- [ ] **T-171:** Fix BUG-052 — replace swallowed `.catch(() => {})` with debug/warn logging
- [ ] **T-172:** Fix BUG-053 — add TOFU fingerprint pinning to LiveKit TLS proxy
- [ ] **T-173:** Fix BUG-054 — implement account deletion (server endpoint + client UI)

## Cleanup — Found 2026-03-28

- [ ] **T-182:** Fix BUG-055 — remove 4 stale vitest coverage exclusions
- [ ] **T-183:** Fix BUG-056 — investigate livekit-session.test.ts:434 proxy URL test failure

---

## Unified Sidebar — Deferred Items (from 2026-03-27 redesign)

- [ ] **T-161:** Relocate MemberList into unified sidebar as collapsible section (spec says members go below DMs)
- [ ] **T-162:** Wire DM conversations to real data source (currently empty placeholder array in SidebarArea)
- [ ] **T-163:** Wire quick-switch overlay disconnect/reconnect flow (UI built, onSwitch is stub)
- [ ] **T-164:** Add per-server collapsible section state persistence to localStorage

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
- [ ] **T-023**: Add TOTP 2FA support
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

## Task Summary

| Phase | Focus | Tasks | Priority | Status |
|-------|-------|-------|----------|--------|
| 1-7 | Stabilization (original) | 37 | P0-P3 | All done |
| Deferred | Pre-roadmap features | 11 | P2-P3 | Pending |
| R1 | Community Essentials | 5 | P2 | Pending |
| R2 | Gaming DNA (Xfire) | 5 | P2 | Pending |
| R3 | Voice Power Features | 4 | P2 | Pending |
| R4 | LAN Party Toolkit | 5 | P3 | Pending |
| R5 | Platform & Extensibility | 6 | P3 | Pending |
| R6 | Future Vision | 5 | P4 | Pending |
| **Total new** | | **41 tasks** | |

Recommended order: Deferred (quick wins) → R1 → R2 → R3 → R4 → R5 → R6.
Within each phase, tasks are independent and can be parallelized.
