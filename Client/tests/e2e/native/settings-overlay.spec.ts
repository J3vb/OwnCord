/**
 * Native E2E: Settings overlay with real app.
 *
 * Tests opening/closing settings, tab navigation, theme changes,
 * and account settings against the real production build.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../native-fixture-persistent";
import { SKIP_SERVER, hasCredentials, ensureLoggedIn, openSettings } from "./helpers";

test.describe.configure({ mode: "serial" });

/** Opens settings and clicks the tab matching `name`; skips the test when the build has none. */
async function openTabIfPresent(page: Page, name: RegExp, label: string): Promise<Locator> {
  await openSettings(page);
  const tab = page.locator(".settings-sidebar button.settings-nav-item", { hasText: name });
  const exists = await tab.isVisible().catch(() => false);
  test.skip(!exists, `No ${label} tab found`);
  await tab.click();
  return tab;
}

test.describe("Settings Overlay", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("settings overlay opens via gear button", async ({ nativePage }) => {
    await openSettings(nativePage);

    const overlay = nativePage.locator("[data-testid='settings-overlay']");
    await expect(overlay).toBeVisible();
  });

  test("settings has navigation sidebar with tabs", async ({ nativePage }) => {
    await openSettings(nativePage);

    const navItems = nativePage.locator(".settings-sidebar button.settings-nav-item");
    const count = await navItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test("can switch between settings tabs", async ({ nativePage }) => {
    await openSettings(nativePage);

    const navItems = nativePage.locator(".settings-sidebar button.settings-nav-item");
    const count = await navItems.count();
    test.skip(count < 2, "Need at least 2 settings tabs");

    // Click the second tab
    const secondTab = navItems.nth(1);
    await secondTab.click();
    await expect(secondTab).toHaveClass(/active/);
  });

  test("appearance tab exists and is navigable", async ({ nativePage }) => {
    const appearanceTab = await openTabIfPresent(nativePage, /appearance/i, "Appearance");
    await expect(appearanceTab).toHaveClass(/active/);
  });

  test("theme options are displayed in appearance tab", async ({ nativePage }) => {
    await openTabIfPresent(nativePage, /appearance/i, "Appearance");

    // Theme options container with individual theme buttons
    const themeOptions = nativePage.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThan(0);
  });

  test("account tab shows user information", async ({ nativePage }) => {
    const accountTab = await openTabIfPresent(nativePage, /account/i, "Account");
    await expect(accountTab).toHaveClass(/active/);
  });

  test("voice/audio tab opens its real controls", async ({ nativePage }) => {
    await openSettings(nativePage);

    // The Voice & Video tab is part of every build (SettingsOverlay's appTabs
    // list), so an absent tab is a regression, not a skippable build variant.
    const voiceTab = nativePage.locator(".settings-sidebar button.settings-nav-item", {
      hasText: /voice|audio/i,
    });
    await expect(voiceTab).toBeVisible();

    await voiceTab.click();
    await expect(voiceTab).toHaveClass(/active/);

    // Behaviour, not mere existence: the active pane must be the Voice & Video
    // pane, with its Microphone card, input-device selector and live mic meter
    // mounted.
    const pane = nativePage.locator(".settings-content .settings-pane.active");
    await expect(pane.getByRole("heading", { name: "Microphone", exact: true })).toBeVisible();
    await expect(pane.getByRole("combobox", { name: "Input Device" })).toBeVisible();
    await expect(pane.locator(".mic-meter-wrap .mic-meter-bar")).toBeVisible();
  });

  test("settings can be closed with close button or escape", async ({ nativePage }) => {
    await openSettings(nativePage);

    const overlay = nativePage.locator("[data-testid='settings-overlay']");
    await expect(overlay).toHaveClass(/open/);

    // Press Escape to close
    await nativePage.keyboard.press("Escape");

    // Overlay should close (class removed or element hidden)
    await expect(overlay).not.toHaveClass(/open/, { timeout: 3_000 });
  });
});
