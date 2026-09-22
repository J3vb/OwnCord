/**
 * Mocked E2E: channel management — Create / Edit / Delete Channel modals and
 * the Purge Messages confirmation (audit gap #1), plus their channel
 * context-menu entry points.
 *
 * Entry points exercised through the real UI:
 *   - Create:  the "+" on a category header (CreateChannelModal)
 *   - Edit:    right-click a channel → "Edit Channel" (EditChannelModal)
 *   - Delete:  right-click a channel → "Delete Channel" (DeleteChannelModal)
 *   - Purge:   right-click a channel → "Purge Messages…" (purge-prompt)
 *
 * Outgoing traffic is captured at the IPC boundary by a second init script
 * that wraps window.__TAURI_INTERNALS__.invoke (installed after the base Tauri
 * mock), recording every plugin:http|fetch call with its method, URL and JSON
 * body. Tests assert those exact requests, not mock internals:
 *   - create: POST   /admin/api/channels
 *   - edit:   PATCH  /admin/api/channels/{id}
 *   - delete: DELETE /admin/api/channels/{id}
 *   - purge:  POST   /api/v1/channels/{id}/messages/purge
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  MOCK_MEMBERS_MULTI_ROLE,
  navigateToMainPageReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// IPC capture
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly cmd: string;
  readonly method?: string;
  readonly url?: string;
  readonly body?: string | null;
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
      let body: string | null = null;
      if (Array.isArray(cfg.data)) {
        try {
          body = new TextDecoder().decode(new Uint8Array(cfg.data));
        } catch {
          body = null;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({ cmd, method: cfg.method, url: cfg.url, body });
    }
    return orig(cmd, args);
  };
}

async function getCapturedCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((window as any).__capturedCalls ?? []) as CapturedCall[];
  });
}

/** Poll until a captured call matches, and return it — avoids racing the request. */
async function waitForCapturedCall(
  page: Page,
  predicate: (call: CapturedCall) => boolean,
  timeout = 5_000,
): Promise<CapturedCall> {
  let found: CapturedCall | undefined;
  await expect(async () => {
    const calls = await getCapturedCalls(page);
    found = calls.find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

function adminCalls(calls: readonly CapturedCall[]): CapturedCall[] {
  return calls.filter((c) => (c.url ?? "").includes("/admin/api/channels"));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A text channel that carries a topic, a slow-mode preset and the NSFW flag,
 *  so the Edit modal's pre-fill is observable from the store. */
const TEXT_CHANNEL = {
  id: 1,
  name: "general",
  type: "text",
  position: 0,
  category: "Text Channels",
  topic: "Say hi",
  slow_mode: 300,
  nsfw: true,
};

/** A voice channel with stored capacity limits, for the voice-only section. */
const VOICE_CHANNEL = {
  id: 10,
  name: "Voice Chat",
  type: "voice",
  position: 1,
  category: "Voice Channels",
  topic: "Hang out",
  slow_mode: 0,
  nsfw: false,
  voice_max_users: 5,
  voice_max_video: 2,
};

const CHANNELS = [TEXT_CHANNEL, VOICE_CHANNEL];

/** An uncategorized voice channel groups under the synthetic "Voice" header,
 *  whose "+" pre-selects the voice type (defaultTypeForCategory). */
const UNCATEGORIZED = [
  { id: 1, name: "general", type: "text", position: 0, category: null },
  { id: 5, name: "Lounge", type: "voice", position: 1, category: null },
];

interface MockOpts {
  channels?: unknown[];
  /** Status/body for /admin/api/channels* (create, update, delete). */
  admin?: { status: number; body: unknown };
  /** Status/body for POST /channels/{id}/messages/purge. */
  purge?: { status: number; body: unknown };
}

async function openSession(page: Page, opts: MockOpts = {}): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        {
          pattern: "/messages/purge",
          status: opts.purge?.status ?? 200,
          body: opts.purge?.body ?? { channel_id: 1, ids: [], count: 0 },
        },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        {
          pattern: "/admin/api/channels",
          status: opts.admin?.status ?? 200,
          body: opts.admin?.body ?? {},
        },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        channels: opts.channels ?? CHANNELS,
        members: MOCK_MEMBERS_MULTI_ROLE,
      },
    }),
  );
  await page.addInitScript(captureScript);
  await page.goto("/");
  await navigateToMainPageReady(page);
}

