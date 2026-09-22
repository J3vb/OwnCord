/**
 * Mocked E2E: composer gating (audit batch N13, gap #16) — slow mode,
 * the server's per-channel `can_send` permission verdict, and DM blocks.
 *
 * All three are affordances `ChannelController`'s `computeComposerReason` /
 * `startSlowMode` produce from server state, so every assertion here is on the
 * rendered composer (disabled attribute, placeholder reason, `composer-disabled`
 * class) and on the outgoing `ws_send` / HTTP frames the app actually issued —
 * never on mock internals.
 *
 * The frames come from the Tauri mock's own IPC log (`window.__invokeLog`),
 * which records every `ws_send` envelope the client handed to the transport, and
 * from a second init script that records `plugin:http|fetch` calls (the block
 * PUT/DELETE). A send is proven by its frame, and "gated" is proven by the
 * absence of a frame plus the disabled control that would have produced it.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  emitWsMessage,
  emitWsEvent,
  navigateToMainPage,
  waitForWsReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** #general carries a 1-second slow mode so the cooldown can expire inside a
 *  test; the server's ceiling is 21600s but the client only reads the number. */
const SLOW_CHANNEL = {
  id: 1,
  name: "general",
  type: "text",
  position: 0,
  category: null,
  slow_mode: 1,
  can_send: true,
};

/** A slow mode long enough that the cooldown cannot expire during a test, so a
 *  "still enabled / still disabled" assertion cannot pass merely because the
 *  window elapsed. */
const LONG_SLOW_CHANNEL = { ...SLOW_CHANNEL, slow_mode: 300 };

/** #general with the server's `can_send: false` — the composer must pre-disable. */
const NO_SEND_CHANNEL = {
  id: 1,
  name: "general",
  type: "text",
  position: 0,
  category: null,
  slow_mode: 0,
  can_send: false,
};

/** An announcement channel the viewer cannot post in (MANAGE_MESSAGES denied). */
const NO_SEND_ANNOUNCEMENT = {
  id: 1,
  name: "news",
  type: "announcement",
  position: 0,
  category: null,
  slow_mode: 0,
  can_send: false,
};

const DM_OTHER = {
  channel_id: 100,
  recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
  last_message_id: null,
  last_message: "",
  last_message_at: "",
  unread_count: 0,
};

/** A group DM that contains the blocked user. Block gating is a 1:1-only rule,
 *  so a group must stay postable. */
const DM_GROUP = {
  channel_id: 101,
  recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
  recipients: [
    { id: 2, username: "otheruser", avatar: "", status: "online" },
    { id: 3, username: "thirduser", avatar: "", status: "idle" },
  ],
  is_group: true,
  name: "",
  last_message_id: null,
  last_message: "",
  last_message_at: "",
  unread_count: 0,
};

// ---------------------------------------------------------------------------
// Outgoing-frame capture
// ---------------------------------------------------------------------------

interface SentFrame {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

/** The client's own outgoing WS frames, as recorded by the Tauri mock's IPC log. */
async function sentFrames(page: Page): Promise<SentFrame[]> {
  return page.evaluate(() => {
    const log = (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { message?: string } }> }
    ).__invokeLog;
    const frames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    for (const entry of log) {
      if (entry.cmd !== "ws_send") continue;
      try {
        frames.push(JSON.parse(entry.args?.message ?? "{}"));
      } catch {
        // A non-JSON frame is not a client WS message; skip it.
      }
    }
    return frames;
  });
}

async function chatSendFrames(page: Page): Promise<SentFrame[]> {
  return (await sentFrames(page)).filter((f) => f.type === "chat_send");
}

interface CapturedCall {
  readonly cmd: string;
  readonly method?: string;
  readonly url?: string;
}

/** Installed as a second init script, after the Tauri mock sets up `invoke`. */
function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__;
  const orig = internals.invoke;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__capturedCalls = [];
  internals.invoke = async (cmd: string, args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = args as any;
    if (cmd === "plugin:http|fetch") {
      const cfg = a?.clientConfig ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({ cmd, method: cfg.method, url: cfg.url });
    }
    return orig(cmd, args);
  };
}

async function fetchCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((window as any).__capturedCalls ?? []) as CapturedCall[];
  });
}

// ---------------------------------------------------------------------------
// Simulated server send replies
// ---------------------------------------------------------------------------

