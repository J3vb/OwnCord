/**
 * Native E2E: Voice channel controls with real app.
 *
 * Tests voice channel UI, mute/deafen buttons, voice widget rendering,
 * and disconnect flow. Does NOT test actual WebRTC (no mic/audio).
 *
 * Requires: Server with at least 1 voice channel.
 */

import { test, expect } from "../native-fixture-persistent";
import { ensureLoggedIn, countVoiceChannels } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Voice Channel UI", () => {
  test.beforeEach(async ({ nativePage }) => {
    await ensureLoggedIn(nativePage);

    // Seeded fixture guarantees voice channels; missing data is a failure.
    const voiceCount = await countVoiceChannels(nativePage);
    expect(voiceCount).toBeGreaterThan(0);
  });

  test("voice channels are listed with speaker icon", async ({ nativePage }) => {
    const voiceIcons = nativePage.locator(".channel-item .ch-icon", { hasText: "🔊" });
    await expect(voiceIcons.first()).toBeVisible();
  });

  test("voice channel names are displayed", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    const name = await voiceChannels.first().locator(".ch-name").textContent();
    expect(name?.trim().length).toBeGreaterThan(0);
  });

  test("clicking voice channel triggers voice join", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    await voiceChannels.first().click();

    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });
  });

  test("voice widget shows channel name", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
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
    await voiceChannels.first().click();
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    await expect(voiceWidget.locator("button[aria-label='Mute']")).toBeVisible({ timeout: 5_000 });
    await expect(voiceWidget.locator("button[aria-label='Deafen']")).toBeVisible();
    await expect(voiceWidget.locator("button[aria-label='Disconnect']")).toBeVisible();
  });

  test("mute button toggles active state", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    await voiceChannels.first().click();
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    const muteBtn = voiceWidget.locator("button[aria-label='Mute']");
    await expect(muteBtn).toBeVisible({ timeout: 5_000 });

    await expect(muteBtn).toHaveAttribute("aria-pressed", "false");
    await muteBtn.click();
    await expect(muteBtn).toHaveAttribute("aria-pressed", "true");
    await expect(muteBtn).toHaveClass(/active-ctrl/);
    await muteBtn.click();
    await expect(muteBtn).toHaveAttribute("aria-pressed", "false");
    await expect(muteBtn).not.toHaveClass(/active-ctrl/);
  });

  test("disconnect button leaves voice channel", async ({ nativePage }) => {
    const voiceChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "🔊" }),
    });
    await voiceChannels.first().click();
    const voiceWidget = nativePage.locator(".voice-widget.visible");
    await expect(voiceWidget).toBeVisible({ timeout: 10_000 });

    const disconnectBtn = voiceWidget.locator("button[aria-label='Disconnect']");
    await expect(disconnectBtn).toBeVisible({ timeout: 5_000 });
    await disconnectBtn.click();

    await expect(voiceWidget).not.toBeVisible({ timeout: 10_000 });
  });
});
