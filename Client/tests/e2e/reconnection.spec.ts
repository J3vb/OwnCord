/**
 * Mocked E2E: Reconnection — banner visibility, WS state transitions,
 * and message persistence after reconnect.
 *
 * Tests the reconnection flow using mocked WS events to simulate
 * disconnect/reconnect sequences.
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  mockTauriFullSession,
  navigateToMainPageReady,
  emitWsEvent,
  emitWsMessage,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helper: simulate a full disconnect -> reconnect cycle
// ---------------------------------------------------------------------------

async function transportProgress(page: Page) {
  return page.evaluate(() => {
    const calls = (
      window as unknown as {
        __invokeLog: Array<{ cmd: string; args?: { clientConfig?: { url?: string } } }>;
      }
    ).__invokeLog;
    return {
      connects: calls.filter((call) => call.cmd === "ws_connect").length,
      historyReads: calls.filter(
        (call) =>
          call.cmd === "plugin:http|fetch" &&
          call.args?.clientConfig?.url?.includes("/channels/1/messages"),
      ).length,
    };
  });
}

/**
 * Disconnect and let the application's retry attempt drive the mock handshake.
 * A manual open/auth/READY would leave the real retry timer armed; its later
 * READY could overwrite an injected message with the static history fixture.
 */
async function simulateReconnect(page: Page): Promise<void> {
  await expect(page.getByTestId("message-101")).toBeVisible();
  const before = await transportProgress(page);
  await emitWsEvent(page, "ws-state", "closed");
  await expect(page.locator(".reconnecting-banner")).toHaveClass(/visible/);

  // The mock returns open/auth_ok/READY only after the client actually issues
  // ws_connect. An existing channel row alone cannot prove a reconnect.
  await expect.poll(async () => (await transportProgress(page)).connects).toBe(before.connects + 1);
  await expect
    .poll(async () => (await transportProgress(page)).historyReads)
    .toBeGreaterThan(before.historyReads);

  // READY clears the old history before fetching the tail; wait for that
  // response to render before injecting a genuinely post-reconnect message.
  await expect(page.getByTestId("message-101")).toBeVisible();
  await expect(page.locator(".reconnecting-banner")).not.toHaveClass(/visible/);
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
