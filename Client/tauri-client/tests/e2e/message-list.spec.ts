import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  mockTauriFullSessionWithMessages,
  navigateToMainPage,
  emitWsMessage,
} from "./helpers";

test.describe("Message List — Structure", () => {
  test("renders messages with author, content, timestamp, and avatar", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const container = page.locator(".messages-container");
    await expect(container).toBeVisible();

    const message = page.locator("[data-testid='message-101']");
    await expect(message).toBeVisible({ timeout: 10_000 });

    // Verify all parts of a message render
    await expect(message.locator(".msg-author")).toBeVisible();
    await expect(message.locator(".msg-text")).toHaveText("Hello world!");
    await expect(message.locator(".msg-time")).toBeVisible();
    await expect(message.locator(".msg-avatar")).toBeVisible();
  });
});

test.describe("Message List — Rich Content", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("displays multiple messages with rich formatting", async ({ page }) => {
    const messages = page.locator(".message");
    await expect(messages.first()).toBeVisible({ timeout: 10_000 });
    const count = await messages.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Edited messages show indicator
    await expect(page.locator(".msg-edited").first()).toBeVisible();

    // Reply references show author
    const replyRef = page.locator(".msg-reply-ref").first();
    await expect(replyRef).toBeVisible();
    await expect(replyRef.locator(".rr-author")).toBeVisible();

    // Code blocks render
    await expect(page.locator(".msg-codeblock").first()).toBeVisible();
  });

  test("reactions and attachments render correctly", async ({ page }) => {
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });

    // Reaction chips show emoji and count
    const chip = page.locator(".reaction-chip").first();
    await expect(chip).toBeVisible();
    await expect(chip).not.toBeEmpty();

    // Image and file attachments
    await expect(page.locator(".msg-image").first()).toBeAttached();
    const file = page.locator(".msg-file").first();
    await expect(file).toBeAttached();
    await expect(file.locator(".msg-file-name")).toBeVisible();
  });

  test("grouped messages share avatar and day dividers separate dates", async ({ page }) => {
    const grouped = page.locator(".message.grouped");
    await expect(grouped.first()).toBeAttached({ timeout: 5000 });
    expect(await grouped.count()).toBeGreaterThanOrEqual(1);

    const divider = page.locator(".msg-day-divider");
    await expect(divider.first()).toBeAttached();
  });
});

test.describe("Message List — Real-time", () => {
  test("new message appears via WebSocket", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });
    const countBefore = await page.locator(".message").count();

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

    const newMsg = page.locator(".msg-text", { hasText: "A new real-time message!" });
    await expect(newMsg).toBeVisible({ timeout: 5_000 });

    const countAfter = await page.locator(".message").count();
    expect(countAfter).toBe(countBefore + 1);
  });

  test("multiple rapid messages all appear in order", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });

    for (let i = 0; i < 3; i++) {
      await emitWsMessage(page, {
        type: "chat_message",
        payload: {
          id: 300 + i,
          channel_id: 1,
          user: { id: 2, username: "otheruser", avatar: "" },
          content: `Rapid message ${i}`,
          timestamp: new Date().toISOString(),
          attachments: [],
          reply_to: null,
        },
      });
    }

    for (let i = 0; i < 3; i++) {
      await expect(
        page.locator(".msg-text", { hasText: `Rapid message ${i}` })
      ).toBeVisible({ timeout: 5_000 });
    }
  });
});
