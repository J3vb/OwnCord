import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  mockTauriFullSessionWithMusic,
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
  joinVoiceChannelByName,
} from "./helpers";

type Mock = typeof mockTauriFullSessionWithMusic;

async function joinVoice(page: Page, mock: Mock): Promise<void> {
  await mock(page);
  await page.goto("/");
  await navigateToMainPage(page);
  await joinVoiceChannelByName(page);
  await expect(page.locator("[data-testid='voice-widget'].visible")).toBeVisible({
    timeout: 5_000,
  });
}

// The mocked session never reaches a connected room (no SFU), so the call
// controls stay locked and the picker cannot be opened here; the picker and
// the share itself are covered by the unit suites and the native-voice suite.
test.describe("Share music", () => {
  test("the voice widget has a Share music button the host can serve", async ({ page }) => {
    await joinVoice(page, mockTauriFullSessionWithMusic);
    const button = page.locator("[data-testid='vw-music-btn']");
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-label", "Share music");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    // A host that can capture app audio is held only by the join; it is not
    // refused for lacking the feature.
    await expect(button).not.toHaveAttribute("title", /Windows 10/);
  });

  test("a host with no per-app capture says why the button is off", async ({ page }) => {
    await joinVoice(page, mockTauriFullSessionWithVoice);
    const button = page.locator("[data-testid='vw-music-btn']");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", /Windows 10/);
  });
});