/** Open a channel's right-click context menu. */
async function openChannelMenu(page: Page, channelId: number): Promise<void> {
  await page.locator(`[data-testid='channel-${channelId}']`).click({ button: "right" });
  await expect(page.locator("[data-testid='channel-context-menu']")).toBeVisible({
    timeout: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Create Channel
// ---------------------------------------------------------------------------

test.describe("Create Channel modal", () => {
  test("the category + opens the modal pre-filled with that category and type", async ({
    page,
  }) => {
    await openSession(page);
    await page.locator("[data-testid='create-channel-text-channels']").click();

    const modal = page.locator("[data-testid='create-channel-modal']");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator("#create-channel-title")).toHaveText("Create Channel");
    await expect(page.locator("[data-testid='channel-category-input']")).toHaveValue(
      "Text Channels",
    );
    await expect(page.locator("[data-testid='channel-type-select']")).toHaveValue("text");
  });

  test("creating a channel POSTs name/type/category and closes the modal", async ({ page }) => {
    await openSession(page);
    await page.locator("[data-testid='create-channel-text-channels']").click();
    await expect(page.locator("[data-testid='create-channel-modal']")).toBeVisible();

    await page.locator("[data-testid='channel-name-input']").fill("new-lounge");
    await page.locator("[data-testid='channel-type-select']").selectOption("voice");
    await page.locator("[data-testid='channel-create-submit']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/admin/api/channels"),
    );
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body ?? "{}")).toEqual({
      name: "new-lounge",
      type: "voice",
      category: "Text Channels",
    });
    await expect(page.locator("[data-testid='create-channel-modal']")).not.toBeVisible();
  });

  test("an empty name shows the inline error and sends nothing", async ({ page }) => {
    await openSession(page);
    await page.locator("[data-testid='create-channel-text-channels']").click();
    await page.locator("[data-testid='channel-create-submit']").click();

    const error = page.locator("[data-testid='channel-create-error']");
    await expect(error).toBeVisible();
    await expect(error).toHaveText("Channel name is required");
    await expect(page.locator("[data-testid='channel-name-input']")).toHaveClass(/error/);
    expect(adminCalls(await getCapturedCalls(page))).toEqual([]);
  });

  test("a rejected create shows the server error and re-arms the submit button", async ({
    page,
  }) => {
    await openSession(page, {
      admin: { status: 403, body: { error: "FORBIDDEN", message: "Missing MANAGE_CHANNELS" } },
    });
    await page.locator("[data-testid='create-channel-text-channels']").click();
    await page.locator("[data-testid='channel-name-input']").fill("nope");
    await page.locator("[data-testid='channel-create-submit']").click();

    const error = page.locator("[data-testid='channel-create-error']");
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toHaveText("Missing MANAGE_CHANNELS");
    await expect(page.locator("[data-testid='channel-create-submit']")).toBeEnabled();
    await expect(page.locator("[data-testid='channel-create-submit']")).toHaveText(
      "Create Channel",
    );
  });

  test("Cancel closes the modal without creating", async ({ page }) => {
    await openSession(page);
    await page.locator("[data-testid='create-channel-text-channels']").click();
    await page.locator("[data-testid='create-channel-modal'] .btn-modal-cancel").click();

    await expect(page.locator("[data-testid='create-channel-modal']")).not.toBeVisible();
    expect(adminCalls(await getCapturedCalls(page))).toEqual([]);
  });

  test("the Voice fallback category defaults the type to voice", async ({ page }) => {
    await openSession(page, { channels: UNCATEGORIZED });
    await page.locator("[data-testid='create-channel-voice']").click();

    await expect(page.locator("[data-testid='create-channel-modal']")).toBeVisible();
    await expect(page.locator("[data-testid='channel-category-input']")).toHaveValue("Voice");
    await expect(page.locator("[data-testid='channel-type-select']")).toHaveValue("voice");
  });
});

