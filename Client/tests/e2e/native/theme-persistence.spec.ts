/**
 * Native E2E: Theme Persistence — real app theme switching and accent color.
 *
 * Tests that theme changes, accent color overrides, and compact mode
 * work correctly in the real Tauri application.
 */

import { test, expect } from "../native-fixture-persistent";
import { SKIP_SERVER, hasCredentials, ensureLoggedIn, openSettings } from "./helpers";

// ---------------------------------------------------------------------------
// Helper: switch to a settings tab by name
// ---------------------------------------------------------------------------

async function switchTab(page: import("@playwright/test").Page, tabName: string): Promise<void> {
  const tab = page.locator(".settings-sidebar button.settings-nav-item", { hasText: tabName });
  await tab.click();
  await expect(tab).toHaveClass(/active/);
}

// ---------------------------------------------------------------------------
// Tests: Theme Switching
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.describe("Theme Persistence (Native)", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
    await openSettings(nativePage);
    await switchTab(nativePage, "Appearance");
  });

  test("theme options are visible in Appearance tab", async ({ nativePage }) => {
    const themeOptions = nativePage.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("switching theme changes body class", async ({ nativePage }) => {
    const themeOptions = nativePage.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Record initial theme classes
    const initialClasses = await nativePage.evaluate(() =>
      [...document.body.classList].filter((c) => c.startsWith("theme-")),
    );

    // Find and click an inactive theme
    for (let i = 0; i < count; i++) {
      const isActive = await themeOptions.nth(i).evaluate((el) => el.classList.contains("active"));
      if (!isActive) {
        await themeOptions.nth(i).click();
        break;
      }
    }

    // Verify body class changed
    await expect(async () => {
      const newClasses = await nativePage.evaluate(() =>
        [...document.body.classList].filter((c) => c.startsWith("theme-")),
      );
      expect(newClasses).not.toEqual(initialClasses);
    }).toPass({ timeout: 3_000 });
  });

  test("accent color picker applies CSS variable", async ({ nativePage }) => {
    // AppearanceTab builds the picker from .accent-swatch rows plus a hex
    // input — there is no `input[type='color']`. Asserting the swatches exist
    // (rather than guarding on a selector that never matches) is what makes
    // this fail when the picker regresses.
    const swatches = nativePage.locator(".accent-swatch");
    await expect(swatches.first()).toBeVisible();
    expect(await swatches.count()).toBeGreaterThanOrEqual(2);

    // Pick a swatch that is not already active so applying it is observable.
    const target = nativePage.locator(".accent-swatch:not(.active)").first();
    const color = await target.getAttribute("title");
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);

    await target.click();

    // applyAccent sets the inline --accent on body (the value the theme class
    // would otherwise win against). Assert the rendered variable equals the
    // swatch we picked — not merely that some accent variable is non-empty.
    await expect
      .poll(() =>
        nativePage.evaluate(() => document.body.style.getPropertyValue("--accent").trim()),
      )
      .toBe(color!);
    await expect(target).toHaveClass(/active/);
  });

  test("theme persists after navigating away and back", async ({ nativePage }) => {
    const themeOptions = nativePage.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Click a specific theme (second option)
    await themeOptions.nth(1).click();

    // Wait for theme class to be applied
    await expect(async () => {
      const classes = await nativePage.evaluate(() =>
        [...document.body.classList].filter((c) => c.startsWith("theme-")),
      );
      expect(classes.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    // Record the theme
    const appliedClasses = await nativePage.evaluate(() =>
      [...document.body.classList].filter((c) => c.startsWith("theme-")),
    );

    // Navigate to Account tab and back
    await switchTab(nativePage, "Account");
    await switchTab(nativePage, "Appearance");

    // Verify the theme class is still applied
    const classesAfterNav = await nativePage.evaluate(() =>
      [...document.body.classList].filter((c) => c.startsWith("theme-")),
    );
    expect(classesAfterNav).toEqual(appliedClasses);
  });

  test("compact mode toggle adds class to body", async ({ nativePage }) => {
    const toggle = nativePage
      .locator(".setting-row", { hasText: "Compact Mode" })
      .locator(".toggle");
    await expect(toggle).toBeVisible();

    const wasCompact = await nativePage.evaluate(() =>
      document.body.classList.contains("compact-mode"),
    );

    await toggle.click();

    // Wait for class to flip
    await expect(async () => {
      const isCompactNow = await nativePage.evaluate(() =>
        document.body.classList.contains("compact-mode"),
      );
      expect(isCompactNow).not.toBe(wasCompact);
    }).toPass({ timeout: 3_000 });

    // Restore original state
    await toggle.click();

    await expect(async () => {
      const restored = await nativePage.evaluate(() =>
        document.body.classList.contains("compact-mode"),
      );
      expect(restored).toBe(wasCompact);
    }).toPass({ timeout: 3_000 });
  });
});
