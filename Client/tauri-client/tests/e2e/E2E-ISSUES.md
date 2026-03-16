# E2E Test Issues — 2026-03-15

## 135 tests: 55 passed, 80 failed (40.7%)

## Passing Files

| Spec File | Pass/Total |
| --------- | ---------- |
| `banners-toasts.spec.ts` | 4/4 |
| `chat-header.spec.ts` | 6/6 |
| `connect-page.spec.ts` | 15/17 |
| `server-strip.spec.ts` | 4/4 |
| `channel-sidebar.spec.ts` | 8/9 |
| `main-layout.spec.ts` | 4/6 |
| `user-bar.spec.ts` | 4/5 |
| `typing-indicator.spec.ts` | 2/4 |

## Failing Files

| Spec File | Pass/Total |
| --------- | ---------- |
| `message-list.spec.ts` | 0/16 |
| `message-input.spec.ts` | 0/7 |
| `settings-overlay.spec.ts` | 0/24 |
| `overlays.spec.ts` (quick switcher) | 0/9 |
| `overlays.spec.ts` (emoji picker) | 0/6 |
| `voice-widget.spec.ts` | 0/6 |
| `member-list.spec.ts` | 0/7 |

## Root Causes (fix in this order)

### 1. CRITICAL — No channel auto-selected on login (~35 tests)

First channel lacks `.active` after login, so messages pane,
input, and typing bar never mount. Cascades into
`message-list`, `message-input`, `overlays` (emoji),
and `typing-indicator`.

**Affected:** `message-list` (16), `message-input` (7),
`overlays` emoji (6), `typing-indicator` (2),
`main-layout` (2), `channel-sidebar` (1)

**Fix:** Check why first channel isn't auto-selected
after `ready` WS payload. Likely store or MainPage
doesn't call `setActiveChannel` on initial render.
Mock may need correct channel data format.

### 2. HIGH — Settings overlay toggle broken (24 tests)

Gear button click doesn't add `.open` to
`.settings-overlay`. Button IS found (user-bar
tests pass), so handler or class toggle is broken.

**Affected:** All 24 tests in `settings-overlay.spec.ts`

**Fix:** Check if gear calls `openSettings()` from
`ui.store` and if SettingsOverlay subscribes to
toggle `.open`. May be a wiring issue in MainPage.

### 3. MEDIUM — Quick Switcher Ctrl+K not wired (9 tests)

`Ctrl+K` doesn't open `.quick-switcher-overlay`.
Possible Tauri global shortcut vs DOM `keydown`
conflict — Tauri shortcuts don't work in E2E.

**Affected:** All 9 quick switcher tests in `overlays.spec.ts`

**Fix:** Check if it uses Tauri global shortcut vs
DOM `keydown`. If global, add DOM fallback or mock
the shortcut trigger.

### 4. MEDIUM — Voice widget stays hidden (6 tests)

`.voice-widget` exists in DOM but `.visible` is
never applied after mock `voice_states` injection.

**Affected:** All 6 tests in `voice-widget.spec.ts`

**Fix:** Check if voice store processes
`voice_state_update` WS messages and if widget
subscribes to toggle `.visible`. Mock may need
a different message type.

### 5. MEDIUM — Member list not rendering members (7 tests)

`.member-role-group` count is 0 despite members in
mock ready payload. Panel is mounted but empty.

**Affected:** All 7 tests in `member-list.spec.ts`

**Fix:** Check if members store populates from
`ready` payload and if MemberList subscribes.
Verify `.member-role-group` selector matches
actual component output.

### 6. LOW — `.status-dot` selector mismatch (1 test)

`.user-bar .status-dot` not found. Element either
doesn't exist or uses a different class name.

**Affected:** 1 test in `user-bar.spec.ts`

**Fix:** Read UserBar component source and find
the correct selector for the status indicator.