// ---------------------------------------------------------------------------
// Edit Channel
// ---------------------------------------------------------------------------

test.describe("Edit Channel modal", () => {
  test("Edit from the context menu opens pre-filled from channel state", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-edit-channel']").click();

    const modal = page.locator("[data-testid='edit-channel-modal']");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-testid='edit-channel-name-input']")).toHaveValue("general");
    await expect(page.locator("[data-testid='edit-channel-topic-input']")).toHaveValue("Say hi");
    await expect(page.locator("[data-testid='edit-channel-category-input']")).toHaveValue(
      "Text Channels",
    );
    await expect(page.locator("[data-testid='edit-channel-slowmode-select']")).toHaveValue("300");
    await expect(page.locator("[data-testid='edit-channel-nsfw-checkbox']")).toBeChecked();
    // A text channel gets no voice-limit section.
    await expect(page.locator("[data-testid='edit-channel-voice-section']")).toHaveCount(0);
  });

  test("saving a text channel PATCHes the fields and omits voice limits", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-edit-channel']").click();

    await page.locator("[data-testid='edit-channel-name-input']").fill("general-renamed");
    await page.locator("[data-testid='edit-channel-topic-input']").fill("New topic");
    await page.locator("[data-testid='edit-channel-slowmode-select']").selectOption("60");
    await page.locator("[data-testid='edit-channel-nsfw-checkbox']").uncheck();
    await page.locator("[data-testid='edit-channel-submit']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/admin/api/channels/1"),
    );
    expect(call.method).toBe("PATCH");
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      name: "general-renamed",
      topic: "New topic",
      category: "Text Channels",
      slow_mode: 60,
      nsfw: false,
    });
    expect(body).not.toHaveProperty("voice_max_users");
    expect(body).not.toHaveProperty("voice_max_video");
    await expect(page.locator("[data-testid='edit-channel-modal']")).not.toBeVisible();
  });

  test("an empty name on edit shows the inline error and sends nothing", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-edit-channel']").click();
    await page.locator("[data-testid='edit-channel-name-input']").fill("   ");
    await page.locator("[data-testid='edit-channel-submit']").click();

    const error = page.locator("[data-testid='edit-channel-error']");
    await expect(error).toBeVisible();
    await expect(error).toHaveText("Channel name is required");
    expect(adminCalls(await getCapturedCalls(page))).toEqual([]);
  });

  test("a voice channel shows the voice-limit section and PATCHes the limits", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 10);
    await page.locator("[data-testid='ctx-edit-channel']").click();

    await expect(page.locator("[data-testid='edit-channel-voice-section']")).toBeVisible();
    await expect(page.locator("[data-testid='edit-channel-max-users-input']")).toHaveValue("5");
    await expect(page.locator("[data-testid='edit-channel-max-video-input']")).toHaveValue("2");

    await page.locator("[data-testid='edit-channel-max-users-input']").fill("9");
    await page.locator("[data-testid='edit-channel-submit']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/admin/api/channels/10"),
    );
    expect(call.method).toBe("PATCH");
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body["voice_max_users"]).toBe(9);
    expect(body["voice_max_video"]).toBe(2);
  });

  test("voice limits are clamped to the server maximum", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 10);
    await page.locator("[data-testid='ctx-edit-channel']").click();

    await page.locator("[data-testid='edit-channel-max-users-input']").fill("999");
    await page.locator("[data-testid='edit-channel-submit']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/admin/api/channels/10"),
    );
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body["voice_max_users"]).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Delete Channel
// ---------------------------------------------------------------------------

