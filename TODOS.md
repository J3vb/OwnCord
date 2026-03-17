# TODOS

Items deferred from CEO plan review of `tauri-migration` branch
(2026-03-16). Ordered by priority.

## P1 — Must fix soon

### ~~1. Attachment permission ordering bug~~ DONE

Moved `ATTACH_FILES` permission check before `CreateMessage()`
in `Server/ws/handlers.go`. Added test
`TestChatSend_AttachmentsDeniedNoMessageCreated`.

---

### ~~2. Hardcoded `/api/files/` URL~~ DONE

Changed to `/api/v1/files/` in
`Server/db/attachment_queries.go:93`.

---

### ~~3. Missing `onUnauthorized` handler~~ DONE

Wired `api.onUnauthorized` callback at creation in `main.ts`
to call `clearAuth()`, which triggers navigation back to
connect page via existing authStore subscription.

---

## P2 — Should fix next

### ~~4. Silent API failure toasts~~ DONE

Added `ToastContainer` to `MainPage.ts`. Wired toast to 5
catch blocks: `loadMessages`, `loadOlderMessages`,
`openInviteManager`, `togglePinnedPanel`, and the connectivity
guard on message send.

---

### ~~5. Message send connectivity guard + debounce~~ DONE

Added `ws.getState() !== "connected"` guard in `MainPage.ts`
`onSend` callback with toast feedback. Added 200ms send
debounce in `MessageInput.ts` to prevent double-click
duplicates.

---

### ~~6. WebSocket frame size limit on server~~ DONE

Added `conn.SetReadLimit(1 << 20)` (1MB) in
`Server/ws/serve.go` after WebSocket accept.

---

### ~~7. Wrap dispatcher store operations in try/catch~~ N/A

Already handled: `ws.ts` dispatch function wraps every
listener call in try/catch with `log.error`. No additional
wrapping needed in `dispatcher.ts`.

---

### ~~8. `GetAttachmentsByMessageIDs` error silently swallowed~~ DONE

Added `slog.Error("ws handleChatSend GetAttachments", ...)` in
`Server/ws/handlers.go` inside the error check.

---

## P3 — Tech debt / polish

### 9. Split oversized files

**What:** Break these files into smaller modules:

- `Server/admin/api.go` (788 lines) into
  `handlers_users.go`, `handlers_channels.go`,
  `handlers_backup.go`
- `Client/tauri-client/src/pages/MainPage.ts` (683 lines)
  into extracted helpers
- `Client/tauri-client/src/components/SettingsOverlay.ts`
  (670 lines) into per-tab components

**Why:** All exceed the 400-line target. Larger files are
harder to navigate, review, and test. They will grow as
features are added.

**Context:** Pure refactor, no behavior change. Best done
when no other PRs touch these files.

**Effort:** M per file (3 files)

---

### ~~10. Extract permission check helper (server DRY)~~ DONE

Created `requireChannelPerm(c, channelID, perm, permLabel)`
helper in `handlers.go`. Replaced 8 instances across
`handlers.go` and `voice_handlers.go`.

---

### 11. Virtual scrolling for MessageList

**What:** Implement DOM windowing/recycling in
`MessageList.ts` so only visible messages (plus buffer) are
in the DOM.

**Why:** Channels with 10K+ messages will cause initial
render hang and high memory usage.

**Context:** Phase 5 of MIGRATION-PLAN.md mentions this.
Consider a lightweight virtual scroll library or custom
implementation using IntersectionObserver.

**Effort:** L

---

### 12. WS message render batching

**What:** Batch store subscription callbacks using
`requestAnimationFrame` or `queueMicrotask` so 100 rapid
WS messages don't trigger 100 full re-renders.

**Why:** Burst activity (e.g., reconnect with backlog)
causes jank from unbatched DOM updates.

**Effort:** M

---

### 13. E2E test improvement plan (Phases 4-6)

**What:** Complete the remaining phases of the E2E
improvement plan:

- Phase 4: Strengthen assertions, fix quality
- Phase 5: Toast coverage
- Phase 6: Migrate all selectors to data-testid

**Why:** Phases 1-3 are complete. Remaining phases improve
test reliability and coverage.

**Context:** See `project_e2e_improvement_plan.md` in
Claude memory for full plan.

**Effort:** M (per phase)

**Depends on:** TODO #4 (toast wiring) for Phase 5 — DONE

---

## CLIENT-REVIEW.md findings

### ~~Auth token never set in authStore~~ DONE

Fixed in `main.ts:wirePostAuth` — store token in authStore
before WS connect so dispatcher's `auth_ok` handler has it.

---

### ~~WS connect hangs in "connecting" state~~ DONE

Fixed in `ws.ts` — set state to "disconnected" when Tauri
APIs are unavailable.

---

### ~~Server-driven voice disconnect doesn't clear currentChannelId~~ DONE

Fixed in `dispatcher.ts` — `voice_leave` handler now calls
`leaveVoiceChannel()` when the current user is removed.

---

### ~~Theme/font not applied on app start~~ DONE

Extracted `applyStoredAppearance()` from `SettingsOverlay.ts`
and call it at app startup in `main.ts`.

---

### ~~Infinite scroll throttle~~ DONE

Fixed in `MessageList.ts` — replaced fixed 500ms timeout
with store subscription that resets `loadingOlder` when
message count changes. Also checks `hasMoreMessages` before
triggering scroll load.
