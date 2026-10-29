/**
 * Mocked E2E: custom CSS themes in Appearance. The unit suite runs in jsdom,
 * so this is where a real browser proves a theme's tokens win over the
 * built-in theme's inline tokens, survive a restart, and that a theme naming
 * an outside file is refused.
 */

import { test, expect } from "./fixtures";
import {
  mockTauriFullSession,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";

const THEME_CSS =
  ":root { --bg-tertiary: #4a1030; }\n.settings-pane h3 { letter-spacing: 0.04em; }";

async function bgTertiary(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue("--bg-tertiary").trim(),
  );
}

test.describe("Custom themes", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
  });

  test("a saved theme paints over the built-in theme and survives a reload", async ({ page }) => {
    const before = await bgTertiary(page);
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByTestId("custom-theme-name").fill("Plum");
    await page.getByTestId("custom-theme-css").fill(THEME_CSS);
    await page.getByTestId("custom-theme-save").click();
    await expect(page.getByTestId("custom-theme-css")).toBeHidden();
    await page.getByRole("button", { name: "Use Plum" }).click();

    await expect(page.getByTestId("custom-theme-row")).toContainText("In use");
    await expect.poll(() => bgTertiary(page)).toBe("#4a1030");
    expect(before).not.toBe("#4a1030");

    await page.reload();
    await navigateToMainPageReady(page);
    await expect.poll(() => bgTertiary(page)).toBe("#4a1030");

    await page.keyboard.press("Control+Shift+Backspace");
    await expect.poll(() => bgTertiary(page)).toBe(before);
  });

  test("a theme that names an outside file is refused", async ({ page }) => {
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByTestId("custom-theme-name").fill("Remote");
    await page
      .getByTestId("custom-theme-css")
      .fill("body { background: u\\72l(https://example.com/x.png); }");
    await page.getByTestId("custom-theme-save").click();
    await expect(page.getByTestId("custom-theme-error")).toHaveText(
      "Line 1 uses url(. Themes cannot load outside files.",
    );
    await expect(page.getByTestId("custom-theme-row")).toHaveCount(0);
  });
});