test.describe("Delete Channel modal", () => {
  test("Delete from the context menu names the channel and DELETEs on confirm", async ({
    page,
  }) => {
    await openSession(page);
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-delete-channel']").click();

    const modal = page.locator("[data-testid='delete-channel-modal']");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal).toContainText("#general");
    await expect(modal).toContainText("cannot be undone");

    await page.locator("[data-testid='delete-channel-confirm']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/admin/api/channels/1"),
    );
    expect(call.method).toBe("DELETE");
    await expect(page.locator("[data-testid='delete-channel-modal']")).not.toBeVisible();
  });

  test("Escape on the destructive dialog cancels without deleting", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-delete-channel']").click();
    await expect(page.locator("[data-testid='delete-channel-modal']")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.locator("[data-testid='delete-channel-modal']")).not.toBeVisible();
    expect(adminCalls(await getCapturedCalls(page))).toEqual([]);
  });

  test("a failed delete shows the error and re-arms the confirm button", async ({ page }) => {
    await openSession(page, {
      admin: { status: 403, body: { error: "FORBIDDEN", message: "Missing MANAGE_CHANNELS" } },
    });
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-delete-channel']").click();
    await page.locator("[data-testid='delete-channel-confirm']").click();

    const error = page.locator("[data-testid='delete-channel-error']");
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toHaveText("Missing MANAGE_CHANNELS");
    await expect(page.locator("[data-testid='delete-channel-confirm']")).toBeEnabled();
    await expect(page.locator("[data-testid='delete-channel-confirm']")).toHaveText(
      "Delete Channel",
    );
  });
});

// ---------------------------------------------------------------------------
// Purge Messages
// ---------------------------------------------------------------------------

test.describe("Purge Messages", () => {
  test("Purge reveals the count prompt and POSTs the clamped count", async ({ page }) => {
    await openSession(page, {
      purge: { status: 200, body: { channel_id: 1, ids: [3, 2, 1], count: 3 } },
    });
    await openChannelMenu(page, 1);

    await page.locator("[data-testid='ctx-purge-messages']").click();
    const form = page.locator("[data-testid='purge-form']");
    await expect(form).toBeVisible();
    await expect(form).toContainText("Deletes the newest 1–100 messages.");
    await expect(page.locator("[data-testid='purge-count-input']")).toHaveValue("50");

    await page.locator("[data-testid='purge-count-input']").fill("0");
    await page.locator("[data-testid='purge-confirm']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/messages/purge"),
    );
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ limit: 1 });

    await expect(page.locator("[data-testid='toast']")).toHaveText(
      "Purged 3 messages from #general",
    );
    await expect(page.locator("[data-testid='channel-context-menu']")).not.toBeVisible();
  });

  test("purge count clamps above the maximum", async ({ page }) => {
    await openSession(page, {
      purge: { status: 200, body: { channel_id: 1, ids: [], count: 100 } },
    });
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-purge-messages']").click();
    await page.locator("[data-testid='purge-count-input']").fill("999");
    await page.locator("[data-testid='purge-confirm']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/messages/purge"),
    );
    expect(JSON.parse(call.body ?? "{}")).toEqual({ limit: 100 });
  });

  test("Enter in the count input submits the purge", async ({ page }) => {
    await openSession(page, {
      purge: { status: 200, body: { channel_id: 1, ids: [1], count: 1 } },
    });
    await openChannelMenu(page, 1);
    await page.locator("[data-testid='ctx-purge-messages']").click();
    const input = page.locator("[data-testid='purge-count-input']");
    await input.fill("5");
    await input.press("Enter");

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/messages/purge"),
    );
    expect(JSON.parse(call.body ?? "{}")).toEqual({ limit: 5 });
  });

  test("Purge is not offered on a voice channel", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 10);

    // Control: the menu did open for the voice channel with its management rows.
    await expect(page.locator("[data-testid='ctx-edit-channel']")).toBeVisible();
    await expect(page.locator("[data-testid='ctx-purge-messages']")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Context-menu entry points
// ---------------------------------------------------------------------------

test.describe("Channel context menu", () => {
  test("a text channel offers Edit, Delete and Purge", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 1);

    await expect(page.locator("[data-testid='ctx-edit-channel']")).toHaveText("Edit Channel");
    await expect(page.locator("[data-testid='ctx-delete-channel']")).toHaveText("Delete Channel");
    await expect(page.locator("[data-testid='ctx-purge-messages']")).toHaveText("Purge Messages…");
  });
});
