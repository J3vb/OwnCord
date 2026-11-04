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
 * Outgoing traffic is captured at the IPC boundary by a `wrappers` entry
 * that wraps window.__TAURI_INTERNALS__.invoke (run inside the base Tauri
 * mock's init script), recording every plugin:http|fetch call with its method, URL and JSON
 * body. Tests assert those exact requests, not mock internals:
 *   - create: POST   /api/v1/moderation/channels
 *   - edit:   PATCH  /api/v1/moderation/channels/{id}
 *   - delete: DELETE /api/v1/moderation/channels/{id}
 *   - purge:  POST   /api/v1/channels/{id}/messages/purge
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  MOCK_MEMBERS_MULTI_ROLE,
  navigateToMainPageReady,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
} from "./helpers";
import {
  captureCalls,
  getCapturedCalls,
  waitForCapturedCall,
  type CapturedCall,
} from "./support/ipcCapture";

function adminCalls(calls: readonly CapturedCall[]): CapturedCall[] {
  return calls.filter((c) => (c.url ?? "").includes("/api/v1/moderation/channels"));
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
  category_id: 1,
  category_position: 0,
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
  category_id: 2,
  category_position: 1,
  topic: "Hang out",
  slow_mode: 0,
  nsfw: false,
  voice_max_users: 5,
  voice_max_video: 2,
};

const CHANNELS = [TEXT_CHANNEL, VOICE_CHANNEL];

/** An uncategorized voice channel groups under the synthetic "Voice" header,
 *  whose "+" pre-selects the voice type and No category. */
const UNCATEGORIZED = [
  { id: 1, name: "general", type: "text", position: 0, category: null },
  { id: 5, name: "Lounge", type: "voice", position: 1, category: null },
];

interface MockOpts {
  channels?: unknown[];
  /** Status/body for /api/v1/moderation/channels* (create, update, delete). */
  admin?: { status: number; body: unknown };
  /** Status/body for POST /channels/{id}/messages/purge. */
  purge?: { status: number; body: unknown };
  /** The manager's category list (ready.categories); omitted = the key is absent. */
  categories?: unknown[];
}

