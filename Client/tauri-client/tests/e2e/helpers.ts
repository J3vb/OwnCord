/**
 * Shared E2E test helpers — Tauri mock injection for browser-based testing.
 *
 * The app uses Tauri IPC through __TAURI_INTERNALS__.invoke:
 * - HTTP: plugin:http|fetch → plugin:http|fetch_send → plugin:http|fetch_read_body
 * - WS:   ws_connect, ws_send, ws_disconnect + events ws-state, ws-message
 * - Events: plugin:event|listen, plugin:event|unlisten
 */

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Mock data — basic
// ---------------------------------------------------------------------------

export const MOCK_TOKEN = "mock-session-token-abc123";

export const MOCK_LOGIN_RESPONSE = {
  token: MOCK_TOKEN,
  requires_2fa: false,
};

export const MOCK_LOGIN_2FA_RESPONSE = {
  requires_2fa: true,
  partial_token: "mock-partial-token",
};

export const MOCK_CHANNELS = [
  { id: 1, name: "general", type: "text", position: 0, topic: "General chat" },
  { id: 2, name: "random", type: "text", position: 1, topic: "Off-topic" },
];

export const MOCK_MESSAGES = {
  messages: [
    {
      id: 101,
      channel_id: 1,
      user: { id: 1, username: "testuser", avatar: "" },
      content: "Hello world!",
      timestamp: "2026-03-15T10:00:00Z",
      edited_at: null,
      attachments: [],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
  ],
  has_more: false,
};

export const MOCK_READY_PAYLOAD = {
  type: "ready",
  payload: {
    user: { id: 1, username: "testuser", avatar: "", status: "online" },
    server_name: "Test Server",
    motd: "Welcome to the test server",
    channels: MOCK_CHANNELS,
    members: [
      { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
      { id: 2, username: "otheruser", avatar: "", status: "online", role: "member" },
    ],
    voice_states: [],
  },
};

export const MOCK_AUTH_OK = {
  type: "auth_ok",
  payload: {
    user: { id: 1, username: "testuser", avatar: "", status: "online" },
    server_name: "Test Server",
    motd: "Welcome to the test server",
  },
};

// ---------------------------------------------------------------------------
// Mock data — rich (for extended tests)
// ---------------------------------------------------------------------------

export const MOCK_CHANNELS_WITH_CATEGORIES = [
  { id: 1, name: "general", type: "text", position: 0, topic: "General chat", category: "Text Channels" },
  { id: 2, name: "random", type: "text", position: 1, topic: "Off-topic", category: "Text Channels" },
  { id: 3, name: "announcements", type: "text", position: 2, topic: "Important updates", category: "Information" },
  { id: 10, name: "Voice Chat", type: "voice", position: 3, topic: "", category: "Voice Channels" },
  { id: 11, name: "Music", type: "voice", position: 4, topic: "", category: "Voice Channels" },
];

export const MOCK_MEMBERS_MULTI_ROLE = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  { id: 2, username: "moderator1", avatar: "", status: "online", role: "moderator" },
  { id: 3, username: "member1", avatar: "", status: "idle", role: "member" },
  { id: 4, username: "member2", avatar: "", status: "dnd", role: "member" },
  { id: 5, username: "offlineuser", avatar: "", status: "offline", role: "member" },
];

export const MOCK_MESSAGES_RICH = {
  messages: [
    {
      id: 101,
      channel_id: 1,
      user: { id: 1, username: "testuser", avatar: "" },
      content: "Hello world!",
      timestamp: "2026-03-15T10:00:00Z",
      edited_at: null,
      attachments: [],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
    {
      id: 102,
      channel_id: 1,
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Hey @testuser, check this out!",
      timestamp: "2026-03-15T10:01:00Z",
      edited_at: null,
      attachments: [],
      reactions: [{ emoji: "\uD83D\uDC4D", count: 2, me: true }],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
    {
      id: 103,
      channel_id: 1,
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "```js\nconsole.log('code block');\n```",
      timestamp: "2026-03-15T10:01:30Z",
      edited_at: null,
      attachments: [],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
    {
      id: 104,
      channel_id: 1,
      user: { id: 1, username: "testuser", avatar: "" },
      content: "Replying to your message",
      timestamp: "2026-03-15T10:02:00Z",
      edited_at: "2026-03-15T10:02:30Z",
      attachments: [],
      reactions: [],
      reply_to: 102,
      pinned: false,
      deleted: false,
    },
    {
      id: 105,
      channel_id: 1,
      user: { id: 3, username: "member1", avatar: "" },
      content: "Check this image",
      timestamp: "2026-03-15T10:03:00Z",
      edited_at: null,
      attachments: [
        { id: "1", filename: "screenshot.png", size: 102400, mime: "image/png", url: "/uploads/screenshot.png" },
      ],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
    {
      id: 106,
      channel_id: 1,
      user: { id: 3, username: "member1", avatar: "" },
      content: "And this document",
      timestamp: "2026-03-15T10:03:30Z",
      edited_at: null,
      attachments: [
        { id: "2", filename: "report.pdf", size: 512000, mime: "application/pdf", url: "/uploads/report.pdf" },
      ],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
  ],
  has_more: true,
};

export const MOCK_VOICE_STATE = [
  { user_id: 1, channel_id: 10, muted: false, deafened: false },
  { user_id: 2, channel_id: 10, muted: true, deafened: false },
];

export const MOCK_PINNED_MESSAGES = [
  {
    id: 101,
    channel_id: 1,
    user: { id: 1, username: "testuser", avatar: "" },
    content: "Hello world!",
    created_at: "2026-03-15T10:00:00Z",
    pinned: true,
  },
];

export const MOCK_INVITES = [
  {
    code: "abc123",
    uses: 3,
    max_uses: 10,
    created_by: { id: 1, username: "testuser" },
    expires_at: "2026-04-15T00:00:00Z",
  },
  {
    code: "xyz789",
    uses: 0,
    max_uses: 1,
    created_by: { id: 2, username: "otheruser" },
    expires_at: null,
  },
];

// ---------------------------------------------------------------------------
// Ready payload builders
// ---------------------------------------------------------------------------

function buildReadyPayload(overrides?: {
  channels?: unknown[];
  members?: unknown[];
  voice_states?: unknown[];
}): unknown {
  return {
    type: "ready",
    payload: {
      user: { id: 1, username: "testuser", avatar: "", status: "online" },
      server_name: "Test Server",
      motd: "Welcome to the test server",
      channels: overrides?.channels ?? MOCK_CHANNELS,
      members: overrides?.members ?? MOCK_READY_PAYLOAD.payload.members,
      voice_states: overrides?.voice_states ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tauri mock script builder
// ---------------------------------------------------------------------------

function buildTauriMockScript(opts: {
  httpRoutes: Array<{ pattern: string; status: number; body: unknown }>;
  simulateWsFlow: boolean;
  readyOverrides?: {
    channels?: unknown[];
    members?: unknown[];
    voice_states?: unknown[];
  };
}): string {
  const readyPayload = buildReadyPayload(opts.readyOverrides);

  return `
    // -----------------------------------------------------------------------
    // Event system
    // -----------------------------------------------------------------------
    const __eventListeners = {};
    let __callbackId = 0;

    function __tauriEmitEvent(eventName, payload) {
      const listeners = __eventListeners[eventName] || [];
      for (const { handler } of listeners) {
        try { handler({ payload, event: eventName, id: 0 }); }
        catch (e) { console.error("[tauri-mock] event error", eventName, e); }
      }
    }
    window.__tauriEmitEvent = __tauriEmitEvent;

    // -----------------------------------------------------------------------
    // HTTP mock state
    // -----------------------------------------------------------------------
    const HTTP_ROUTES = ${JSON.stringify(opts.httpRoutes)};
    let __nextRid = 1;
    const __pendingFetch = {};   // rid → { url, route }
    const __pendingBody = {};    // responseRid → Uint8Array (body bytes)
    let __bodyRead = {};         // responseRid → boolean (already read)

    // Sort routes by pattern length (longest first) to match most specific route
    HTTP_ROUTES.sort((a, b) => b.pattern.length - a.pattern.length);

    function matchRoute(url) {
      for (const route of HTTP_ROUTES) {
        if (url.includes(route.pattern)) return route;
      }
      return null;
    }

    // -----------------------------------------------------------------------
    // __TAURI_INTERNALS__
    // -----------------------------------------------------------------------
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },

      transformCallback: (callback, once) => {
        const id = __callbackId++;
        if (typeof callback === "function") {
          window["__tcb_" + id] = callback;
        }
        return id;
      },

      invoke: async (cmd, args) => {
        // ---- Events ----
        if (cmd === "plugin:event|listen") {
          const eventName = args?.event;
          const handlerId = args?.handler;
          const cb = window["__tcb_" + handlerId];
          if (eventName && cb) {
            if (!__eventListeners[eventName]) __eventListeners[eventName] = [];
            __eventListeners[eventName].push({ id: handlerId, handler: cb });
          }
          return handlerId || 0;
        }
        if (cmd === "plugin:event|unlisten") return;

        // ---- HTTP: fetch (step 1 — register request, return rid) ----
        if (cmd === "plugin:http|fetch") {
          const url = args?.clientConfig?.url || args?.url || "";
          const rid = __nextRid++;
          const route = matchRoute(url);
          __pendingFetch[rid] = { url, route };
          return rid;
        }

        // ---- HTTP: fetch_send (step 2 — return status + headers) ----
        if (cmd === "plugin:http|fetch_send") {
          const rid = args?.rid;
          const pending = __pendingFetch[rid];
          delete __pendingFetch[rid];

          const responseRid = __nextRid++;

          if (pending?.route) {
            const bodyStr = JSON.stringify(pending.route.body);
            const encoder = new TextEncoder();
            const bodyBytes = encoder.encode(bodyStr);
            __pendingBody[responseRid] = bodyBytes;
            __bodyRead[responseRid] = false;

            return {
              status: pending.route.status,
              statusText: pending.route.status === 200 ? "OK" : "Error",
              url: pending.url,
              headers: [["content-type", "application/json"]],
              rid: responseRid,
            };
          }

          // No matching route — 404
          const fallback = JSON.stringify({ error: "NOT_FOUND", message: "mocked 404" });
          const encoder = new TextEncoder();
          __pendingBody[responseRid] = encoder.encode(fallback);
          __bodyRead[responseRid] = false;
          return {
            status: 404,
            statusText: "Not Found",
            url: pending?.url || "",
            headers: [["content-type", "application/json"]],
            rid: responseRid,
          };
        }

        // ---- HTTP: fetch_read_body (step 3 — return body bytes) ----
        if (cmd === "plugin:http|fetch_read_body") {
          const rid = args?.rid;
          const body = __pendingBody[rid];

          if (body && !__bodyRead[rid]) {
            __bodyRead[rid] = true;
            const result = Array.from(body);
            result.push(0); // 0 = not end yet
            return result;
          }

          // End signal: [1]
          delete __pendingBody[rid];
          delete __bodyRead[rid];
          return [1];
        }

        // ---- HTTP: cancel ----
        if (cmd === "plugin:http|fetch_cancel" || cmd === "plugin:http|fetch_cancel_body") {
          return;
        }

        // ---- WS commands ----
        if (cmd === "ws_connect") {
          ${opts.simulateWsFlow ? `
          setTimeout(() => __tauriEmitEvent("ws-state", "open"), 100);
          ` : ""}
          return;
        }
        if (cmd === "ws_send") {
          ${opts.simulateWsFlow ? `
          try {
            const parsed = JSON.parse(args?.message || "{}");
            if (parsed.type === "auth") {
              setTimeout(() => {
                __tauriEmitEvent("ws-message", JSON.stringify(${JSON.stringify(MOCK_AUTH_OK)}));
              }, 100);
              setTimeout(() => {
                __tauriEmitEvent("ws-message", JSON.stringify(${JSON.stringify(readyPayload)}));
              }, 200);
            }
          } catch (e) {}
          ` : ""}
          return;
        }
        if (cmd === "ws_disconnect") return;

        // ---- Credentials ----
        if (cmd === "save_credential" || cmd === "delete_credential" || cmd === "load_credential") return null;

        // ---- Settings ----
        if (cmd === "get_settings") return {};
        if (cmd === "save_settings") return;

        // ---- Certs ----
        if (cmd === "store_cert_fingerprint" || cmd === "get_cert_fingerprint") return null;

        // ---- Window/webview plugin stubs ----
        if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return null;

        console.log("[tauri-mock] unhandled invoke:", cmd);
        return null;
      },

      convertFileSrc: (path) => path,
    };
  `;
}

// ---------------------------------------------------------------------------
// Public API — mock injection
// ---------------------------------------------------------------------------

export async function mockTauriConnect(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
    ],
    simulateWsFlow: false,
  }));
}

export async function mockTauriConnectWith2FA(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_2FA_RESPONSE },
    ],
    simulateWsFlow: false,
  }));
}

