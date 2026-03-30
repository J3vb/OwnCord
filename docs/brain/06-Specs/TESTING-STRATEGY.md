# Testing Strategy: OwnCord

Comprehensive testing infrastructure for the Go server and
Tauri v2 desktop client.

Coverage target: **80%+** for all code.
Methodology: **TDD** (write tests first).

See also: [[06-Specs/CLIENT-ARCHITECTURE|CLIENT-ARCHITECTURE.md]],
[[06-Specs/GO-PATTERNS|GO-PATTERNS.md]],
[[04-Decisions/DEC-007-native-e2e-cdp|DEC-007 Native E2E via CDP]],
[[06-Specs/E2E-BEST-PRACTICES|E2E-BEST-PRACTICES.md]]

---

## Table of Contents

1. [Test Stack Overview](#1-test-stack-overview)
2. [Directory Structure](#2-directory-structure)
3. [NPM Test Scripts](#3-npm-test-scripts)
4. [Vitest Configuration](#4-vitest-configuration)
5. [Unit Test Patterns](#5-unit-test-patterns)
6. [Integration Test Patterns](#6-integration-test-patterns)
7. [E2E Test Patterns (Mocked)](#7-e2e-test-patterns-mocked)
8. [E2E Test Patterns (Production Build)](#8-e2e-test-patterns-production-build)
9. [Native E2E Testing (CDP)](#9-native-e2e-testing-cdp)
10. [Playwright Configuration Reference](#10-playwright-configuration-reference)
11. [Mock Utilities](#11-mock-utilities)
12. [Test Fixtures](#12-test-fixtures)
13. [Rust Tests](#13-rust-tests)
14. [Go Server Tests](#14-go-server-tests)
15. [Audit Regression Tests](#15-audit-regression-tests)
16. [Coverage Configuration](#16-coverage-configuration)
17. [CI Pipeline](#17-ci-pipeline)
18. [Writing New Tests](#18-writing-new-tests)

---

## 1. Test Stack Overview

```
+---------------------------------------------------------------------+
| Layer        | Tool           | Environment           | Purpose       |
|--------------|----------------|-----------------------|---------------|
| Unit         | Vitest 3.x     | jsdom                 | Functions,    |
|              |                |                       | stores, utils |
| Integration  | Vitest 3.x     | jsdom + mocked WS/    | Store dispatch|
|              |                | fetch                 | flows         |
| E2E (mocked) | Playwright 1.x | Chromium + Vite dev   | UI journeys   |
| E2E (prod)   | Playwright 1.x | Chromium + Vite       | Built dist/   |
|              |                | preview               | verification  |
| E2E (native) | Playwright 1.x | Real Tauri exe +      | Production    |
|              |                | WebView2 CDP          | integration   |
| Rust         | cargo test     | native                | Tauri commands|
|              |                |                       | FFI           |
| Go Server    | go test        | native + in-memory    | Handlers, DB, |
|              |                | SQLite                | WS, auth      |
+---------------------------------------------------------------------+
```

### Test Runner Flow

```
                          npm test
                             |
                     vitest run (all)
                      /           \
              tests/unit/     tests/integration/
              (~67 files)      (~1 file)
                  |                 |
              jsdom env         jsdom env
           mock Tauri IPC     mock WS + fetch
           mock WebSocket     full store flows
           mock fetch


                    npm run test:e2e
                          |
                   playwright test
                          |
                  tests/e2e/*.spec.ts
                   (ignore native/)
                          |
                  Vite dev server (:1420)
                  Chromium browser
                  Route interception


                npm run test:e2e:native
                          |
                   playwright test
                 --config native.ts
                          |
              tests/e2e/native/*.spec.ts
                          |
              Launch owncord-client.exe
              CDP on 127.0.0.1:9222
              Real WebView2 page
```

---

## 2. Directory Structure

```
Client/tauri-client/
+-- tests/
|   +-- unit/                        # Vitest unit tests
|   |   +-- types.test.ts            # Protocol type validation
|   |   +-- api.test.ts              # REST client paths + errors
|   |   +-- ws.test.ts               # WS connect, dispatch, reconnect
|   |   +-- rate-limiter.test.ts     # Rate enforcement
|   |   +-- permissions.test.ts      # Bitfield operations
|   |   +-- chat.test.ts             # Message grouping, typing
|   |   +-- voice.store.test.ts      # Voice store state
|   |   +-- voice-widget.test.ts     # Voice widget UI
|   |   +-- voice-channel.test.ts    # Voice channel component
|   |   +-- voice-disconnect.test.ts # Voice disconnect handling
|   |   +-- voice-callbacks.test.ts  # Voice callback wiring
|   |   +-- video-mode-controller.test.ts # Video mode switching
|   |   +-- livekit-session.test.ts  # LiveKit session management
|   |   +-- profiles.test.ts         # Server profile CRUD
|   |   +-- gif-picker.test.ts       # GIF picker / Tenor
|   |   +-- ptt.test.ts              # Push-to-talk
|   |   +-- renderers.test.ts        # Message content rendering
|   |   +-- notifications.test.ts    # Desktop notifications
|   |   +-- video-grid.test.ts       # Video tile grid
|   |   +-- dispatcher.test.ts       # WS message dispatcher
|   |   +-- dom.test.ts              # DOM utilities
|   |   +-- logger.test.ts           # Client logging
|   |   +-- safe-render.test.ts      # XSS-safe rendering
|   |   +-- tenor.test.ts            # Tenor API client
|   |   +-- window-state.test.ts     # Window focus tracking
|   |   +-- router.test.ts           # Client-side routing
|   |   +-- store.test.ts            # Generic store factory
|   |   +-- auth.store.test.ts       # Auth store
|   |   +-- channels.store.test.ts   # Channels store
|   |   +-- messages.store.test.ts   # Messages store
|   |   +-- members.store.test.ts    # Members store
|   |   +-- ui.store.test.ts         # UI store
|   |   +-- themes.test.ts           # Theme system
|   |   +-- reconcile.test.ts        # State reconciliation
|   |   +-- context-menu.test.ts     # Context menu component
|   |   +-- dm-sidebar.test.ts       # DM sidebar component
|   |   +-- quick-switcher.test.ts   # Quick switch overlay
|   |   +-- rnnoise-worklet.test.ts  # Noise suppression worklet
|   |   +-- <component>.test.ts      # (~67 unit test files total)
|   +-- integration/
|   |   +-- stores.test.ts           # Full store hydration flows
|   +-- e2e/                         # Playwright E2E specs (~29 spec files)
|   |   +-- connect-page.spec.ts     # Login/register flow
|   |   +-- register-flow.spec.ts    # Registration flow
|   |   +-- logout-flow.spec.ts      # Logout flow
|   |   +-- main-layout.spec.ts      # App layout after auth
|   |   +-- message-send-flow.spec.ts # Send/receive messages
|   |   +-- message-input.spec.ts    # Message input component
|   |   +-- message-list.spec.ts     # Message list rendering
|   |   +-- message-actions.spec.ts  # Message context actions
|   |   +-- message-edit-delete.spec.ts # Edit/delete messages
|   |   +-- reply-flow.spec.ts       # Reply to messages
|   |   +-- channel-sidebar.spec.ts  # Channel navigation
|   |   +-- channel-switch-messages.spec.ts # Channel switching
|   |   +-- chat-header.spec.ts      # Chat header component
|   |   +-- voice-widget.spec.ts     # Voice controls
|   |   +-- voice-channel.spec.ts    # Voice channel E2E
|   |   +-- settings-overlay.spec.ts # Settings panel
|   |   +-- overlays.spec.ts         # Overlay components
|   |   +-- connected-overlay.spec.ts # Connected overlay
|   |   +-- member-list.spec.ts      # Member list
|   |   +-- user-bar.spec.ts         # User bar component
|   |   +-- typing-indicator.spec.ts # Typing indicators
|   |   +-- typing-indicator-ws.spec.ts # WS typing events
|   |   +-- emoji-insertion.spec.ts  # Emoji picker insertion
|   |   +-- toast.spec.ts            # Toast notifications
|   |   +-- banners-toasts.spec.ts   # Banners and toasts
|   |   +-- server-strip.spec.ts     # Server strip component
|   |   +-- connect-settings.spec.ts # Connection settings
|   |   +-- health-status.spec.ts    # Health status indicator
|   |   +-- totp-flow.spec.ts        # TOTP authentication
|   |   +-- helpers.ts               # E2E test utilities
|   |   +-- native-fixture.ts        # CDP fixture for native E2E
|   |   +-- native/                  # Native E2E specs
|   |       +-- smoke.spec.ts        # App launches successfully
|   |       +-- auth-flow.spec.ts    # Real login/register
|   |       +-- chat-operations.spec.ts
|   |       +-- channel-navigation.spec.ts
|   |       +-- overlays.spec.ts
|   |       +-- settings-overlay.spec.ts
|   |       +-- voice-controls.spec.ts
|   |       +-- app-layout.spec.ts
|   |       +-- helpers.ts           # Native test helpers
|   +-- helpers/
|       +-- mock-ws.ts               # Mock WebSocket class
|       +-- fixtures.ts              # Sample protocol payloads
|       +-- test-utils.ts            # DOM helpers, store reset

Server/
+-- db/
|   +-- db_test.go                   # DB open, migrate, helpers
|   +-- auth_queries_test.go         # User + session CRUD
|   +-- channel_queries_test.go      # Channel CRUD
|   +-- message_queries_test.go      # Message CRUD + search
|   +-- role_invite_queries_test.go  # Role + invite operations
|   +-- voice_queries_test.go        # Voice state operations
|   +-- admin_queries_test.go        # Admin + audit log
|   +-- attachment_queries_test.go   # Attachment CRUD
|   +-- backup_test.go              # Database backup
|   +-- migrate_test.go             # Migration tracking
+-- ws/
|   +-- handlers_test.go            # WS message handlers
|   +-- ws_integration_test.go      # Hub + client integration
|   +-- hub_test.go                 # Hub lifecycle tests
|   +-- messages_test.go            # Message builder functions
|   +-- export_test.go              # Exposed internals for testing
|   +-- authz_test.go               # Permission checks
|   +-- serve_test.go               # WS upgrade + auth
|   +-- origin_test.go              # Origin validation
|   +-- livekit_test.go             # LiveKit integration
|   +-- voice_handlers_test.go      # Voice join/leave/controls
|   +-- coverage_boost_test.go      # Coverage gap tests
+-- api/
|   +-- router_test.go              # Router construction
|   +-- middleware_test.go          # Auth, rate limit, security
|   +-- auth_handler_test.go        # Login/register handlers
|   +-- invite_handler_test.go      # Invite CRUD
|   +-- channel_handler_test.go     # Channel REST handlers
|   +-- channel_authz_test.go       # Channel authorization
|   +-- clientip_test.go            # IP extraction + proxies
|   +-- contract_test.go            # API response shapes
+-- auth/
|   +-- helpers_test.go             # Ban/session expiry helpers
|   +-- password_test.go            # bcrypt hashing
|   +-- session_test.go             # Token generation
|   +-- tls_test.go                 # TLS cert generation
|   +-- ratelimit_test.go           # Rate limiter
|   +-- ratelimit_cleanup_test.go   # Expiry cleanup
+-- config/
|   +-- config_test.go              # Config loading + env overrides
+-- permissions/
|   +-- permissions_test.go         # Bitfield operations
+-- storage/
|   +-- storage_test.go             # File storage + security
+-- updater/
|   +-- updater_test.go             # Version comparison
+-- admin/
    +-- admin_handler_test.go       # Admin panel handlers
    +-- api_test.go                 # Admin API endpoints
    +-- api_edge_cases_test.go      # Edge case coverage
    +-- handlers_backup_test.go     # Backup operations
    +-- handlers_channels_test.go   # Channel admin
    +-- setup_handler_test.go       # First-run setup
    +-- update_handlers_test.go     # Server update
    +-- middleware_and_spawn_test.go # Admin middleware
    +-- middleware_coverage_test.go  # Coverage gaps
```

---

## 3. NPM Test Scripts

From `package.json`:

```json
{
  "test":              "vitest run",
  "test:unit":         "vitest run tests/unit",
  "test:integration":  "vitest run tests/integration",
  "test:e2e":          "playwright test",
  "test:e2e:prod":     "npm run build && playwright test --config playwright.config.prod.ts",
  "test:e2e:native":   "playwright test --config playwright.config.native.ts",
  "test:e2e:ui":       "playwright test --ui",
  "test:watch":        "vitest",
  "test:coverage":     "vitest run --coverage",
  "typecheck":         "tsc --noEmit",
  "typecheck:build":   "tsc -p tsconfig.build.json --noEmit"
}
```

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `npm test` | Run all vitest tests (unit + integration) | CI, quick check |
| `npm run test:unit` | Unit tests only | During development |
| `npm run test:integration` | Integration tests only | After store changes |
| `npm run test:e2e` | Playwright against Vite dev server | After UI changes |
| `npm run test:e2e:prod` | Build + serve + Playwright | Pre-release validation |
| `npm run test:e2e:native` | Real Tauri exe + CDP | Pre-release validation |
| `npm run test:e2e:ui` | Playwright UI mode (interactive) | Debugging E2E failures |
| `npm run test:watch` | Vitest watch mode | Active development |
| `npm run test:coverage` | Coverage report with V8 | Coverage audit |
| `npm run typecheck` | Full typecheck (all sources) | CI, before commit |
| `npm run typecheck:build` | Typecheck build-only tsconfig | Prod E2E gate |

---

## 4. Vitest Configuration

From `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@lib":        resolve(__dirname, "src/lib"),
      "@stores":     resolve(__dirname, "src/stores"),
      "@components": resolve(__dirname, "src/components"),
      "@pages":      resolve(__dirname, "src/pages"),
      "@styles":     resolve(__dirname, "src/styles"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",                       // entry point
        "src/**/*.d.ts",                     // type declarations
        "src/lib/window-state.ts",           // Tauri-only APIs
        "src/lib/credentials.ts",            // Windows Credential Manager
        "src/lib/audio.ts",                  // Web Audio API
        "src/lib/vad.ts",                    // Voice Activity Detection
        "src/lib/webrtc.ts",                 // WebRTC (needs real browser)
        "src/lib/voiceSession.ts",           // LiveKit session mgmt
        "src/lib/noise-suppression.ts",      // RNNoise WASM
        "src/lib/updater.ts",                // Tauri updater plugin
        "src/pages/MainPage.ts",             // Top-level composition
        "src/components/UpdateNotifier.ts",  // Tauri updater UI
      ],
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 75,
        lines: 75,
      },
    },
  },
});
```

### Key Configuration Details

- **Environment**: `jsdom` -- simulates a browser DOM for unit tests
- **Path aliases**: Match Vite/TypeScript aliases so imports like
  `@lib/api` resolve correctly in tests
- **Coverage provider**: V8 (native, fast, accurate line coverage)
- **Coverage exclusions**: Files that depend on Tauri-specific APIs,
  Web Audio, WebRTC, or WASM are excluded because they cannot run
  in jsdom
- **Thresholds**: 75% across all metrics (statements, branches,
  functions, lines). Build fails if coverage drops below threshold.

---

## 5. Unit Test Patterns

### Protocol Type Validation

Every [[06-Specs/PROTOCOL|PROTOCOL.md]] message type has a test
verifying TypeScript type correctness:

```typescript
// tests/unit/types.test.ts
import { describe, it, expect } from "vitest";
import type { VoiceConfigPayload } from "@lib/types";

describe("VoiceConfigPayload", () => {
  it("uses threshold_mode not mode", () => {
    const payload: VoiceConfigPayload = {
      channel_id: 1,
      bitrate: 64000,
      threshold_mode: "auto",
    };
    expect(payload.threshold_mode).toBe("auto");
    // @ts-expect-error - 'mode' should NOT exist
    expect(payload.mode).toBeUndefined();
  });
});
```

### API Client Path Verification

```typescript
// tests/unit/api.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri HTTP plugin (vi.hoisted ensures fn is available at mock time)
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));

import { createApiClient } from "../../src/lib/api";

describe("API Client", () => {
  let api: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    mockFetch.mockReset();
    api = createApiClient({ host: "localhost:8443", token: "test-token" }, vi.fn());
  });

  it("login calls /api/v1/auth/login", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ token: "t" }));
    await api.login("user", "pass");
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/v1/auth/login");
  });
});
```

### Rate Limiter

```typescript
// tests/unit/rate-limiter.test.ts
describe("RateLimiter", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("blocks rapid fire within window", () => {
    const limiter = new RateLimiter({ windowMs: 3000, maxCount: 1 });
    expect(limiter.canSend("typing:1")).toBe(true);
    limiter.record("typing:1");
    expect(limiter.canSend("typing:1")).toBe(false);
  });

  it("allows after window expires", () => {
    const limiter = new RateLimiter({ windowMs: 3000, maxCount: 1 });
    limiter.record("typing:1");
    vi.advanceTimersByTime(3001);
    expect(limiter.canSend("typing:1")).toBe(true);
  });

  it("isolates keys", () => {
    const limiter = new RateLimiter({ windowMs: 3000, maxCount: 1 });
    limiter.record("typing:1");
    expect(limiter.canSend("typing:2")).toBe(true);
  });
});
```

### Permission Bitfield

```typescript
// tests/unit/permissions.test.ts
describe("permissions", () => {
  it("ADMINISTRATOR bypasses all checks", () => {
    expect(
      hasPermission(Permissions.ADMINISTRATOR, Permissions.BAN_MEMBERS)
    ).toBe(true);
  });

  it("checks specific bit", () => {
    const perms = Permissions.SEND_MESSAGES | Permissions.READ_MESSAGES;
    expect(hasPermission(perms, Permissions.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(perms, Permissions.BAN_MEMBERS)).toBe(false);
  });
});
```

### Store Tests

Each reactive store has a dedicated test file:

```typescript
// tests/unit/auth.store.test.ts
describe("auth store", () => {
  beforeEach(() => authStore.reset());

  it("sets user on login", () => {
    authStore.setUser({ id: 1, username: "admin", role: "admin" });
    expect(authStore.getState().user?.username).toBe("admin");
  });

  it("clears user on logout", () => {
    authStore.setUser({ id: 1, username: "admin", role: "admin" });
    authStore.logout();
    expect(authStore.getState().user).toBeNull();
  });
});
```

### Component Tests

Components are tested by rendering into jsdom and querying the DOM:

```typescript
// tests/unit/<component>.test.ts
describe("MessageInput", () => {
  it("sends message on Enter", () => {
    const container = document.createElement("div");
    const component = new MessageInput(container, { channelId: 1 });

    const input = container.querySelector("textarea")!;
    input.value = "Hello world";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(mockWs.lastSent.type).toBe("chat_send");
    expect(mockWs.lastSent.payload.content).toBe("Hello world");
  });
});
```

---

## 6. Integration Test Patterns

### Store Hydration Flow

Tests the complete ready payload → store population pipeline:

```typescript
// tests/integration/stores.test.ts
describe("store hydration", () => {
  it("ready payload populates channels, members, voice", () => {
    const ws = new MockWebSocket();
    setupStoreSubscriptions(ws);

    ws.simulateMessage({
      type: "ready",
      payload: readyFixture,
    });

    expect(channelsStore.getState().channels).toHaveLength(3);
    expect(membersStore.getState().members).toHaveLength(5);
    expect(voiceStore.getState().voiceStates.size).toBe(2);
  });

  it("typing event expires after 5 seconds", () => {
    vi.useFakeTimers();
    const ws = new MockWebSocket();
    setupStoreSubscriptions(ws);

    ws.simulateMessage({
      type: "typing",
      payload: { channel_id: 1, user_id: 2, username: "alex" },
    });

    expect(uiStore.getState().typingUsers.size).toBe(1);
    vi.advanceTimersByTime(5001);
    expect(uiStore.getState().typingUsers.size).toBe(0);
  });
});
```

### Chat Round Trip (Pattern Example)

Recommended pattern for testing the full send -> ack -> broadcast
pipeline (not yet implemented as a standalone file):

```typescript
// tests/integration/chat.test.ts (proposed)
describe("chat send/receive", () => {
  it("send -> ack -> broadcast", () => {
    const ws = new MockWebSocket();
    const sentId = messagesStore.sendMessage(1, "Hello");

    expect(ws.lastSent.type).toBe("chat_send");
    expect(ws.lastSent.payload.content).toBe("Hello");

    ws.simulateMessage({
      type: "chat_send_ok",
      id: sentId,
      payload: { message_id: 42 },
    });

    ws.simulateMessage({
      type: "chat_message",
      payload: {
        id: 42,
        channel_id: 1,
        author: { id: 1, username: "me", role: "member" },
        content: "Hello",
      },
    });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toHaveLength(1);
    expect(msgs![0].content).toBe("Hello");
    expect(msgs![0].author.role).toBe("member"); // string, NOT number
  });
});
```

---

## 7. E2E Test Patterns (Mocked)

### Login Flow

```typescript
// tests/e2e/connect-page.spec.ts
import { test, expect } from "@playwright/test";

test("user can login and see main page", async ({ page }) => {
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ token: "test-token" }),
    })
  );

  await page.goto("/");
  await page.fill('[data-testid="host-input"]', "localhost:8443");
  await page.fill('[data-testid="username-input"]', "testuser");
  await page.fill('[data-testid="password-input"]', "password");
  await page.click('[data-testid="login-button"]');

  await expect(page.locator('[data-testid="channel-sidebar"]')).toBeVisible();
});
```

### Chat E2E

```typescript
// tests/e2e/message-send-flow.spec.ts
test("user can send and receive messages", async ({ page }) => {
  await loginAsTestUser(page);
  await page.click('[data-testid="channel-general"]');

  await page.fill('[data-testid="message-input"]', "Hello world");
  await page.keyboard.press("Enter");

  await expect(
    page.locator('[data-testid="message-content"]').last()
  ).toHaveText("Hello world");
});
```

### E2E Helper Patterns

```typescript
// tests/e2e/helpers.ts
export async function loginAsTestUser(page: Page) {
  // Mock auth endpoint
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ token: "tk" }) })
  );

  // Mock WebSocket ready payload
  await page.addInitScript(() => {
    // Inject mock WS that sends ready payload on open
  });

  await page.goto("/");
  // Fill login form and submit...
}
```

---

## 8. E2E Test Patterns (Production Build)

The `test:e2e:prod` script builds the app first, then serves the
production dist/ with `vite preview` and runs Playwright against it.

```bash
npm run test:e2e:prod
# Equivalent to:
#   npm run build            -> tsc && vite build
#   playwright test --config playwright.config.prod.ts
```

The prod config (`playwright.config.prod.ts`) differs from the
dev config:
- **baseURL**: `http://localhost:4173` (vite preview port)
- **webServer command**: `npm run preview` (serves built dist/)
- Same test specs as dev E2E (excludes native/)

---

## 9. Native E2E Testing (CDP)

Tests the real Tauri production app via WebView2 Chrome DevTools
Protocol (CDP) connection. See [[04-Decisions/DEC-007-native-e2e-cdp]]
for the architectural decision.

### How It Works

```
1. npm run tauri build        -- creates owncord-client.exe
2. Test fixture launches exe with env:
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
3. Playwright connects: chromium.connectOverCDP('http://127.0.0.1:9222')
4. Tests interact with the REAL WebView2 page (no mocks)
```

### Architecture

```
+---------------------------------------------------------------+
| Test Process (Playwright)                                     |
|                                                               |
|  native-fixture.ts                                            |
|  +-- spawn child process: owncord-client.exe                  |
|  +-- wait for CDP port ready                                  |
|  +-- chromium.connectOverCDP('http://127.0.0.1:9222')        |
|  +-- provide `page` to test spec                              |
|  +-- on test end: kill child process                          |
|                                                               |
|  native/*.spec.ts                                             |
|  +-- Use `page` to interact with real app                     |
|  +-- Real server connection (or OWNCORD_SKIP_SERVER_TESTS=1)  |
+---------------------------------------------------------------+
        |                    |
        v                    v
  owncord-client.exe    chatserver.exe
  (WebView2 window)     (Go server)
```

### When to Use

| Use Mocked E2E | Use Native E2E |
|----------------|----------------|
| UI logic, layout, component behavior | Tauri IPC integration |
| Fast feedback during development | Production build verification |
| CI on every push | Pre-release validation |
| Mock server responses | Real server connection |

### Running Native E2E

```bash
# Requires built exe first
npm run tauri build
npm run test:e2e:native

# Skip server-dependent tests
OWNCORD_SKIP_SERVER_TESTS=1 npm run test:e2e:native

# With real server (configure test credentials)
OWNCORD_SERVER_URL=localhost:8443 OWNCORD_TEST_USER=testuser \
  OWNCORD_TEST_PASS=password npm run test:e2e:native
```

### Native Test Specs

| Spec | Tests |
|------|-------|
| `smoke.spec.ts` | App launches, window visible, title correct |
| `auth-flow.spec.ts` | Real login/register against server |
| `chat-operations.spec.ts` | Send/receive messages, edit, delete |
| `channel-navigation.spec.ts` | Switch channels, create, rename |
| `overlays.spec.ts` | Settings, invite, member list overlays |
| `settings-overlay.spec.ts` | User settings persistence |
| `voice-controls.spec.ts` | Voice join/leave, mute/deafen |
| `app-layout.spec.ts` | Sidebar, chat area, responsive layout |

### Login Timeout

Native E2E tests use a 60-second login timeout due to potential
server rate limiting. See [[feedback_native_e2e_timing]].

---

## 10. Playwright Configuration Reference

### Default Config (`playwright.config.ts`)

| Setting | Value | Purpose |
|---------|-------|---------|
| testDir | `./tests/e2e` | E2E test directory |
| testIgnore | `**/native/**` | Exclude native tests |
| timeout | 30,000ms | Per-test timeout |
| expect.timeout | 5,000ms | Assertion timeout |
| fullyParallel | true | Parallel test execution |
| retries | 1 (CI: 2) | Retry failed tests |
| workers | undefined (CI: 1) | Parallel workers |
| baseURL | `http://localhost:1420` | Vite dev server |
| actionTimeout | 10,000ms | Click/fill timeout |
| navigationTimeout | 15,000ms | Page navigation timeout |
| screenshot | only-on-failure | Capture on failure |
| trace | on-first-retry | Trace on first retry |
| video | on-first-retry | Video on first retry |
| reducedMotion | reduce | Disable animations |
| webServer.command | `npm run dev` | Start Vite dev server |
| webServer.timeout | 60,000ms | Dev server start timeout |

### Native Config (`playwright.config.native.ts`)

| Setting | Value | Purpose |
|---------|-------|---------|
| testDir | `./tests/e2e/native` | Native test directory |
| timeout | 60,000ms | Higher (real app startup) |
| expect.timeout | 10,000ms | Higher for real network |
| fullyParallel | false | Sequential execution |
| workers | 1 | Single worker (one app) |
| retries | 2 | More retries for flakiness |
| actionTimeout | 15,000ms | Real app is slower |
| navigationTimeout | 30,000ms | Real server latency |
| webServer | none | Fixture launches app |

### Production Config (`playwright.config.prod.ts`)

| Setting | Value | Purpose |
|---------|-------|---------|
| baseURL | `http://localhost:4173` | Vite preview port |
| webServer.command | `npm run preview` | Serve production build |
| Same as default for all other settings. | | |

### CI-Specific Reporter

```
CI:  [["html", { open: "never" }], ["junit", { outputFile: "test-results/junit.xml" }]]
Dev: "html"
```

---

## 11. Mock Utilities

### MockWebSocket

```typescript
// tests/helpers/mock-ws.ts
export class MockWebSocket {
  sent: any[] = [];
  listeners: Map<string, Function[]> = new Map();

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  get lastSent() {
    return this.sent[this.sent.length - 1];
  }

  simulateMessage(msg: any) {
    const handlers = this.listeners.get("message") ?? [];
    handlers.forEach((h) => h({ data: JSON.stringify(msg) }));
  }

  addEventListener(event: string, handler: Function) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }
}
```

### MockFetch

```typescript
// tests/helpers/mock-fetch.ts
export function createMockFetch(routes: Record<string, any>) {
  return vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "NOT_FOUND" }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(handler),
    });
  });
}
```

### Tauri IPC Mock

For unit tests that use `invoke()`:

```typescript
// Mock Tauri IPC for jsdom
globalThis.__TAURI_INTERNALS__ = {
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings": return Promise.resolve({});
      case "save_settings": return Promise.resolve();
      case "load_credential": return Promise.resolve(null);
      default: return Promise.reject(`unknown command: ${cmd}`);
    }
  }),
};
```

---

## 12. Test Fixtures

### Ready Payload Fixture

```typescript
// tests/helpers/fixtures.ts
export const readyFixture = {
  server: { name: "Test Server", icon: null },
  channels: [
    { id: 1, name: "general", type: "text", category: "Text Channels",
      position: 0, unread_count: 3, last_message_id: 100 },
    { id: 2, name: "random", type: "text", category: "Text Channels",
      position: 1, unread_count: 0, last_message_id: 50 },
    { id: 3, name: "Voice Chat", type: "voice", category: "Voice Channels",
      position: 0 },
  ],
  members: [
    { id: 1, username: "admin", role: "admin", status: "online" },
    { id: 2, username: "user1", role: "member", status: "online" },
  ],
  voice_states: [
    { user_id: 1, channel_id: 3, username: "admin",
      muted: false, deafened: false, speaking: false,
      camera: false, screenshare: false },
  ],
  roles: [
    { id: 1, name: "Owner", color: "#e74c3c", position: 100,
      permissions: 0x7FFFFFFF },
    { id: 2, name: "Admin", color: "#f1c40f", position: 50,
      permissions: 0x3FFFFFFF },
    { id: 3, name: "Member", color: null, position: 0,
      permissions: 0x3 },
  ],
};

export const chatMessageFixture = {
  id: 42,
  channel_id: 1,
  author: { id: 2, username: "user1", role: "member", avatar: null },
  content: "Hello everyone!",
  timestamp: "2026-03-15T12:00:00Z",
  attachments: [],
  reactions: [],
  reply_to: null,
  edited: false,
};
```

---

## 13. Rust Tests

Rust tests live in `src-tauri/src/` using the standard `#[cfg(test)]`
attribute. There are **25 unit tests** across 4 modules:

| Module | Tests | What They Cover |
|--------|-------|-----------------|
| `commands.rs` | IPC command handlers | Argument validation, return shapes |
| `ws_proxy.rs` | WebSocket proxy | URL construction, TLS/plain branching, header forwarding |
| `livekit_proxy.rs` | LiveKit proxy | URL schemes (ws/wss), path construction, error cases |
| `credentials.rs` | Credential Manager | Save/load/delete round-trip, missing-credential handling |

### Credentials Test (example)

```rust
// src-tauri/src/credentials.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_and_load_credential() {
        let host = "test-server.local";
        let token = "test-token-12345";
        let username = "testuser";

        save_credential(
            host.to_string(),
            username.to_string(),
            token.to_string(),
            None,
        ).unwrap();

        let loaded = load_credential(host.to_string()).unwrap();
        assert!(loaded.is_some());
        let cred = loaded.unwrap();
        assert_eq!(cred.username, username);
        assert_eq!(cred.token, token);
        assert!(cred.password.is_none());

        delete_credential(host.to_string()).unwrap();
        let deleted = load_credential(host.to_string()).unwrap();
        assert!(deleted.is_none());
    }
}
```

### Running Rust Tests

```bash
cd Client/tauri-client/src-tauri
cargo test                # run all Rust tests
cargo test -- --nocapture # with stdout output
```

Note: Credential tests interact with Windows Credential Manager
and require a logged-in Windows user session.

---

## 14. Go Server Tests

### Database Test Setup

All Go tests use in-memory SQLite for isolation:

```go
func openMemory(t *testing.T) *db.DB {
    t.Helper()
    database, err := db.Open(":memory:")
    if err != nil {
        t.Fatalf("Open(':memory:') error: %v", err)
    }
    t.Cleanup(func() { _ = database.Close() })
    return database
}
```

Migration is applied via `db.Migrate(database)` for full schema or
`db.MigrateFS(database, fs)` for custom test schemas.

### WS Hub Test Setup

```go
func newTestHub(t *testing.T) (*ws.Hub, *db.DB) {
    t.Helper()
    database := openTestDB(t)           // in-memory + MigrateFS
    limiter := auth.NewRateLimiter()
    hub := ws.NewHub(database, limiter)
    return hub, database
}
```

For voice tests, the schema includes voice_states:

```go
func newVoiceHub(t *testing.T) (*ws.Hub, *db.DB) {
    database := openVoiceTestDB(t)      // includes voice_states DDL
    limiter := auth.NewRateLimiter()
    hub := ws.NewHub(database, limiter)
    go hub.Run()
    t.Cleanup(func() { hub.Stop() })
    return hub, database
}
```

### Seed Helpers

```go
func seedTestUser(t *testing.T, database *db.DB, username string) int64
func seedOwnerUser(t *testing.T, database *db.DB, username string) *db.User
func seedTestChannel(t *testing.T, database *db.DB, name string) int64
func seedVoiceChan(t *testing.T, database *db.DB, name string) int64
```

### Exposing Unexported Functions

`ws/export_test.go` (compiled only during `go test`):

```go
package ws // same package to access unexported symbols

func (h *Hub) BuildAuthOKForTest(user *db.User, roleName string) []byte {
    return h.buildAuthOK(user, roleName)
}
```

### HTTP Handler Tests

```go
func TestSomeHandler(t *testing.T) {
    database := openMemory(t)
    db.Migrate(database)

    r := chi.NewRouter()
    r.Post("/api/v1/endpoint", handleEndpoint(database))

    body := `{"key": "value"}`
    req := httptest.NewRequest("POST", "/api/v1/endpoint", strings.NewReader(body))
    w := httptest.NewRecorder()

    r.ServeHTTP(w, req)

    if w.Code != http.StatusOK {
        t.Errorf("got %d, want 200", w.Code)
    }
}
```

### Go Test Commands

```bash
cd Server
go test ./...                    # all tests
go test ./... -cover             # with coverage
go test -race ./...              # with race detector
go test -v ./ws/...              # verbose, ws package only
go test -run TestSpecific ./db/  # single test
go test -count=1 ./...           # disable test caching
```

### Go Test Conventions

- `t.Helper()` in every test helper function
- `t.Cleanup()` for teardown (runs after test completes)
- `t.Fatalf()` for setup failures; `t.Errorf()` for assertions
- `t.TempDir()` for file-based tests (auto-cleaned)
- `testing/fstest.MapFS` for custom migration schemas
- Package `_test` suffix for black-box tests (e.g., `db_test`)
- Same-package for white-box access (e.g., `ws/export_test.go`)

---

## 15. Audit Regression Tests

Tests that prevent re-introducing bugs found during audits:

| Test | What It Prevents | Severity |
|------|------------------|----------|
| API paths use `/api/v1/` prefix | Ensures client calls correct versioned endpoints | CRITICAL |
| VoiceConfig has `threshold_mode` | Deserialization failure | CRITICAL |
| VoiceSpeakers has `threshold_mode` | Deserialization failure | CRITICAL |
| Message role is string not number | Wrong role colors in UI | HIGH |
| member_leave handler exists | Members not removed on disconnect | HIGH |
| voice_leave includes channel_id | Server voice state mismatch | HIGH |
| Reaction sends WS message | Feature completely non-functional | HIGH |
| Status picker has no "invisible" | Server rejects invalid value | MEDIUM |

---

## 16. Coverage Configuration

### Client (Vitest + V8)

```
Provider:    v8 (native V8 coverage)
Include:     src/**/*.ts
Exclude:     main.ts, *.d.ts, Tauri-only modules, WebRTC, WASM
Thresholds:  75% statements, branches, functions, lines
```

### Server (Go built-in)

```bash
# Generate coverage report
go test ./... -coverprofile=coverage.out

# View in browser
go tool cover -html=coverage.out

# Check specific package
go test -cover ./ws/...
```

### Coverage Exclusion Rationale

Client files excluded from coverage are modules that require
platform-specific runtime features unavailable in jsdom:

| Excluded File | Reason | Status |
|--------------|--------|--------|
| `window-state.ts` | Tauri WebviewWindow API | Active |
| `credentials.ts` | Windows Credential Manager IPC | Active |
| `audio.ts` | Web Audio API (AudioContext) | **Stale** -- file removed in LiveKit migration |
| `vad.ts` | Voice Activity Detection (AudioWorklet) | **Stale** -- file removed in LiveKit migration |
| `webrtc.ts` | WebRTC peer connections | **Stale** -- file removed in LiveKit migration |
| `voiceSession.ts` | LiveKit SDK (WebRTC) | **Stale** -- renamed to `livekitSession.ts` (new file is NOT excluded; has `livekit-session.test.ts`) |
| `noise-suppression.ts` | RNNoise WASM module | Active |
| `updater.ts` | Tauri updater plugin | Active |
| `MainPage.ts` | Composition root (tested via E2E) | Active |
| `UpdateNotifier.ts` | Tauri updater UI component | Active |

**Action needed:** Clean up `vitest.config.ts` exclusions to remove the
4 stale entries (`audio.ts`, `vad.ts`, `webrtc.ts`, `voiceSession.ts`).

Active exclusions are covered by native E2E tests instead.

---

## 17. CI Pipeline

```yaml
# .github/workflows/client-test.yml
name: Client Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        working-directory: Client/tauri-client
        run: npm ci

      - name: Run unit tests
        working-directory: Client/tauri-client
        run: npm run test:unit

      - name: Run integration tests
        working-directory: Client/tauri-client
        run: npm run test:integration

      - name: Check coverage
        working-directory: Client/tauri-client
        run: npm run test:coverage -- --reporter=json
        # Fails if below 75% thresholds

      - name: Install Playwright browsers
        working-directory: Client/tauri-client
        run: npx playwright install --with-deps

      - name: Run E2E tests (mocked)
        working-directory: Client/tauri-client
        run: npm run test:e2e

      - name: Build Tauri
        working-directory: Client/tauri-client
        run: npm run tauri build

      - name: Run Rust tests
        working-directory: Client/tauri-client/src-tauri
        run: cargo test

  server-test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'

      - name: Run Go tests
        working-directory: Server
        run: go test ./... -cover -race
```

---

## 18. Writing New Tests

### Adding a Client Unit Test

1. Create `tests/unit/<feature>.test.ts`
2. Import from `@lib/<module>` using path aliases
3. Use `describe` / `it` / `expect` from vitest
4. Mock external dependencies (`vi.fn()`, `vi.mock()`)
5. Run: `npm run test:unit -- --filter <feature>`

### Adding a Client E2E Test

1. Create `tests/e2e/<feature>.spec.ts`
2. Use `page.route()` to mock server responses
3. Use `data-testid` attributes for reliable selectors
4. Use helpers from `tests/e2e/helpers.ts`
5. Run: `npx playwright test <feature>`

### Adding a Go Server Test

1. Create `<package>/<feature>_test.go`
2. Use `openMemory(t)` + `db.Migrate(database)` for DB setup
3. Use `httptest.NewRecorder` for HTTP handler tests
4. Use `NewTestClient` / `NewTestClientWithUser` for WS tests
5. Run: `go test -v ./<package>/... -run TestFeature`

### Test Naming Conventions

| Layer | File Pattern | Function Pattern |
|-------|-------------|------------------|
| Client unit | `<module>.test.ts` | `describe("<Module>") > it("...")` |
| Client E2E | `<feature>.spec.ts` | `test("user can ...")` |
| Go unit | `<file>_test.go` | `TestFuncName(t *testing.T)` |
| Go integration | `<pkg>_integration_test.go` | `TestIntegration_Scenario` |
| Rust | `#[test] fn test_*()` | Within `#[cfg(test)] mod tests` |
