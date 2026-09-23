import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  mockTauriFullSessionWithMessages,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import { findUnnamedControls } from "./support/b9-accessibility";

// ---------------------------------------------------------------------------
// B9-3: catalog text in English and through the expansion-only test catalog.
//
// Expansion switches the running app's own text seam: this page imports the
// dev server's /src/i18n/format.ts, the same module instance the app renders
// through. A production bundle has no such module to reach, so that run skips
// the expanded cases instead of the app shipping a switch. B9-18/19/20 add
// their journeys here.
// ---------------------------------------------------------------------------

const ENGLISH = [
  ["Reduce Motion", "Disable animations and transitions"],
  ["High Contrast", "Increase contrast for better readability"],
  ["Role Colors", "Show colored usernames based on role in chat"],
  ["Sync with OS", "Automatically enable reduced motion based on your OS accessibility settings"],
  ["Large Font", "Use larger text throughout the app for better readability"],
] as const;

async function expandCatalogText(page: Page): Promise<boolean> {
  return page.evaluate(async (url) => {
    try {
      const seam = await import(/* @vite-ignore */ url);
      seam.setTextTransformForTesting(seam.expandText);
      return true;
    } catch {
      return false;
    }
  }, "/src/i18n/format.ts");
}

async function openAccessibility(page: Page, expanded: boolean): Promise<void> {
  // Q1's largest text: 20 px with Large Font, applied by the real startup path.
  await page.addInitScript(() => {
    localStorage.setItem("owncord:settings:fontSize", "20");
    localStorage.setItem("owncord:settings:largeFont", "true");
  });
  await mockTauriFullSessionWithMessages(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
  if (expanded) test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");
  await openSettings(page);
  await switchSettingsTab(page, "Accessibility");
}

const pane = (page: Page) => page.locator("[data-testid='settings-overlay'] .settings-pane.active");

test.describe("B9-3 Accessibility tab text", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("reads the catalog's English copy and names each switch with it", async ({ page }) => {
    await openAccessibility(page, false);
    const rows = pane(page).locator(".setting-row");
    await expect(rows).toHaveCount(ENGLISH.length);
    for (const [i, [label, desc]] of ENGLISH.entries()) {
      const row = rows.nth(i);
      await expect(row.locator(".setting-label")).toHaveText(label);
      await expect(row.locator(".setting-desc")).toHaveText(desc);
      await expect(row.getByRole("switch", { name: label, exact: true })).toBeVisible();
    }
  });

  test("keeps expanded text whole, named and operable at the minimum window with 20px text", async ({
    page,
  }, testInfo) => {
    await openAccessibility(page, true);
    const root = pane(page);
    const rows = root.locator(".setting-row");
    await expect(rows).toHaveCount(ENGLISH.length);
    expect(await findUnnamedControls(root)).toEqual([]);

    for (const [i, [label, desc]] of ENGLISH.entries()) {
      const row = rows.nth(i);
      await row.scrollIntoViewIfNeeded();
      for (const [el, english] of [
        [row.locator(".setting-label"), label],
        [row.locator(".setting-desc"), desc],
      ] as const) {
        await expect(el).toHaveText(new RegExp(`^⟦${english} .+⟧$`));
        await expect(el).toBeInViewport();
        expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
      }
      const toggle = row.getByRole("switch");
      await expect(toggle).toHaveAccessibleName(new RegExp(`^⟦${label} .+⟧$`));
      await expect(toggle).toBeInViewport();
    }

    // Still operable from the keyboard with the longer names.
    const toggle = rows.nth(1).getByRole("switch");
    const before = await toggle.getAttribute("aria-checked");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toHaveAttribute("aria-checked", before ?? "");

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("accessibility-tab-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
