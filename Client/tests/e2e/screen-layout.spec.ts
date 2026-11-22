/**
 * Mocked E2E: the Screen layout setting (Command Deck preview, Phase 1).
 *
 * The setting only moves the `layout-deck` class on <html> at load; no CSS
 * reads it yet. A pick in Settings applies on the next reload.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openSettings, startFullSession, switchSettingsTab } from "./helpers";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";
const NOTE = "Applies the next time OwnCord starts or reloads.";

async function seedDeveloperMode(page: Page): Promise<void> {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify(true)), DEV_KEY);
}

/** Seeds Command Deck once: a reload must not put "deck" back. */
async function seedDeckOnce(page: Page): Promise<void> {
  await page.addInitScript(
    ([dev, layout]) => {
      if (sessionStorage.getItem("screen-layout-seeded") !== null) return;
      sessionStorage.setItem("screen-layout-seeded", "1");
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify("deck"));
    },
    [DEV_KEY, LAYOUT_KEY] as const,
  );
}

const hasDeckClass = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("layout-deck"));

const storedLayout = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown, LAYOUT_KEY);

test.describe("Screen layout", () => {
  test("runs Command Deck at load when it is stored and Developer mode is on", async ({ page }) => {
    await page.addInitScript(
      ([dev, layout]) => {
        localStorage.setItem(dev, JSON.stringify(true));
        localStorage.setItem(layout, JSON.stringify("deck"));
      },
      [DEV_KEY, LAYOUT_KEY] as const,
    );
    await startFullSession(page);
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
  });

  test("Classic to Command Deck applies after a reload", async ({ page }) => {
    await seedDeveloperMode(page);
    await startFullSession(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");

    const note = page.getByText(NOTE);
    await expect(note).toBeHidden();
    await page.locator("[data-testid='screen-layout-deck']").click();

    await expect(note).toBeVisible();
    expect(await hasDeckClass(page)).toBe(false);
    expect(await storedLayout(page)).toBe("deck");

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await expect(page.locator("[data-testid='screen-layout-deck']")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(note).toBeHidden();
  });

  test("Command Deck to Classic applies after a reload", async ({ page }) => {
    await seedDeckOnce(page);
    await startFullSession(page);
    expect(await hasDeckClass(page)).toBe(true);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");

    await page.locator("[data-testid='screen-layout-classic']").click();
    await expect(page.getByText(NOTE)).toBeVisible();
    expect(await hasDeckClass(page)).toBe(true);
    expect(await storedLayout(page)).toBe("classic");

    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/layout-deck/);
    expect(await storedLayout(page)).toBe("classic");
  });
});
