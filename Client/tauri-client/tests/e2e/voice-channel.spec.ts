/**
 * E2E tests for voice channels and voice widget.
 * ChannelSidebar renders voice channels as .channel-item with 🔊 icon.
 * VoiceWidget shows connected users when in a voice channel.
 */
import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
} from "./helpers";

test.describe("Voice Channel Items", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("voice channels appear in sidebar with speaker icon", async ({ page }) => {
    // Voice channels use an SVG icon (createIcon("volume-2")) in .ch-icon span
    const voiceItems = page.locator(".channel-item.voice");
    await expect(voiceItems.first()).toBeVisible({ timeout: 5000 });
    // Should have at least 2 voice channels (Voice Chat, Music)
    await expect(voiceItems).toHaveCount(2);
    // Each voice channel item has an SVG icon in its .ch-icon span
    const firstIcon = voiceItems.first().locator(".ch-icon svg");
    await expect(firstIcon).toBeAttached();
  });

  test("voice channel shows channel name", async ({ page }) => {
    // Find channel item containing the voice icon, then check name
    const voiceChatName = page.locator(".ch-name", { hasText: "Voice Chat" });
    await expect(voiceChatName).toBeVisible();
  });

  test("voice widget shows when connected", async ({ page }) => {
    // VoiceWidget should be visible (mock connects user to voice channel)
    const widget = page.locator(".voice-widget.visible");
    await expect(widget).toBeVisible({ timeout: 5000 });
  });

  test("voice widget shows connected users", async ({ page }) => {
    // Mock voice state has 2 users in channel 10 (Voice Chat)
    const voiceUsers = page.locator(".voice-user-item");
    await expect(voiceUsers.first()).toBeVisible({ timeout: 5000 });
    await expect(voiceUsers).toHaveCount(2);
  });

  test("voice user item shows avatar", async ({ page }) => {
    const vuAvatar = page.locator(".vu-avatar").first();
    await expect(vuAvatar).toBeVisible({ timeout: 5000 });
  });

  test("muted user shows mute indicator", async ({ page }) => {
    // User 2 is muted in mock voice state
    const muteIcon = page.locator(".vu-muted");
    await expect(muteIcon.first()).toBeVisible({ timeout: 5000 });
  });

  test("voice widget shows channel name header", async ({ page }) => {
    const channelName = page.locator(".vw-channel");
    await expect(channelName).toContainText("Voice Chat");
  });

  test("voice widget has disconnect control", async ({ page }) => {
    const disconnectBtn = page.locator("button[aria-label='Disconnect']");
    await expect(disconnectBtn).toBeVisible({ timeout: 5000 });
  });

  test("mute button toggles active state on click", async ({ page }) => {
    const controls = page.locator(".vw-controls");
    await expect(controls).toBeVisible({ timeout: 5000 });

    const muteBtn = controls.locator("button[aria-label='Mute']");
    const hadActive = await muteBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    await muteBtn.click();

    // Button should toggle its active-ctrl class
    const hasActive = await muteBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    expect(hasActive).not.toBe(hadActive);
  });

  test("deafen button toggles active state on click", async ({ page }) => {
    const controls = page.locator(".vw-controls");
    await expect(controls).toBeVisible({ timeout: 5000 });

    const deafenBtn = controls.locator("button[aria-label='Deafen']");
    const hadActive = await deafenBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    await deafenBtn.click();

    const hasActive = await deafenBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    expect(hasActive).not.toBe(hadActive);
  });

  test("all five voice control buttons are present", async ({ page }) => {
    const controls = page.locator(".vw-controls");
    await expect(controls).toBeVisible({ timeout: 5000 });

    await expect(controls.locator("button[aria-label='Mute']")).toBeVisible();
    await expect(controls.locator("button[aria-label='Deafen']")).toBeVisible();
    await expect(controls.locator("button[aria-label='Camera']")).toBeVisible();
    await expect(controls.locator("button[aria-label='Screenshare']")).toBeVisible();
    await expect(controls.locator("button[aria-label='Disconnect']")).toBeVisible();
  });
});
