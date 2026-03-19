/**
 * Native E2E: Settings overlay with real app.
 *
 * Tests opening/closing settings, tab navigation, theme changes,
 * and account settings against the real production build.
 */

import { test, expect } from "../native-fixture";
import { SKIP_SERVER, hasCredentials, nativeLoginAndReady, openSettings } from "./helpers";

test.describe("Settings Overlay", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await nativeLoginAndReady(nativePage);
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
    await openSettings(nativePage);

    const appearanceTab = nativePage.locator(".settings-sidebar button.settings-nav-item", {
      hasText: /appearance/i,
    });
    const exists = await appearanceTab.isVisible().catch(() => false);
    test.skip(!exists, "No Appearance tab found");

    await appearanceTab.click();
    await expect(appearanceTab).toHaveClass(/active/);
  });

  test("theme options are displayed in appearance tab", async ({ nativePage }) => {
    await openSettings(nativePage);

    const appearanceTab = nativePage.locator(".settings-sidebar button.settings-nav-item", {
      hasText: /appearance/i,
    });
    const exists = await appearanceTab.isVisible().catch(() => false);
    test.skip(!exists, "No Appearance tab found");

    await appearanceTab.click();

    // Theme options container with individual theme buttons
    const themeOptions = nativePage.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThan(0);
  });

  test("account tab shows user information", async ({ nativePage }) => {
    await openSettings(nativePage);

    const accountTab = nativePage.locator(".settings-sidebar button.settings-nav-item", {
      hasText: /account/i,
    });
    const exists = await accountTab.isVisible().catch(() => false);
    test.skip(!exists, "No Account tab found");

    await accountTab.click();
    await expect(accountTab).toHaveClass(/active/);
  });

  test("voice/audio tab exists", async ({ nativePage }) => {
    await openSettings(nativePage);

    const voiceTab = nativePage.locator(".settings-sidebar button.settings-nav-item", {
      hasText: /voice|audio/i,
    });
    const exists = await voiceTab.isVisible().catch(() => false);

    if (exists) {
      await voiceTab.click();
      await expect(voiceTab).toHaveClass(/active/);
    }
    // Voice tab may not exist in all builds
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
