import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  navigateToMainPage,
  emitWsMessage,
} from "./helpers";

test.describe("Typing Indicator — WebSocket", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("typing indicator appears when another user starts typing", async ({ page }) => {
    const typingSlot = page.locator("[data-testid='typing-slot']");
    await expect(typingSlot).toBeAttached();

    // Initially empty
    const typingBar = page.locator(".typing-bar");
    if (await typingBar.count() > 0) {
      await expect(typingBar).toBeEmpty();
    }

    // Emit typing event from another user (server sends "typing", not "typing_start")
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 1,
        user_id: 2,
        username: "otheruser",
      },
    });

    // Typing indicator should show the username
    const typingText = page.locator(".typing-bar");
    await expect(typingText).toContainText("otheruser", { timeout: 5_000 });
  });

  test("typing indicator does not show for current user", async ({ page }) => {
    // Emit typing event from the current user (id: 1)
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 1,
        user_id: 1,
        username: "testuser",
      },
    });

    // Should NOT show "testuser is typing"
    const typingText = page.locator(".typing-bar", { hasText: "testuser" });
    await expect(typingText).not.toBeVisible({ timeout: 1000 });
  });

  test("typing indicator ignores events from other channels", async ({ page }) => {
    // We're viewing channel 1, emit typing on channel 2
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 2,
        user_id: 2,
        username: "otheruser",
      },
    });

    const typingText = page.locator(".typing-bar", { hasText: "otheruser" });
    await expect(typingText).not.toBeVisible({ timeout: 1000 });
  });
});
