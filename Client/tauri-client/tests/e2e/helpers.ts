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
  { id: 1, name: "general", type: "text", position: 0, category: null },
  { id: 2, name: "random", type: "text", position: 1, category: null },
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

export const MOCK_ROLES = [
  { id: 1, name: "admin", color: "#ff0000", permissions: 0x40000000 },
  { id: 2, name: "moderator", color: "#00aaff", permissions: 0x1000000 },
  { id: 3, name: "member", color: null, permissions: 0x3 },
];

export const MOCK_READY_PAYLOAD = {
  type: "ready",
  payload: {
    channels: MOCK_CHANNELS,
    members: [
      { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
      { id: 2, username: "otheruser", avatar: "", status: "online", role: "member" },
    ],
    voice_states: [],
    roles: MOCK_ROLES,
  },
};

export const MOCK_AUTH_OK = {
  type: "auth_ok",
  payload: {
    user: { id: 1, username: "testuser", avatar: "", role: "admin" },
    server_name: "Test Server",
    motd: "Welcome to the test server",
  },
};

// ---------------------------------------------------------------------------
// Mock data — rich (for extended tests)
// ---------------------------------------------------------------------------

export const MOCK_CHANNELS_WITH_CATEGORIES = [
  { id: 1, name: "general", type: "text", position: 0, category: "Text Channels" },
  { id: 2, name: "random", type: "text", position: 1, category: "Text Channels" },
  { id: 3, name: "announcements", type: "text", position: 2, category: "Information" },
  { id: 10, name: "Voice Chat", type: "voice", position: 3, category: "Voice Channels" },
  { id: 11, name: "Music", type: "voice", position: 4, category: "Voice Channels" },
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

export const MOCK_PINNED_MESSAGES = {
  messages: [
    {
      id: 101,
      channel_id: 1,
      user: { id: 1, username: "testuser", avatar: "" },
      content: "Hello world!",
      timestamp: "2026-03-15T10:00:00Z",
      pinned: true,
      edited_at: null,
      deleted: false,
      reply_to: null,
      attachments: [],
      reactions: [],
    },
  ],
  has_more: false,
};

export const MOCK_INVITES = [
  {
    id: 1,
    code: "abc123",
    url: "https://localhost:8443/invite/abc123",
    use_count: 3,
    max_uses: 10,
    expires_at: "2026-04-15T00:00:00Z",
  },
  {
    id: 2,
    code: "xyz789",
    url: "https://localhost:8443/invite/xyz789",
    use_count: 0,
    max_uses: 1,
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
  roles?: unknown[];
  dm_channels?: unknown[];
}): unknown {
  return {
    type: "ready",
    payload: {
      channels: overrides?.channels ?? MOCK_CHANNELS,
      members: overrides?.members ?? MOCK_READY_PAYLOAD.payload.members,
      voice_states: overrides?.voice_states ?? [],
      roles: overrides?.roles ?? MOCK_ROLES,
      dm_channels: overrides?.dm_channels ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// WS handler registry helpers
// ---------------------------------------------------------------------------

/**
 * Chat echo handlers for E2E testing.
 * Returns wsHandler entries that simulate server-side chat_send, chat_edit,
 * and chat_delete echo responses.
 */
export function chatEchoHandlers(): Array<{ type: string; handler: string }> {
  return [
    {
      type: "chat_send",
      handler: `
        var p = parsed.payload;
        var echo = {
          type: "chat_message",
          payload: {
            id: Date.now(),
            channel_id: p.channel_id,
            user: { id: 1, username: "testuser", avatar: "" },
            content: p.content,
            timestamp: new Date().toISOString(),
            edited_at: null,
            attachments: p.attachments || [],
            reactions: [],
            reply_to: p.reply_to || null,
            pinned: false,
            deleted: false
          }
        };
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify(echo));
        }, 50);
      `,
    },
    {
      type: "chat_edit",
      handler: `
        var echo = {
          type: "chat_edited",
          payload: {
            message_id: parsed.payload.message_id,
            channel_id: parsed.payload.channel_id || 1,
            content: parsed.payload.content,
            edited_at: new Date().toISOString()
          }
        };
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify(echo));
        }, 50);
      `,
    },
    {
      type: "chat_delete",
      handler: `
        var echo = {
          type: "chat_deleted",
          payload: {
            message_id: parsed.payload.message_id,
            channel_id: parsed.payload.channel_id || 1
          }
        };
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify(echo));
        }, 50);
      `,
    },
  ];
}

/**
 * Voice WS flow handlers for E2E testing.
 * Simulates the server-side voice protocol defined in:
 *   docs/brain/06-Specs/PROTOCOL.md (voice_join, voice_leave, voice_token, voice_token_refresh)
 *   docs/protocol-schema.json (message type schemas)
 *
 * When PROTOCOL.md voice message types change, update these handlers to match.
 */
export function voiceWsHandlers(): Array<{ type: string; handler: string }> {
  return [
    {
      type: "voice_join",
      handler: `
        var p = parsed.payload;
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify({
            type: "voice_state",
            payload: { user_id: 1, channel_id: p.channel_id, muted: false, deafened: false }
          }));
        }, 50);
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify({
            type: "voice_token",
            payload: { token: "mock-livekit-token", url: "ws://localhost:7880", channel_id: p.channel_id, direct_url: "" }
          }));
        }, 100);
      `,
    },
    {
      type: "voice_leave",
      handler: `
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify({
            type: "voice_leave",
            payload: { user_id: 1, channel_id: 0 }
          }));
        }, 50);
      `,
    },
    {
      type: "voice_token_refresh",
      handler: `
        setTimeout(function() {
          __tauriEmitEvent("ws-message", JSON.stringify({
            type: "voice_token",
            payload: { token: "mock-livekit-token-refreshed", url: "ws://localhost:7880", channel_id: 0, direct_url: "" }
          }));
        }, 50);
      `,
    },
  ];
}

/**
 * Voice join failure handler for E2E testing.
 * Simulates a server error response when attempting to join a voice channel.
 */
export function voiceJoinFailureHandler(): { type: string; handler: string } {
  return {
    type: "voice_join",
    handler: `
      var p = parsed.payload;
      setTimeout(function() {
        __tauriEmitEvent("ws-message", JSON.stringify({
          type: "error",
          payload: { code: "VOICE_JOIN_FAILED", message: "Failed to join voice channel" }
        }));
      }, 50);
    `,
  };
}

// ---------------------------------------------------------------------------
// Tauri mock script builder
// ---------------------------------------------------------------------------

export function buildTauriMockScript(opts: {
  httpRoutes: Array<{ pattern: string; status: number; body: unknown }>;
  simulateWsFlow: boolean;
  echoChatSend?: boolean;
  wsHandlers?: Array<{ type: string; handler: string }>;
  readyOverrides?: {
    channels?: unknown[];
    members?: unknown[];
    voice_states?: unknown[];
    dm_channels?: unknown[];
  };
}): string {
  const readyPayload = buildReadyPayload(opts.readyOverrides);

  // Merge explicit wsHandlers with auto-generated chat echo handlers
  const allWsHandlers: Array<{ type: string; handler: string }> = [
    ...(opts.wsHandlers ?? []),
    ...(opts.echoChatSend ? chatEchoHandlers() : []),
  ];

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
            var parsed = JSON.parse(args?.message || "{}");
            if (parsed.type === "auth") {
              setTimeout(function() {
                __tauriEmitEvent("ws-message", JSON.stringify(${JSON.stringify(MOCK_AUTH_OK)}));
              }, 100);
              setTimeout(function() {
                __tauriEmitEvent("ws-message", JSON.stringify(${JSON.stringify(readyPayload)}));
              }, 200);
            }
            var WS_HANDLERS = ${JSON.stringify(allWsHandlers)};
            for (var i = 0; i < WS_HANDLERS.length; i++) {
              var h = WS_HANDLERS[i];
              if (parsed.type === h.type) {
                (new Function('parsed', '__tauriEmitEvent', h.handler))(parsed, __tauriEmitEvent);
              }
            }
          } catch (e) {}
          ` : ""}
          return;
        }
        if (cmd === "ws_disconnect") return;

        // ---- LiveKit proxy ----
        if (cmd === "start_livekit_proxy") return { port: 7880 };
        if (cmd === "stop_livekit_proxy") return;

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
      { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
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
    wsHandlers: voiceWsHandlers(),
    readyOverrides: {
      channels: MOCK_CHANNELS_WITH_CATEGORIES,
      members: MOCK_MEMBERS_MULTI_ROLE,
      voice_states: MOCK_VOICE_STATE,
    },
  }));
}

export async function mockTauriFullSessionWithVoiceFailure(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
    ],
    simulateWsFlow: true,
    wsHandlers: [voiceJoinFailureHandler()],
    readyOverrides: {
      channels: MOCK_CHANNELS_WITH_CATEGORIES,
      members: MOCK_MEMBERS_MULTI_ROLE,
      voice_states: MOCK_VOICE_STATE,
    },
  }));
}

export async function mockTauriFullSessionWithEcho(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
    ],
    simulateWsFlow: true,
    echoChatSend: true,
  }));
}

export async function mockTauriFullSessionWithMessagesAndEcho(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES_RICH },
      { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      { pattern: "/api/v1/invites", status: 200, body: MOCK_INVITES },
    ],
    simulateWsFlow: true,
    echoChatSend: true,
    readyOverrides: {
      channels: MOCK_CHANNELS_WITH_CATEGORIES,
      members: MOCK_MEMBERS_MULTI_ROLE,
    },
  }));
}

export async function mockTauriFullSessionWithFailingMessages(page: Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 500, body: { error: "INTERNAL_ERROR", message: "Failed to load messages" } },
    ],
    simulateWsFlow: true,
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
  const appLayout = page.locator("[data-testid='app-layout']");
  await expect(appLayout).toBeVisible({ timeout: 15_000 });
}

/**
 * Open the settings overlay via the user bar gear button.
 */
export async function openSettings(page: Page): Promise<void> {
  const settingsBtn = page.locator("button[aria-label='Settings']");
  await settingsBtn.click();

  const overlay = page.locator("[data-testid='settings-overlay']");
  await expect(overlay).toHaveClass(/open/, { timeout: 5_000 });
}

/**
 * Switch to a settings tab by name.
 */
export async function switchSettingsTab(page: Page, tabName: string): Promise<void> {
  const tab = page.locator(".settings-sidebar button.settings-nav-item", { hasText: tabName });
  await tab.click();
  await expect(tab).toHaveClass(/active/);
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

// ---------------------------------------------------------------------------
// Anti-flakiness utilities
// ---------------------------------------------------------------------------

/**
 * Wait for the WS mock to finish its auth + ready handshake.
 * The mock uses setTimeout(100ms) for ws-state open, then
 * setTimeout(100/200ms) for auth_ok/ready — so the handshake
 * completes within ~300ms. This helper polls for a reliable
 * DOM signal instead of relying on hardcoded delays.
 */
export async function waitForWsReady(page: Page): Promise<void> {
  // The channel sidebar populates after the ready payload is processed.
  // Wait for the first channel item as proof the WS flow completed.
  await expect(page.locator(".channel-item").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Navigate to main page and wait for WS ready handshake to complete.
 * Combines login + WS readiness in one call to reduce boilerplate
 * and ensure tests start from a stable state.
 */
export async function navigateToMainPageReady(page: Page): Promise<void> {
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

/**
 * Emit a WS message and wait for a DOM change to confirm it was processed.
 * Prevents flakiness from tests asserting before the message handler runs.
 *
 * @param page - Playwright page
 * @param message - WS message payload to emit
 * @param confirmLocator - Locator that should become visible/attached after processing
 * @param timeout - Max wait time (default 5000ms)
 */
export async function emitWsMessageAndWait(
  page: Page,
  message: unknown,
  confirmLocator: ReturnType<Page["locator"]>,
  timeout = 5_000,
): Promise<void> {
  await emitWsMessage(page, message);
  await expect(confirmLocator).toBeVisible({ timeout });
}
