/**
 * Mocked E2E: Reconnection — banner visibility, WS state transitions,
 * and message persistence after reconnect.
 *
 * Tests the reconnection flow using mocked WS events to simulate
 * disconnect/reconnect sequences.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  mockTauriFullSession,
  navigateToMainPageReady,
  emitWsEvent,
  emitWsMessage,
  MOCK_AUTH_OK,
  MOCK_CHANNELS,
  MOCK_ROLES,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helper: simulate a full disconnect -> reconnect cycle
// ---------------------------------------------------------------------------

const MOCK_READY_PAYLOAD = {
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

/**
 * Simulate a full disconnect -> reconnect -> auth_ok -> ready sequence.
 * Waits for the reconnect banner to disappear and channels to reappear.
 */
async function simulateReconnect(page: Page): Promise<void> {
  // Disconnect
  await emitWsEvent(page, "ws-state", "closed");

  // Reconnect
  await emitWsEvent(page, "ws-state", "open");
  await emitWsMessage(page, MOCK_AUTH_OK);
  await emitWsMessage(page, MOCK_READY_PAYLOAD);

  // Wait for channels to reappear as proof of successful reconnect
  await expect(page.locator(".channel-item").first()).toBeVisible({ timeout: 5_000 });
}

// ---------------------------------------------------------------------------
// Tests: Reconnection Banner
// ---------------------------------------------------------------------------

test.describe("Reconnection — Banner Visibility", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("reconnecting banner is hidden when connected", async ({ page }) => {
    const banner = page.locator(".reconnecting-banner");
    // The banner element exists but should NOT have the "visible" class
    if ((await banner.count()) > 0) {
      await expect(banner).not.toHaveClass(/visible/);
    }
  });

  test("disconnect shows reconnecting banner", async ({ page }) => {
    // Emit WS close event to simulate disconnection
    await emitWsEvent(page, "ws-state", "closed");

    const banner = page.locator(".reconnecting-banner");
    // After disconnect, the banner should become visible
    await expect(banner).toBeVisible({ timeout: 5_000 });
  });

  test("reconnect hides banner", async ({ page }) => {
    await simulateReconnect(page);

    const banner = page.locator(".reconnecting-banner");
    if ((await banner.count()) > 0) {
      // After successful reconnect, banner should be hidden
      await expect(banner).not.toHaveClass(/visible/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Post-Reconnection State
// ---------------------------------------------------------------------------

test.describe("Reconnection — State Recovery", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("channels are still displayed after reconnect", async ({ page }) => {
    // Verify channels are visible before disconnect
    const channelsBefore = page.locator(".channel-item");
    const countBefore = await channelsBefore.count();
    expect(countBefore).toBeGreaterThan(0);

    await simulateReconnect(page);

    // Channels should still be visible
    await expect(async () => {
      const countAfter = await page.locator(".channel-item").count();
      expect(countAfter).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
  });

  test("messages container is visible after reconnect", async ({ page }) => {
    // Verify messages container exists
    const messagesContainer = page.locator(".messages-container");
    await expect(messagesContainer).toBeVisible({ timeout: 5_000 });

    await simulateReconnect(page);

    // Messages container should still be visible
    await expect(messagesContainer).toBeVisible({ timeout: 5_000 });
  });

  test("new messages arrive after reconnect", async ({ page }) => {
    await simulateReconnect(page);

    // Emit a new chat_message after reconnect
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 2000,
        channel_id: 1,
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "Post-reconnect message!",
        timestamp: new Date().toISOString(),
        edited_at: null,
        attachments: [],
        reactions: [],
        reply_to: null,
        pinned: false,
        deleted: false,
      },
    });

    // Wait for the message to render
    const newMsg = page.locator(".msg-text", { hasText: "Post-reconnect message!" });
    await expect(newMsg).toBeVisible({ timeout: 5_000 });
  });
});
