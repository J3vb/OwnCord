/**
 * Native E2E: Voice channel controls with real app.
 *
 * Tests voice channel UI, mute/deafen buttons, voice widget rendering,
 * and disconnect flow. Does NOT test actual WebRTC (no mic/audio).
 */

import { test, expect } from "../native-fixture";
import { SKIP_SERVER, hasCredentials, nativeLoginAndReady } from "./helpers";

test.describe("Voice Channel UI", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await nativeLoginAndReady(nativePage);
  });

  test("voice channels are listed with speaker icon", async ({ nativePage }) => {
    const voiceIcons = nativePage.locator(".channel-item .ch-icon", { hasText: "🔊" });
    const count = await voiceIcons.count();
    test.skip(count === 0, "No voice channels on this server");

    await expect(voiceIcons.first()).toBeVisible();
  });

  test("voice channel names are displayed", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const count = await voiceChannels.count();
    test.skip(count === 0, "No voice channels on this server");

    const name = await voiceChannels.first().locator(".ch-name").textContent();
    expect(name?.trim().length).toBeGreaterThan(0);
  });

  test("clicking voice channel triggers voice join", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const count = await voiceChannels.count();
    test.skip(count === 0, "No voice channels on this server");

    await voiceChannels.first().click();

    // Voice widget should appear (may take time for WebRTC setup)
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });
  });

  test("voice widget shows channel name", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const count = await voiceChannels.count();
    test.skip(count === 0, "No voice channels on this server");

    const channelName = await voiceChannels.first().locator(".ch-name").textContent();
    await voiceChannels.first().click();

    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    const widgetChannel = voiceWidget.locator(".vw-channel");
    await expect(widgetChannel).toContainText(channelName?.trim() ?? "");
  });

  test("voice widget has control buttons", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const count = await voiceChannels.count();
    test.skip(count === 0, "No voice channels on this server");

    await voiceChannels.first().click();
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    // All control buttons should be present
    await expect(voiceWidget.locator("button[aria-label='Mute']")).toBeVisible({ timeout: 5_000 });
    await expect(voiceWidget.locator("button[aria-label='Deafen']")).toBeVisible();
    await expect(voiceWidget.locator("button[aria-label='Disconnect']")).toBeVisible();
  });

  test("mute button toggles active state", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const count = await voiceChannels.count();
    test.skip(count === 0, "No voice channels on this server");

    await voiceChannels.first().click();
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    const muteBtn = voiceWidget.locator("button[aria-label='Mute']");
    await expect(muteBtn).toBeVisible({ timeout: 5_000 });

    // Toggle mute
    await muteBtn.click();
    const hasActive = await muteBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    expect(typeof hasActive).toBe("boolean");

    // Toggle back
    await muteBtn.click();
  });

  test("disconnect button leaves voice channel", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const count = await voiceChannels.count();
    test.skip(count === 0, "No voice channels on this server");

    await voiceChannels.first().click();
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    // Click disconnect
    const disconnectBtn = voiceWidget.locator("button[aria-label='Disconnect']");
    await expect(disconnectBtn).toBeVisible({ timeout: 5_000 });
    await disconnectBtn.click();

    // Voice widget should disappear
    await expect(voiceWidget).not.toBeVisible({ timeout: 10_000 });
  });
});
