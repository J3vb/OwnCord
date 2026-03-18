/**
 * Native E2E: Channel navigation with real server data.
 *
 * Tests switching between channels, verifying header updates,
 * message containers re-mount, and voice channel detection.
 */

import { test, expect } from "../native-fixture";
import { SKIP_SERVER, hasCredentials, nativeLoginAndReady } from "./helpers";

test.describe("Channel Navigation", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await nativeLoginAndReady(nativePage);
  });

  test("clicking a text channel makes it active", async ({ nativePage }) => {
    // Filter to text channels only (voice channels have different behavior)
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const count = await textChannels.count();
    test.skip(count < 2, "Need at least 2 text channels to test switching");

    // Click the second text channel
    const secondChannel = textChannels.nth(1);
    await secondChannel.click();

    // Should become active
    await expect(secondChannel).toHaveClass(/active/, { timeout: 5_000 });
  });

  test("switching text channels updates chat header", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const count = await textChannels.count();
    test.skip(count < 2, "Need at least 2 text channels to test switching");

    // Get first channel name, verify header matches
    const firstChannel = textChannels.first();
    const firstName = await firstChannel.locator(".ch-name").textContent();
    const header = nativePage.locator("[data-testid='chat-header-name']");
    const headerText = await header.textContent();
    expect(headerText?.trim()).toBe(firstName?.trim());

    // Switch to second text channel
    const secondChannel = textChannels.nth(1);
    const secondName = await secondChannel.locator(".ch-name").textContent();
    await secondChannel.click();

    // Header should update to the new text channel name
    await expect(header).toHaveText(secondName?.trim() ?? "", { timeout: 5_000 });
  });

  test("switching text channels loads new messages", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const count = await textChannels.count();
    test.skip(count < 2, "Need at least 2 text channels to test switching");

    // Wait for messages in first channel
    await expect(nativePage.locator(".messages-container")).toBeVisible({ timeout: 10_000 });

    // Switch to second text channel
    const secondChannel = textChannels.nth(1);
    await secondChannel.click();

    // Messages container should still be present (may re-mount)
    await expect(nativePage.locator(".messages-container")).toBeVisible({ timeout: 10_000 });
  });

  test("text channels have # icon", async ({ nativePage }) => {
    // Find a text channel by its # icon
    const textChannels = nativePage.locator(".channel-item .ch-icon", { hasText: "#" });
    const count = await textChannels.count();
    expect(count).toBeGreaterThan(0);
  });

  test("voice channels have speaker icon", async ({ nativePage }) => {
    // Voice channels may or may not exist depending on server config
    const voiceChannels = nativePage.locator(".channel-item .ch-icon", { hasText: "🔊" });
    const count = await voiceChannels.count();

    if (count > 0) {
      // Voice channels exist — verify they're rendered
      await expect(voiceChannels.first()).toBeVisible();
    }
    // If no voice channels, that's fine — server may not have any
  });

  test("clicking back to first text channel restores its active state", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const count = await textChannels.count();
    test.skip(count < 2, "Need at least 2 text channels to test switching");

    const firstChannel = textChannels.first();
    const secondChannel = textChannels.nth(1);

    // Switch to second text channel
    await secondChannel.click();
    await expect(secondChannel).toHaveClass(/active/, { timeout: 5_000 });

    // Switch back to first
    await firstChannel.click();
    await expect(firstChannel).toHaveClass(/active/, { timeout: 5_000 });
  });

  test("channel sidebar shows server name in header", async ({ nativePage }) => {
    const serverName = nativePage.locator(".channel-sidebar-header h2");
    await expect(serverName).toBeVisible();

    const text = await serverName.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });
});
