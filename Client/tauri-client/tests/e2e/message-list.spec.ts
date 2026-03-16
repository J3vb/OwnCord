import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  mockTauriFullSessionWithMessages,
  navigateToMainPage,
  emitWsMessage,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Message List — basic
// ---------------------------------------------------------------------------

test.describe("Message List", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("messages container is visible", async ({ page }) => {
    const container = page.locator(".messages-container");
    await expect(container).toBeVisible();
  });

  test("displays messages after channel load", async ({ page }) => {
    const messages = page.locator(".message");
    await expect(messages.first()).toBeVisible({ timeout: 10_000 });
  });

  test("message shows author name", async ({ page }) => {
    const author = page.locator(".msg-author").first();
    await expect(author).toBeVisible({ timeout: 10_000 });
  });

  test("message shows content text", async ({ page }) => {
    const text = page.locator(".msg-text").first();
    await expect(text).toBeVisible({ timeout: 10_000 });
    await expect(text).toHaveText("Hello world!");
  });

  test("message shows timestamp", async ({ page }) => {
    const time = page.locator(".msg-time").first();
    await expect(time).toBeVisible({ timeout: 10_000 });
  });

  test("message shows avatar", async ({ page }) => {
    const avatar = page.locator(".msg-avatar").first();
    await expect(avatar).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Message List — rich content
// ---------------------------------------------------------------------------

test.describe("Message List — Rich Content", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("displays multiple messages", async ({ page }) => {
    const messages = page.locator(".message");
    await expect(messages.first()).toBeVisible({ timeout: 10_000 });

    const count = await messages.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("shows edited indicator", async ({ page }) => {
    const edited = page.locator(".msg-edited");
    await expect(edited.first()).toBeVisible({ timeout: 10_000 });
  });

  test("shows reply references", async ({ page }) => {
    const replyRef = page.locator(".msg-reply-ref");
    await expect(replyRef.first()).toBeVisible({ timeout: 10_000 });

    const replyAuthor = replyRef.first().locator(".rr-author");
    await expect(replyAuthor).toBeVisible();
  });

  test("renders code blocks", async ({ page }) => {
    const codeBlock = page.locator(".msg-codeblock");
    await expect(codeBlock.first()).toBeVisible({ timeout: 10_000 });
  });

  test("shows reactions on messages", async ({ page }) => {
    const reactions = page.locator(".msg-reactions");
    await expect(reactions.first()).toBeVisible({ timeout: 10_000 });

    const chip = page.locator(".reaction-chip").first();
    await expect(chip).toBeVisible();
  });

  test("shows image attachments", async ({ page }) => {
    const image = page.locator(".msg-image");
    await expect(image.first()).toBeAttached({ timeout: 10_000 });
  });

  test("shows file attachments", async ({ page }) => {
    const file = page.locator(".msg-file");
    await expect(file.first()).toBeAttached({ timeout: 10_000 });

    const filename = file.first().locator(".msg-file-name");
    await expect(filename).toBeVisible();
  });

  test("grouped messages have grouped class", async ({ page }) => {
    await page.waitForTimeout(500);
    const grouped = page.locator(".message.grouped");
    const count = await grouped.count();
    // Messages from same author in quick succession should be grouped
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("day dividers are shown", async ({ page }) => {
    const divider = page.locator(".msg-day-divider");
    await expect(divider.first()).toBeAttached({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Message List — real-time
// ---------------------------------------------------------------------------

test.describe("Message List — Real-time", () => {
  test("new message appears via WebSocket", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Wait for initial messages to load
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });

    // Emit a new message via WebSocket
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 200,
        channel_id: 1,
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "A new real-time message!",
        timestamp: "2026-03-15T10:05:00Z",
        attachments: [],
        reply_to: null,
      },
    });

    // The new message should appear
    const newMsg = page.locator(".msg-text", { hasText: "A new real-time message!" });
    await expect(newMsg).toBeVisible({ timeout: 5_000 });
  });
});