/**
 * A `chat_send` reply that mirrors the server's wire shape. `chat_send_ok`
 * echoes the request envelope id, which is what ties the ack back to the send
 * in `ChannelController` (`ws.on("chat_send_ok", (_payload, correlationId)`) —
 * without it the slow-mode cooldown never starts.
 */
function chatSendOkHandler(opts: { messageId?: number; echoMessage?: boolean } = {}): {
  type: string;
  handler: string;
} {
  const messageId = opts.messageId ?? 9000;
  const echo =
    opts.echoMessage === false
      ? ""
      : `
      setTimeout(function() {
        __tauriEmitEvent("ws-message", JSON.stringify({
          type: "chat_message",
          payload: {
            id: ${messageId},
            channel_id: p.channel_id,
            user: { id: 1, username: "testuser", avatar: "" },
            content: p.content,
            timestamp: new Date().toISOString(),
            edited_at: null, attachments: [], reactions: [],
            reply_to: p.reply_to || null, pinned: false, deleted: false
          }
        }));
      }, 60);
      `;
  return {
    type: "chat_send",
    handler: `
      var p = parsed.payload;
      var reqId = parsed.id;
      setTimeout(function() {
        __tauriEmitEvent("ws-message", JSON.stringify({
          type: "chat_send_ok",
          id: reqId,
          payload: { message_id: ${messageId}, timestamp: new Date().toISOString() }
        }));
      }, 30);
      ${echo}
    `,
  };
}

/** A `chat_send` refusal carrying the request id, exactly like the server's
 *  `buildErrorMsgWithID` — the correlation that lets the client gate the send. */
function chatSendErrorHandler(code: string): { type: string; handler: string } {
  return {
    type: "chat_send",
    handler: `
      var reqId = parsed.id;
      setTimeout(function() {
        __tauriEmitEvent("ws-message", JSON.stringify({
          type: "error",
          id: reqId,
          payload: { code: ${JSON.stringify(code)}, message: "refused" }
        }));
      }, 30);
    `,
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface MockOpts {
  channels?: unknown[];
  dmChannels?: unknown[];
  wsHandlers?: Array<{ type: string; handler: string }>;
}

async function boot(page: Page, opts: MockOpts = {}): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        // Ready-time block refresh; the 1:1 block flow writes and clears it.
        { pattern: "/api/v1/blocks/2", method: "PUT", status: 200, body: {} },
        { pattern: "/api/v1/blocks/2", method: "DELETE", status: 200, body: {} },
        { pattern: "/api/v1/blocks", status: 200, body: { blocked_user_ids: [] } },
        // The member list's banned-list walk on every roster change.
        { pattern: "/admin/api/users", status: 200, body: [] },
      ],
      simulateWsFlow: true,
      wsHandlers: opts.wsHandlers,
      readyOverrides: {
        channels: opts.channels ?? [SLOW_CHANNEL],
        dm_channels: opts.dmChannels ?? [],
      },
    }),
  );
  await page.addInitScript(captureScript);
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

/** The signed-in user's role, demoted through the live member_update path a
 *  real demotion uses — Moderator/Member hold no MANAGE_MESSAGES, so slow mode
 *  applies; the default fixture user is admin and would bypass it. */
async function demoteSelf(page: Page, role: string): Promise<void> {
  await page.evaluate((nextRole) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__tauriEmitEvent(
      "ws-message",
      JSON.stringify({ type: "member_update", payload: { user_id: 1, role: nextRole } }),
    );
  }, role);
}

const textarea = (page: Page) => page.locator("[data-testid='msg-textarea']");
const composer = (page: Page) => page.locator("[data-testid='message-input']");

async function sendMessage(page: Page, text: string): Promise<void> {
  await textarea(page).fill(text);
  await textarea(page).press("Enter");
}

/** Open a member row's context menu, positioned at a safe viewport point (the
 *  sidebar rows sit low and a real right-click would put the menu off-screen). */
async function openMemberMenu(page: Page, userId: number) {
  const row = page.locator(`[data-testid='member-${userId}']`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.evaluate((el) =>
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 640,
        clientY: 80,
        button: 2,
      }),
    ),
  );
  const menu = page.locator(".context-menu").first();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
}

// ---------------------------------------------------------------------------
// Permission gating — the server's can_send verdict
// ---------------------------------------------------------------------------