async function openSession(page: Page, opts: MockOpts = {}): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      wrappers: [captureCalls],
      httpRoutes: [
        ROUTE_HEALTH,
        ROUTE_LOGIN,
        {
          pattern: "/messages/purge",
          status: opts.purge?.status ?? 200,
          body: opts.purge?.body ?? { channel_id: 1, ids: [], count: 0 },
        },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        {
          pattern: "/api/v1/moderation/channels",
          status: opts.admin?.status ?? 200,
          body: opts.admin?.body ?? {},
        },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        channels: opts.channels ?? CHANNELS,
        ...(opts.categories === undefined ? {} : { categories: opts.categories }),
        members: MOCK_MEMBERS_MULTI_ROLE,
      },
    }),
  );
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
    await expect(page.locator("[data-testid='channel-category-select']")).toHaveValue("id:1");
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
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/api/v1/moderation/channels"),
    );
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body ?? "{}")).toEqual({
      name: "new-lounge",
      type: "voice",
      category_id: 1,
      // A new channel goes to the bottom of its kind in the category.
      position: 1,
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
    await expect(page.locator("[data-testid='channel-category-select']")).toHaveValue("");
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
    await expect(page.locator("[data-testid='edit-channel-category-select']")).toHaveValue("id:1");
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
      (c) =>
        c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/api/v1/moderation/channels/1"),
    );
    expect(call.method).toBe("PATCH");
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      name: "general-renamed",
      topic: "New topic",
      slow_mode: 60,
      nsfw: false,
    });
    // Only changed fields are sent, so another admin's edit to the rest is kept.
    expect(body).not.toHaveProperty("category");
    expect(body).not.toHaveProperty("category_id");
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
      (c) =>
        c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/api/v1/moderation/channels/10"),
    );
    expect(call.method).toBe("PATCH");
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body["voice_max_users"]).toBe(9);
    // The video limit was not touched, so it is not sent.
    expect(body).not.toHaveProperty("voice_max_video");
  });

  test("voice limits are clamped to the server maximum", async ({ page }) => {
    await openSession(page);
    await openChannelMenu(page, 10);
    await page.locator("[data-testid='ctx-edit-channel']").click();

    await page.locator("[data-testid='edit-channel-max-users-input']").fill("999");
    await page.locator("[data-testid='edit-channel-submit']").click();

    const call = await waitForCapturedCall(
      page,
      (c) =>
        c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/api/v1/moderation/channels/10"),
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
      (c) =>
        c.cmd === "plugin:http|fetch" && (c.url ?? "").endsWith("/api/v1/moderation/channels/1"),
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

// ---------------------------------------------------------------------------
// Category management (WP 6.5b)
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: 1, name: "Text Channels", position: 0 },
  { id: 2, name: "Voice Channels", position: 1 },
  { id: 3, name: "Archive", position: 2 },
];

test.describe("Category management", () => {
  async function openCategoryMenu(page: Page, id: number): Promise<void> {
    await page.locator(`.category[data-category-id='${id}']`).click({ button: "right" });
    await expect(page.locator("[data-testid='category-context-menu']")).toBeVisible({
      timeout: 5_000,
    });
  }
  const categoryCalls = (calls: readonly CapturedCall[]): CapturedCall[] =>
    calls.filter((c) => (c.url ?? "").includes("/api/v1/moderation/channels/categories"));

  test("a manager sees an empty category and its management entries", async ({ page }) => {
    await openSession(page, { categories: CATEGORIES });
    await expect(page.locator(".category[data-category-id='3']")).toBeVisible();
    await openCategoryMenu(page, 3);
    for (const id of ["create", "rename", "move-up", "move-down", "delete"]) {
      await expect(page.locator(`[data-testid='ctx-category-${id}']`)).toBeVisible();
    }
  });

  test("without a category list the empty category is not drawn", async ({ page }) => {
    await openSession(page);
    await expect(page.locator(".category[data-category-id='1']")).toBeVisible();
    await expect(page.locator(".category[data-category-id='3']")).toHaveCount(0);
  });

  test("Create Category from the header menu POSTs the name", async ({ page }) => {
    await openSession(page, { categories: CATEGORIES });
    await openCategoryMenu(page, 1);
    await page.locator("[data-testid='ctx-category-create']").click();
    await page.locator("[data-testid='category-name-input']").fill("Games");
    await page.locator("[data-testid='category-name-submit']").click();

    const call = await waitForCapturedCall(page, (c) =>
      (c.url ?? "").endsWith("/api/v1/moderation/channels/categories"),
    );
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ name: "Games" });
  });

  test("Rename Category PATCHes the new name", async ({ page }) => {
    await openSession(page, { categories: CATEGORIES });
    await openCategoryMenu(page, 3);
    await page.locator("[data-testid='ctx-category-rename']").click();
    await expect(page.locator("[data-testid='category-name-input']")).toHaveValue("Archive");
    await page.locator("[data-testid='category-name-input']").fill("Old stuff");
    await page.locator("[data-testid='category-name-submit']").click();

    const call = await waitForCapturedCall(page, (c) => (c.url ?? "").endsWith("/categories/3"));
    expect(call.method).toBe("PATCH");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ name: "Old stuff" });
  });

  test("Delete Category confirms that channels move to no category, then DELETEs", async ({
    page,
  }) => {
    await openSession(page, { categories: CATEGORIES });
    await openCategoryMenu(page, 3);
    await page.locator("[data-testid='ctx-category-delete']").click();
    await expect(page.locator("[data-testid='delete-category-modal']")).toContainText(
      "No channels or messages are deleted",
    );
    expect(categoryCalls(await getCapturedCalls(page))).toEqual([]);
    await page.locator("[data-testid='delete-category-confirm']").click();

    const call = await waitForCapturedCall(page, (c) => (c.url ?? "").endsWith("/categories/3"));
    expect(call.method).toBe("DELETE");
  });

  test("Move Up PUTs the full id list with the category swapped", async ({ page }) => {
    await openSession(page, { categories: CATEGORIES });
    await openCategoryMenu(page, 3);
    await page.locator("[data-testid='ctx-category-move-up']").click();

    const call = await waitForCapturedCall(page, (c) =>
      (c.url ?? "").endsWith("/categories/order"),
    );
    expect(call.method).toBe("PUT");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ ids: [1, 3, 2] });
  });

  test("the server menu offers Create Category to a manager", async ({ page }) => {
    await openSession(page, { categories: CATEGORIES });
    await page.locator("[data-testid='server-name']").click();
    await page.locator("[data-testid='server-menu-create-category']").click();
    await expect(page.locator("[data-testid='create-category-modal']")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Drag between categories (WP 6.5c)
// ---------------------------------------------------------------------------

test.describe("Drag between categories", () => {
  /** Press on `from`, move over `to`'s centre in steps, and release there. */
  async function dragOnto(page: Page, from: string, to: string): Promise<void> {
    const a = await page.locator(from).boundingBox();
    const b = await page.locator(to).boundingBox();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
    await page.mouse.down();
    await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2 + 12, { steps: 4 });
    await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 8 });
    await page.mouse.up();
  }

  test("dropping a channel on another category's header PATCHes category_id and position", async ({
    page,
  }) => {
    await openSession(page, { categories: CATEGORIES });
    await dragOnto(page, "[data-testid='channel-1']", ".category[data-category-id='2']");

    const call = await waitForCapturedCall(
      page,
      (c) => c.method === "PATCH" && (c.url ?? "").endsWith("/api/v1/moderation/channels/1"),
    );
    // Appended after the category's text rows and before its voice row.
    expect(JSON.parse(call.body ?? "{}")).toEqual({ category_id: 2, position: 1 });
    // The voice row was re-slotted behind it.
    const voice = await waitForCapturedCall(
      page,
      (c) => c.method === "PATCH" && (c.url ?? "").endsWith("/api/v1/moderation/channels/10"),
    );
    expect(JSON.parse(voice.body ?? "{}")).toEqual({ position: 2 });
    // Optimistic: the row now sits under the second category.
    await expect(
      page
        .locator(".category[data-category-id='2']")
        .locator("xpath=following-sibling::div[contains(@class,'category-channels-container')]")
        .locator("[data-testid='channel-1']"),
    ).toBeVisible();
  });

  test("dragging a category header onto another PUTs the full order", async ({ page }) => {
    await openSession(page, { categories: CATEGORIES });
    // Archive (3) onto the upper half of the Text Channels header: before it.
    const target = await page.locator(".category[data-category-id='1']").boundingBox();
    const from = await page.locator(".category[data-category-id='3']").boundingBox();
    expect(target).not.toBeNull();
    expect(from).not.toBeNull();
    await page.mouse.move(from!.x + 60, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + 60, from!.y - 12, { steps: 4 });
    await page.mouse.move(target!.x + 60, target!.y + 2, { steps: 8 });
    await page.mouse.up();

    const call = await waitForCapturedCall(page, (c) =>
      (c.url ?? "").endsWith("/categories/order"),
    );
    expect(call.method).toBe("PUT");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ ids: [3, 1, 2] });
  });
});
