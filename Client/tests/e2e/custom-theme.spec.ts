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
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  keyboardReachable,
  textContrast,
} from "./support/b9-accessibility";

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

  test("the editor and the list pass the shared accessibility checks", async ({ page }) => {
    const section = page.locator(".custom-themes");
    await page.getByRole("button", { name: "New theme" }).click();
    expect(await findUnnamedControls(section)).toEqual([]);
    const cssBox = page.getByTestId("custom-theme-css");
    expect(await keyboardReachable(page, cssBox)).toBe(true);
    expect((await focusIndicator(page)).problems).toEqual([]);

    // Saving without a name shows the error line.
    await page.getByTestId("custom-theme-save").click();
    const error = page.getByTestId("custom-theme-error");
    await expect(error).toBeVisible();
    expect((await textContrast(error)).ratio).toBeGreaterThanOrEqual(Q1.text);

    await page.getByTestId("custom-theme-name").fill("Plum");
    await page.getByTestId("custom-theme-save").click();
    const use = page.getByRole("button", { name: "Use Plum" });
    expect(await findUnnamedControls(section)).toEqual([]);
    expect(await keyboardReachable(page, use)).toBe(true);
    expect((await focusIndicator(page)).problems).toEqual([]);
    expect((await textContrast(page.locator(".custom-theme-name"))).ratio).toBeGreaterThanOrEqual(
      Q1.text,
    );
  });

  test("a saved accent is re-checked against the surfaces a theme paints", async ({ page }) => {
    // A near-white accent reads as text on the dark built-in surfaces...
    await page.evaluate(() =>
      localStorage.setItem("owncord:settings:accentColor", JSON.stringify("#eeeeee")),
    );
    await page.reload();
    await navigateToMainPageReady(page);
    const accentText = (): Promise<string> =>
      page.evaluate(() => document.body.style.getPropertyValue("--accent-text"));
    expect(await accentText()).not.toBe("");

    // ...and must stop being used as text once a theme paints white surfaces.
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByTestId("custom-theme-name").fill("Paper");
    await page
      .getByTestId("custom-theme-css")
      .fill(
        ":root { --bg-primary: #ffffff; --bg-secondary: #ffffff; --bg-tertiary: #ffffff; --bg-input: #ffffff; }",
      );
    await page.getByTestId("custom-theme-save").click();
    await page.getByRole("button", { name: "Use Paper" }).click();
    await expect.poll(accentText).toBe("");
  });
});