test.describe("Composer gating — permission", () => {
  test("can_send:false disables the composer with the permission reason, and a targeted can_send:true re-enables it", async ({
    page,
  }) => {
    await boot(page, { channels: [NO_SEND_CHANNEL] });

    await expect(textarea(page)).toBeDisabled();
    await expect(textarea(page)).toHaveAttribute(
      "placeholder",
      "You don't have permission to send messages here",
    );
    await expect(page.locator("[data-testid='send-btn']")).toBeDisabled();
    await expect(composer(page)).toHaveClass(/composer-disabled/);
    expect(await chatSendFrames(page)).toHaveLength(0);

    // A role/override edit fans out a per-recipient channel_create carrying
    // this viewer's fresh can_send (RefreshChannelVisibility). The composer
    // must un-gate without a reconnect.
    await emitWsMessage(page, {
      type: "channel_create",
      payload: {
        id: 1,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        can_send: true,
      },
    });

    await expect(textarea(page)).toBeEnabled();
    await expect(textarea(page)).toHaveAttribute("placeholder", "Message #general");
    await expect(page.locator("[data-testid='send-btn']")).toBeEnabled();
    await expect(composer(page)).not.toHaveClass(/composer-disabled/);

    // The re-enabled control is truthful: the send goes out.
    await sendMessage(page, "now allowed");
    await expect.poll(async () => (await chatSendFrames(page)).length).toBe(1);
  });

  test("an announcement channel the viewer cannot post in names the MANAGE_MESSAGES rule", async ({
    page,
  }) => {
    await boot(page, { channels: [NO_SEND_ANNOUNCEMENT] });

    await expect(textarea(page)).toBeDisabled();
    await expect(textarea(page)).toHaveAttribute(
      "placeholder",
      "Only moderators can post in announcement channels",
    );
  });
});

// ---------------------------------------------------------------------------
// Slow mode
// ---------------------------------------------------------------------------

