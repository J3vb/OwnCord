/**
 * Mocked E2E: Theme Persistence — theme switching, accent color,
 * and compact mode.
 *
 * Tests that theme changes apply CSS classes to the body, persist
 * in localStorage, and survive navigation between settings tabs.
 */

import { test, expect } from "./fixtures";
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

    // Must be a different theme available to switch to — not an optional
    // discovery that silently skips the assertion when none is found.
    const inactiveOption = page.locator(".theme-opt:not(.active)");
    await expect(inactiveOption.first()).toBeVisible();
    const themeName = await inactiveOption.first().evaluate((el) => {
      const classes = el.classList;
      for (const name of ["dark", "neon-glow", "midnight", "light"]) {
        if (classes.contains(name)) return name;
      }
      return "";
    });
    expect(themeName).not.toBe("");

    await inactiveOption.first().click();

    // Body class should now carry the selected theme, and it should differ
    // from what we started with.
    const newClasses = await page.evaluate(() =>
      [...document.body.classList].filter((c) => c.startsWith("theme-")),
    );
    expect(newClasses).toContain(`theme-${themeName}`);
    expect(newClasses).not.toEqual(initialClasses);
  });

  test("theme persists in localStorage", async ({ page }) => {
    // Click a specific theme option
    const themeOptions = page.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Click the second theme option
    await themeOptions.nth(1).click();

    // Check localStorage for theme persistence
    const storedTheme = await page.evaluate(() => localStorage.getItem("owncord:theme:active"));
    expect(storedTheme).not.toBeNull();
    expect(storedTheme!.length).toBeGreaterThan(0);
  });

  test("theme body class matches localStorage value", async ({ page }) => {
    // Click the first theme option to set a known state
    const themeOptions = page.locator(".theme-opt");
    await themeOptions.first().click();

    // Read what was stored — must be a real value, not null (the old guard
    // passed vacuously when nothing was stored).
    const storedTheme = await page.evaluate(() => localStorage.getItem("owncord:theme:active"));
    expect(storedTheme).not.toBeNull();

    // Verify the body has the corresponding class
    const hasClass = await page.evaluate((themeName) => {
      // Built-in themes use `theme-<name>` class
      return document.body.classList.contains(`theme-${themeName}`);
    }, storedTheme!);
    expect(hasClass).toBe(true);
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
    // The hex field is the accent picker. Fail if it is missing — the old
    // `if (isVisible)` guard made this test pass with zero assertions when
    // the picker was absent.
    const hexInput = page.locator(".accent-hex-row input.form-input");
    await expect(hexInput).toBeVisible();

    await hexInput.fill("ff5500");

    // The rendered CSS variable on <body> must equal the value that was set,
    // not merely be non-empty.
    await expect
      .poll(() =>
        page.evaluate(() => document.body.style.getPropertyValue("--accent").trim().toLowerCase()),
      )
      .toBe("#ff5500");
  });

  test("accent color persists across settings tab navigation", async ({ page }) => {
    const hexInput = page.locator(".accent-hex-row input.form-input");
    await expect(hexInput).toBeVisible();

    await hexInput.fill("ff5500");
    await expect
      .poll(() =>
        page.evaluate(() => document.body.style.getPropertyValue("--accent").trim().toLowerCase()),
      )
      .toBe("#ff5500");

    const stored = await page.evaluate(() => localStorage.getItem("owncord:settings:accentColor"));
    expect(stored).toContain("ff5500");

    // Navigate away from Appearance and back; the rendered accent must survive.
    await switchSettingsTab(page, "Account");
    await switchSettingsTab(page, "Appearance");

    await expect
      .poll(() =>
        page.evaluate(() => document.body.style.getPropertyValue("--accent").trim().toLowerCase()),
      )
      .toBe("#ff5500");
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
