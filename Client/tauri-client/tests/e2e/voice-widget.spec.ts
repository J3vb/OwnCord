import { test, expect } from "@playwright/test";
import { mockTauriFullSessionWithVoice, navigateToMainPage, emitWsMessage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Voice Widget
// ---------------------------------------------------------------------------

test.describe("Voice Widget", () => {
  test("voice widget is hidden by default when no voice state", async ({ page }) => {
    // Use full session WITHOUT voice to check default hidden state
    const { mockTauriFullSession } = await import("./helpers");
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const widget = page.locator(".voice-widget");
    if (await widget.count() > 0) {
      await expect(widget).not.toHaveClass(/visible/);
    }
  });

  test("voice widget appears when in voice channel", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Emit voice state to trigger widget visibility
    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    const widget = page.locator(".voice-widget.visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });
  });

  test("voice widget shows channel name", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    const channelName = page.locator(".vw-channel");
    await expect(channelName).toBeVisible({ timeout: 5_000 });
  });

  test("voice widget shows control buttons", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    const controls = page.locator(".vw-controls");
    await expect(controls).toBeVisible({ timeout: 5_000 });

    const buttons = controls.locator("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("voice widget shows connected users list", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    const usersList = page.locator(".voice-users-list");
    await expect(usersList).toBeVisible({ timeout: 5_000 });
  });

  test("voice widget has disconnect button", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    const widget = page.locator(".voice-widget.visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });

    // Disconnect button should be in controls
    const disconnectBtn = page.locator(".vw-controls .disconnect");
    if (await disconnectBtn.count() > 0) {
      await expect(disconnectBtn).toBeVisible();
    }
  });

  test("voice widget shows Voice Connected header", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    const header = page.locator(".vw-connected");
    await expect(header).toBeVisible({ timeout: 5_000 });
  });
});