export async function mockTauriFullSession(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
    ],
    simulateWsFlow: true,
  }));
}

export async function mockTauriFullSessionWithMessages(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES_RICH },
      { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      { pattern: "/api/v1/invites", status: 200, body: MOCK_INVITES },
    ],
    simulateWsFlow: true,
    readyOverrides: {
      channels: MOCK_CHANNELS_WITH_CATEGORIES,
      members: MOCK_MEMBERS_MULTI_ROLE,
    },
  }));
}

export async function mockTauriFullSessionWithVoice(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
    ],
    simulateWsFlow: true,
    readyOverrides: {
      channels: MOCK_CHANNELS_WITH_CATEGORIES,
      members: MOCK_MEMBERS_MULTI_ROLE,
      voice_states: MOCK_VOICE_STATE,
    },
  }));
}

export async function mockTauriLoginError(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 401, body: { error: "INVALID_CREDENTIALS", message: "Invalid username or password" } },
    ],
    simulateWsFlow: false,
  }));
}

// ---------------------------------------------------------------------------
// Public API — page actions
// ---------------------------------------------------------------------------

export async function submitLogin(page: Page): Promise<void> {
  await page.locator("#host").fill("localhost:8443");
  await page.locator("#username").fill("testuser");
  await page.locator("#password").fill("password123");
  await page.locator("button.btn-primary[type='submit']").click();
}

/**
 * Login and wait for the main app layout to appear.
 */
export async function navigateToMainPage(page: Page): Promise<void> {
  await submitLogin(page);
  const appLayout = page.locator(".app");
  await expect(appLayout).toBeVisible({ timeout: 15_000 });
}

/**
 * Emit a WebSocket event from the mock server to the client.
 * Must be called after the page has loaded and WS listeners are registered.
 */
export async function emitWsEvent(
  page: Page,
  eventName: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ event, data }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__tauriEmitEvent(event, typeof data === "string" ? data : JSON.stringify(data));
    },
    { event: eventName, data: payload },
  );
}

/**
 * Emit a WS message event (shorthand for ws-message).
 */
export async function emitWsMessage(page: Page, message: unknown): Promise<void> {
  await emitWsEvent(page, "ws-message", JSON.stringify(message));
}
