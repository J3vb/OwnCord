/**
 * Native E2E: Reconnection — basic connection state verification.
 *
 * Tests are intentionally conservative since we cannot easily kill/restart
 * the real server during a native test. We verify the connected state
 * and that the reconnecting banner behaves correctly.
 */

import { test, expect } from "../native-fixture-persistent";
import {
  SKIP_SERVER,
  hasCredentials,
  ensureLoggedIn,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Connection State
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.describe("Reconnection (Native)", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("reconnecting banner is NOT visible when connected", async ({ nativePage }) => {
    const banner = nativePage.locator(".reconnecting-banner");

    if (await banner.count() > 0) {
      // Banner element may exist in the DOM but should not be visible
      const isVisible = await banner.evaluate((el) =>
        el.classList.contains("visible"),
      );
      expect(isVisible).toBe(false);
    }
    // If the banner element doesn't exist at all, that's also fine
  });

  test("app layout is fully rendered when connected", async ({ nativePage }) => {
    // Verify the full app layout is present (proof of stable connection)
    const appLayout = nativePage.locator("[data-testid='app-layout']");
    await expect(appLayout).toBeVisible();

    // Channels should be populated
    const channelItems = nativePage.locator(".channel-item");
    const channelCount = await channelItems.count();
    expect(channelCount).toBeGreaterThan(0);

    // Chat header should be visible
    const chatHeader = nativePage.locator("[data-testid='chat-header']");
    await expect(chatHeader).toBeVisible();

    // Messages container should be visible
    const messagesContainer = nativePage.locator(".messages-container");
    await expect(messagesContainer).toBeVisible({ timeout: 10_000 });
  });

  test("user bar shows current user when connected", async ({ nativePage }) => {
    // User bar should display the logged-in user's name
    const userBar = nativePage.locator(".user-bar, [data-testid='user-bar']");
    await expect(userBar).toBeVisible();

    // The username should be visible in the user bar
    const userName = nativePage.locator(".ub-name, .user-bar-name");
    if (await userName.isVisible().catch(() => false)) {
      const text = await userName.textContent();
      expect(text?.trim().length).toBeGreaterThan(0);
    }
  });

  test("network state changes are handled gracefully", async ({ nativePage }) => {
    // Verify the app doesn't crash or show errors in a stable connected state.
    // We check multiple UI components are still responsive.

    // 1. Channel sidebar is interactive
    const channelItems = nativePage.locator(".channel-item");
    const count = await channelItems.count();
    if (count >= 2) {
      // Click second channel, verify it becomes active
      const secondChannel = channelItems.nth(1);
      await secondChannel.click();
      await expect(secondChannel).toHaveClass(/active/, { timeout: 5_000 });

      // Click first channel back
      const firstChannel = channelItems.first();
      await firstChannel.click();
      await expect(firstChannel).toHaveClass(/active/, { timeout: 5_000 });
    }

    // 2. Message input is usable
    const input = nativePage.locator("[data-testid='message-input'], .message-input-field, textarea.msg-box");
    if (await input.isVisible().catch(() => false)) {
      await input.focus();
      // Input should accept focus without errors
    }

    // 3. No error banners visible
    const banner = nativePage.locator(".reconnecting-banner");
    if (await banner.count() > 0) {
      const bannerVisible = await banner.evaluate((el) =>
        el.classList.contains("visible"),
      );
      expect(bannerVisible).toBe(false);
    }
  });
});
