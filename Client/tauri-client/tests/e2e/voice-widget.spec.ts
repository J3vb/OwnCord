import { test, expect } from "@playwright/test";
import { mockTauriFullSessionWithVoice, navigateToMainPage, emitWsMessage } from "./helpers";

const VOICE_STATE_EVENT = {
  type: "voice_state" as const,
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
};

test.describe("Voice Widget", () => {
  test("is hidden by default when user has no voice state", async ({ page }) => {
    const { mockTauriFullSession } = await import("./helpers");
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const widget = page.locator("[data-testid='voice-widget']");
    await expect(widget).toBeAttached();
    await expect(widget).not.toHaveClass(/visible/);
  });

  test("appears with full UI when voice_state event is received", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, VOICE_STATE_EVENT);

    const widget = page.locator("[data-testid='voice-widget'].visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });

    // Verify all widget parts render in one test
    await expect(widget.locator(".vw-connected")).toBeVisible();
    await expect(widget.locator(".vw-channel")).toBeVisible();
    await expect(widget.locator(".voice-users-list")).toBeVisible();
    await expect(widget.locator(".vw-controls")).toBeVisible();
    await expect(page.locator("button[aria-label='Disconnect']")).toBeVisible();
  });

  test("mute button toggles active state on click", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, VOICE_STATE_EVENT);
    const controls = page.locator(".vw-controls");
    await expect(controls).toBeVisible({ timeout: 5_000 });

    const muteBtn = controls.locator("button[aria-label='Mute']");
    const hadActive = await muteBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    await muteBtn.click();
    const hasActive = await muteBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    expect(hasActive).not.toBe(hadActive);
  });

  test("deafen button toggles active state on click", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, VOICE_STATE_EVENT);
    const controls = page.locator(".vw-controls");
    await expect(controls).toBeVisible({ timeout: 5_000 });

    const deafenBtn = controls.locator("button[aria-label='Deafen']");
    const hadActive = await deafenBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    await deafenBtn.click();
    const hasActive = await deafenBtn.evaluate((el) => el.classList.contains("active-ctrl"));
    expect(hasActive).not.toBe(hadActive);
  });

  test("second user joining voice appears in users list", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);

    await emitWsMessage(page, VOICE_STATE_EVENT);
    const widget = page.locator("[data-testid='voice-widget'].visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });

    const usersBefore = await page.locator(".voice-user-item").count();

    // Another user joins the voice channel
    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 3,
        username: "newvoiceuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    // New user should appear in the list
    await expect(page.locator("[data-testid='voice-user-3']")).toBeVisible({ timeout: 5_000 });
    const usersAfter = await page.locator(".voice-user-item").count();
    expect(usersAfter).toBeGreaterThan(usersBefore);
  });
});
