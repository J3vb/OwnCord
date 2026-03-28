/**
 * Voice lifecycle E2E tests — tests the full voice join → widget → leave flow.
 *
 * These tests use the existing Tauri mock infrastructure to simulate:
 * - WebSocket voice_state and voice_leave events
 * - Voice channel UI (sidebar voice users, voice widget)
 * - Speaker indicators, connection quality, listen-only mode
 *
 * NOTE: These tests do NOT exercise real LiveKit/WebRTC connections.
 * Real voice E2E requires the native test infrastructure (Tauri exe + LiveKit binary).
 * These tests validate the UI layer's response to voice-related WS events.
 */

import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithVoice,
  navigateToMainPageReady,
  emitWsMessage,
  MOCK_CHANNELS_WITH_CATEGORIES,
} from "./helpers";

test.describe("Voice lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("shows voice users in voice channel sidebar", async ({ page }) => {
    // MOCK_VOICE_STATE has users 1 and 2 in channel 10 ("Voice Chat")
    const voiceChannel = page.locator(".channel-item", { hasText: "Voice Chat" });
    await expect(voiceChannel).toBeVisible();

    // Voice users should appear under the voice channel
    const voiceUsers = page.locator(".voice-user-item");
    await expect(voiceUsers).toHaveCount(2, { timeout: 5000 });
  });

  test("voice user shows muted indicator", async ({ page }) => {
    // User 2 is muted in MOCK_VOICE_STATE
    const mutedUser = page.locator(".voice-user-item .vu-muted");
    await expect(mutedUser.first()).toBeVisible({ timeout: 5000 });
  });

  test("voice channel shows correct channel name", async ({ page }) => {
    // The voice channel "Voice Chat" (id=10) should be visible in the sidebar
    const voiceChannel = page.locator(".channel-item", { hasText: "Voice Chat" });
    await expect(voiceChannel).toBeVisible({ timeout: 5000 });
    // And "Music" (id=11) should also be visible
    const musicChannel = page.locator(".channel-item", { hasText: "Music" });
    await expect(musicChannel).toBeVisible({ timeout: 5000 });
  });

  test("voice_leave event removes user from voice channel", async ({ page }) => {
    // Wait for initial voice users
    await expect(page.locator(".voice-user-item")).toHaveCount(2, { timeout: 5000 });

    // Emit voice_leave for user 2
    await emitWsMessage(page, {
      type: "voice_leave",
      payload: {
        user_id: 2,
        channel_id: 10,
      },
    });

    // Should now have 1 user
    await expect(page.locator(".voice-user-item")).toHaveCount(1, { timeout: 5000 });
  });

  test("speaker indicator updates on voice_speakers event", async ({ page }) => {
    // Wait for voice users to render
    await expect(page.locator(".voice-user-item")).toHaveCount(2, { timeout: 5000 });

    // Emit speakers event — user 1 is speaking
    await emitWsMessage(page, {
      type: "voice_speakers",
      payload: {
        channel_id: 10,
        speakers: [1],
      },
    });

    // The speaking user's avatar should have the speaking class
    const speakingAvatar = page.locator(".voice-user-item.speaking");
    await expect(speakingAvatar).toBeVisible({ timeout: 5000 });
  });

  test("speaker indicator clears when user stops speaking", async ({ page }) => {
    await expect(page.locator(".voice-user-item")).toHaveCount(2, { timeout: 5000 });

    // User starts speaking
    await emitWsMessage(page, {
      type: "voice_speakers",
      payload: { channel_id: 10, speakers: [1] },
    });
    await expect(page.locator(".voice-user-item.speaking")).toBeVisible({ timeout: 5000 });

    // User stops speaking (empty speakers list)
    await emitWsMessage(page, {
      type: "voice_speakers",
      payload: { channel_id: 10, speakers: [] },
    });
    await expect(page.locator(".voice-user-item.speaking")).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe("Voice widget", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("voice widget exists in DOM", async ({ page }) => {
    // The voice widget is always in the DOM but only visible when
    // connected to a voice channel via LiveKit (not via WS mock alone).
    // In mock mode, the widget exists but currentChannelId is null.
    const widget = page.locator("[data-testid='voice-widget']");
    await expect(widget).toBeAttached();
  });

  test("voice widget has correct control buttons", async ({ page }) => {
    const widget = page.locator("[data-testid='voice-widget']");
    // Even when hidden, the buttons should exist in the DOM
    await expect(widget.locator("button[aria-label='Mute']")).toBeAttached();
    await expect(widget.locator("button[aria-label='Deafen']")).toBeAttached();
    await expect(widget.locator("button[aria-label='Camera']")).toBeAttached();
    await expect(widget.locator("button[aria-label='Screenshare']")).toBeAttached();
    await expect(widget.locator("button[aria-label='Disconnect']")).toBeAttached();
  });

  test("voice widget has grant mic button (hidden by default)", async ({ page }) => {
    const grantMicBtn = page.locator(".vw-grant-mic");
    // Should exist but be hidden (listenOnly is false)
    await expect(grantMicBtn).toBeAttached();
    await expect(grantMicBtn).toBeHidden();
  });

  test("voice widget has signal quality indicator", async ({ page }) => {
    const signal = page.locator(".vw-signal");
    await expect(signal).toBeAttached();
  });

  test("voice widget stats pane toggles on signal click", async ({ page }) => {
    const signal = page.locator(".vw-signal");
    const statsPane = page.locator(".vw-stats");

    // Initially hidden
    await expect(statsPane).not.toHaveClass(/visible/);

    // Click signal to show
    await signal.click();
    await expect(statsPane).toHaveClass(/visible/);

    // Click again to hide
    await signal.click();
    await expect(statsPane).not.toHaveClass(/visible/);
  });
});
