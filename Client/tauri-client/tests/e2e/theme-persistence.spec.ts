/**
 * Mocked E2E: Theme Persistence — theme switching, accent color,
 * and compact mode.
 *
 * Tests that theme changes apply CSS classes to the body, persist
 * in localStorage, and survive navigation between settings tabs.
 */

import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Theme Switching
// ---------------------------------------------------------------------------

test.describe("Theme Persistence", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
  });

  test("switching theme changes body class", async ({ page }) => {
    // Get current theme classes on body
    const initialClasses = await page.evaluate(() =>
      [...document.body.classList].filter((c) => c.startsWith("theme-")),
    );
    expect(initialClasses.length).toBeGreaterThanOrEqual(1);

    // Click a different theme option
    const themeOptions = page.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Find a theme option that is NOT currently active
    let targetIndex = -1;
    for (let i = 0; i < count; i++) {
      const isActive = await themeOptions.nth(i).evaluate((el) =>
        el.classList.contains("active"),
      );
      if (!isActive) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex >= 0) {
      await themeOptions.nth(targetIndex).click();

      // Body class should have changed
      const newClasses = await page.evaluate(() =>
        [...document.body.classList].filter((c) => c.startsWith("theme-")),
      );
      expect(newClasses).not.toEqual(initialClasses);
    }
  });

  test("theme persists in localStorage", async ({ page }) => {
    // Click a specific theme option
    const themeOptions = page.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Click the second theme option
    await themeOptions.nth(1).click();

    // Check localStorage for theme persistence
    const storedTheme = await page.evaluate(() =>
      localStorage.getItem("owncord:theme:active"),
    );
    expect(storedTheme).not.toBeNull();
    expect(storedTheme!.length).toBeGreaterThan(0);
  });

  test("theme body class matches localStorage value", async ({ page }) => {
    // Click the first theme option to set a known state
    const themeOptions = page.locator(".theme-opt");
    await themeOptions.first().click();

    // Read what was stored
    const storedTheme = await page.evaluate(() =>
      localStorage.getItem("owncord:theme:active"),
    );

    // Verify the body has the corresponding class
    if (storedTheme !== null) {
      const hasClass = await page.evaluate((themeName) => {
        // Built-in themes use `theme-<name>` class
        return document.body.classList.contains(`theme-${themeName}`);
      }, storedTheme);
      expect(hasClass).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Accent Color
// ---------------------------------------------------------------------------

test.describe("Accent Color Override", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
  });

  test("accent color picker applies --accent CSS variable", async ({ page }) => {
    // Look for the accent color input (color picker or text input)
    const colorInput = page.locator("input[type='color'], .accent-color-input, .accent-picker");

    if (await colorInput.isVisible().catch(() => false)) {
      // Set a custom accent color
      await colorInput.fill("#ff5500");

      // Verify the --accent CSS variable is set on body
      const accentValue = await page.evaluate(() =>
        document.body.style.getPropertyValue("--accent").trim(),
      );
      // The accent may be set as --accent or --accent-primary
      const accentPrimary = await page.evaluate(() =>
        document.body.style.getPropertyValue("--accent-primary").trim(),
      );

      const hasAccent = accentValue.length > 0 || accentPrimary.length > 0;
      expect(hasAccent).toBe(true);
    }
  });

  test("accent color persists across settings tab navigation", async ({ page }) => {
    const colorInput = page.locator("input[type='color'], .accent-color-input, .accent-picker");

    if (await colorInput.isVisible().catch(() => false)) {
      // Set accent color
      await colorInput.fill("#ff5500");

      // Wait for the value to be stored
      await expect(async () => {
        const val = await page.evaluate(() =>
          localStorage.getItem("owncord:pref:accentColor"),
        );
        expect(val).not.toBeNull();
      }).toPass({ timeout: 3_000 });

      // Read the stored value
      const stored = await page.evaluate(() =>
        localStorage.getItem("owncord:pref:accentColor"),
      );

      // Navigate away from Appearance tab and back
      await switchSettingsTab(page, "Account");
      await switchSettingsTab(page, "Appearance");

      // Verify the accent is still applied
      const storedAfter = await page.evaluate(() =>
        localStorage.getItem("owncord:pref:accentColor"),
      );
      expect(storedAfter).toBe(stored);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Compact Mode
// ---------------------------------------------------------------------------

test.describe("Compact Mode", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
  });

  test("toggling compact mode adds .compact-mode to documentElement", async ({ page }) => {
    // Compact mode toggle is the one next to "Compact Mode" label
    const compactRow = page.locator(".setting-row", { hasText: "Compact Mode" });
    const toggle = compactRow.locator(".toggle");
    await expect(toggle).toBeVisible();

    const wasCompact = await page.evaluate(() =>
      document.documentElement.classList.contains("compact-mode"),
    );

    // Click the toggle
    await toggle.click();

    // Wait for the class to flip
    await expect(async () => {
      const isCompactNow = await page.evaluate(() =>
        document.documentElement.classList.contains("compact-mode"),
      );
      expect(isCompactNow).not.toBe(wasCompact);
    }).toPass({ timeout: 3_000 });
  });

  test("toggling compact mode off removes .compact-mode from documentElement", async ({ page }) => {
    const compactRow = page.locator(".setting-row", { hasText: "Compact Mode" });
    const toggle = compactRow.locator(".toggle");
    await expect(toggle).toBeVisible();

    // Enable compact mode if not already on
    const initialCompact = await page.evaluate(() =>
      document.documentElement.classList.contains("compact-mode"),
    );
    if (!initialCompact) {
      await toggle.click();
      await expect(async () => {
        const on = await page.evaluate(() =>
          document.documentElement.classList.contains("compact-mode"),
        );
        expect(on).toBe(true);
      }).toPass({ timeout: 3_000 });
    }

    // Verify it's on
    const afterEnable = await page.evaluate(() =>
      document.documentElement.classList.contains("compact-mode"),
    );
    expect(afterEnable).toBe(true);

    // Disable compact mode
    await toggle.click();

    // Wait for the class to be removed
    await expect(async () => {
      const afterDisable = await page.evaluate(() =>
        document.documentElement.classList.contains("compact-mode"),
      );
      expect(afterDisable).toBe(false);
    }).toPass({ timeout: 3_000 });
  });
});
