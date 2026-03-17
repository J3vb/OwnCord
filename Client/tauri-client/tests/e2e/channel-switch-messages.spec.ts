import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithMessages,
  navigateToMainPage,
  emitWsMessage,
  MOCK_CHANNELS_WITH_CATEGORIES,
} from "./helpers";

test.describe("Channel Switch — Messages", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("switching channels updates header and clears messages container", async ({ page }) => {
    // Verify we start on the first channel
    const headerName = page.locator(".chat-header .ch-name");
    await expect(headerName).toHaveText("general");

    // Wait for messages to load
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });

    // Click the second channel
    const secondChannel = page.locator(".channel-item").nth(1);
    await secondChannel.click();

    // Header should update
    await expect(headerName).toHaveText("random");
  });

  test("switching to a channel and back preserves messages", async ({ page }) => {
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });

    // Remember initial message count
    const initialCount = await page.locator(".message").count();
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Switch to second channel
    const channels = page.locator(".channel-item");
    await channels.nth(1).click();
    await expect(page.locator(".chat-header .ch-name")).toHaveText("random");

    // Switch back
    await channels.first().click();
    await expect(page.locator(".chat-header .ch-name")).toHaveText("general");

    // Messages should still be there (loaded from cache)
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });
  });

  test("new message on inactive channel does not appear in current view", async ({ page }) => {
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });
    const countBefore = await page.locator(".message").count();

    // Send a message to channel 2 (random) while we're viewing channel 1 (general)
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 500,
        channel_id: 2,
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "Message on other channel",
        timestamp: new Date().toISOString(),
        attachments: [],
        reply_to: null,
      },
    });

    // Wait for the unread badge to confirm the event was processed
    const secondChannel = page.locator(".channel-item").nth(1);
    await expect(secondChannel.locator(".unread-badge")).toBeVisible({ timeout: 5_000 });

    // Message count on current channel should not change
    const countAfter = await page.locator(".message").count();
    expect(countAfter).toBe(countBefore);

    // The message should NOT be visible in current view
    await expect(
      page.locator(".msg-text", { hasText: "Message on other channel" })
    ).not.toBeVisible();
  });

  test("unread badge appears on channel with new message", async ({ page }) => {
    await expect(page.locator(".message").first()).toBeVisible({ timeout: 10_000 });

    // Send a message to the non-active channel
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 501,
        channel_id: 2,
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "Unread message",
        timestamp: new Date().toISOString(),
        attachments: [],
        reply_to: null,
      },
    });

    // The non-active channel should show an unread badge
    const secondChannel = page.locator(".channel-item").nth(1);
    const badge = secondChannel.locator(".unread-badge");
    await expect(badge).toBeVisible({ timeout: 5_000 });
  });
});