test.describe("Composer gating — slow mode", () => {
  test("an accepted send starts a live countdown that releases when the cooldown expires", async ({
    page,
  }) => {
    await boot(page, {
      channels: [SLOW_CHANNEL],
      wsHandlers: [chatSendOkHandler()],
    });
    // The fixture user is admin (bypasses slow mode); demote to a plain member
    // so the cooldown applies, exactly as it would to a real member.
    await demoteSelf(page, "member");

    await expect(textarea(page)).toBeEnabled();
    await sendMessage(page, "first message");

    // The ack gates the composer with the remaining whole seconds.
    await expect(textarea(page)).toBeDisabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute("placeholder", /^Slow mode — \d+s$/);
    await expect(page.locator("[data-testid='send-btn']")).toBeDisabled();
    await expect(composer(page)).toHaveClass(/composer-disabled/);

    // Only the one send went out while gated: the disabled control cannot
    // produce a second chat_send frame.
    await expect.poll(async () => (await chatSendFrames(page)).length).toBe(1);

    // The ticker releases the composer once the 1s window elapses.
    await expect(textarea(page)).toBeEnabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute("placeholder", "Message #general");
    await expect(composer(page)).not.toHaveClass(/composer-disabled/);
    expect(await chatSendFrames(page)).toHaveLength(1);
  });

  test("a SLOW_MODE refusal from the server restarts the cooldown window", async ({ page }) => {
    await boot(page, {
      channels: [SLOW_CHANNEL],
      wsHandlers: [chatSendErrorHandler("SLOW_MODE")],
    });
    await demoteSelf(page, "member");

    await sendMessage(page, "too fast");

    // The refusal carries the send's correlation id, so ChannelController
    // gates the composer from the server's limiter, not from a local guess.
    await expect(textarea(page)).toBeDisabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute("placeholder", /^Slow mode — \d+s$/);
  });

  test("a moderator holding MANAGE_MESSAGES is not gated by slow mode", async ({ page }) => {
    await boot(page, {
      channels: [LONG_SLOW_CHANNEL],
      wsHandlers: [chatSendOkHandler({ messageId: 9001, echoMessage: true })],
    });
    // The admin fixture role holds ADMINISTRATOR, which implies MANAGE_MESSAGES.

    await sendMessage(page, "mod message");

    // The server echo is the positive control that the ack was processed: a
    // 300s window would already have disabled the composer if the bypass were
    // missing (the ack lands before the echo in the handler).
    await expect(page.locator(".msg-text", { hasText: "mod message" }).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(textarea(page)).toBeEnabled();
    await expect(textarea(page)).toHaveAttribute("placeholder", "Message #general");
    await expect(composer(page)).not.toHaveClass(/composer-disabled/);
  });
});

// ---------------------------------------------------------------------------
// DM block gating
// ---------------------------------------------------------------------------

test.describe("Composer gating — DM blocks", () => {
  test("blocking a 1:1 recipient gates the DM composer with the explicit reason and PUTs the block", async ({
    page,
  }) => {
    await boot(page, { channels: [SLOW_CHANNEL], dmChannels: [DM_OTHER] });

    // Block through the real member context menu (two-click confirm).
    const menu = await openMemberMenu(page, 2);
    const blockItem = menu.locator("[data-testid='block-toggle']");
    await expect(blockItem).toHaveText("Block");
    await blockItem.click();
    await expect(blockItem).toHaveText("Are you sure?");
    await blockItem.click();
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Blocked otheruser" }),
    ).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () =>
        (await fetchCalls(page)).some(
          (c) => c.method === "PUT" && (c.url ?? "").includes("/api/v1/blocks/2"),
        ),
      )
      .toBe(true);

    // Open the DM: the composer is gated by the block, and the reason says who
    // the blocker is.
    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("otheruser");
    await expect(textarea(page)).toBeDisabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute(
      "placeholder",
      "You've blocked this user. Unblock to send messages.",
    );
    await expect(composer(page)).toHaveClass(/composer-disabled/);
    expect(await chatSendFrames(page)).toHaveLength(0);
  });

  test("a refused DM send (FORBIDDEN) gates the composer with the neutral reason", async ({
    page,
  }) => {
    await boot(page, {
      channels: [SLOW_CHANNEL],
      dmChannels: [DM_OTHER],
      wsHandlers: [chatSendErrorHandler("FORBIDDEN")],
    });

    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("otheruser");
    await expect(textarea(page)).toBeEnabled();

    await sendMessage(page, "hello?");

    // The server's generic FORBIDDEN is how a block in the other direction is
    // discovered; the neutral copy never reveals the block explicitly.
    await expect(textarea(page)).toBeDisabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute(
      "placeholder",
      "You can't message this user right now.",
    );
    // Exactly the one refused send went out; the gate then stopped the next.
    await expect.poll(async () => (await chatSendFrames(page)).length).toBe(1);
  });

  test("a group DM stays postable even when one participant is blocked", async ({ page }) => {
    await boot(page, {
      channels: [SLOW_CHANNEL],
      dmChannels: [DM_OTHER, DM_GROUP],
      wsHandlers: [chatSendOkHandler()],
    });

    // Block the participant that the group also contains.
    const menu = await openMemberMenu(page, 2);
    const blockItem = menu.locator("[data-testid='block-toggle']");
    await blockItem.click();
    await blockItem.click();
    await expect
      .poll(async () =>
        (await fetchCalls(page)).some(
          (c) => c.method === "PUT" && (c.url ?? "").includes("/api/v1/blocks/2"),
        ),
      )
      .toBe(true);

    // Control: the 1:1 DM with that user IS gated.
    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("otheruser");
    await expect(textarea(page)).toBeDisabled({ timeout: 5_000 });

    // Back to the channel list, then into the group: a block is a 1:1 rule, so
    // the shared room must remain postable.
    await page.locator("[data-testid='dm-back-header']").click();
    await page.locator("[data-testid='dm-entry']").nth(1).click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText(
      "otheruser, thirduser",
    );
    await expect(textarea(page)).toBeEnabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute("placeholder", "Message #otheruser, thirduser");
    await expect(composer(page)).not.toHaveClass(/composer-disabled/);

    await sendMessage(page, "group message");
    await expect.poll(async () => (await chatSendFrames(page)).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Connection gating
// ---------------------------------------------------------------------------

test.describe("Composer gating — connection", () => {
  test("dropping the socket disables the composer with a reconnecting reason and re-enables on reconnect", async ({
    page,
  }) => {
    await boot(page);

    await emitWsEvent(page, "ws-state", "closed");

    await expect(textarea(page)).toBeDisabled({ timeout: 5_000 });
    await expect(textarea(page)).toHaveAttribute("placeholder", "Reconnecting…");
    await expect(composer(page)).toHaveClass(/composer-disabled/);

    // The mock's reconnect attempt re-opens the socket and re-runs the
    // handshake; the composer must come back without a page reload.
    await expect(textarea(page)).toBeEnabled({ timeout: 15_000 });
    await expect(textarea(page)).toHaveAttribute("placeholder", "Message #general");
  });
});
