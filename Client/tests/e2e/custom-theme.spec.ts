/**
 * Mocked E2E: custom CSS themes in Appearance. The unit suite runs in jsdom,
 * so this is where a real browser proves a theme's tokens win over the
 * built-in theme's inline tokens, survive a restart, and that a theme naming
 * an outside file is refused.
 */

import { test, expect } from "./fixtures";
import {
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
  startFullSession,
} from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  keyboardReachable,
  textContrast,
} from "./support/accessibility";

const THEME_CSS =
  ":root { --bg-tertiary: #4a1030; }\n.settings-pane h3 { letter-spacing: 0.04em; }";

async function bgTertiary(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue("--bg-tertiary").trim(),
  );
}

test.describe("Custom themes", () => {
  test.beforeEach(async ({ page }) => {
    await startFullSession(page, { ready: true });
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

  test("a theme can be deleted from the list", async ({ page }) => {
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByTestId("custom-theme-name").fill("Plum");
    await page.getByTestId("custom-theme-css").fill(THEME_CSS);
    await page.getByTestId("custom-theme-save").click();
    await page.getByRole("button", { name: "Use Plum" }).click();
    await expect.poll(() => bgTertiary(page)).toBe("#4a1030");

    await page.getByRole("button", { name: "Delete Plum" }).click();
    await page.getByTestId("custom-theme-delete-confirm").click();
    await expect(page.getByTestId("custom-theme-row")).toHaveCount(0);
    await expect(page.getByTestId("custom-theme-delete-dialog")).toHaveCount(0);
    await expect.poll(() => bgTertiary(page)).not.toBe("#4a1030");
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

  test("a background picture is re-encoded, painted behind the chat and survives a reload", async ({
    page,
  }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 3200;
      canvas.height = 1800;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      const grad = ctx.createLinearGradient(0, 0, 3200, 1800);
      grad.addColorStop(0, "#1d2b64");
      grad.addColorStop(1, "#f8cdda");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 3200, 1800);
      return canvas.toDataURL("image/png").split(",")[1] ?? "";
    });
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByTestId("custom-theme-name").fill("Dusk");
    await page.getByTestId("custom-theme-bg-file").setInputFiles({
      name: "dusk.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect(page.getByTestId("custom-theme-bg-preview")).toBeVisible();
    await page.getByRole("slider", { name: "Blur" }).fill("6");
    await page.getByTestId("custom-theme-save").click();
    await page.getByRole("button", { name: "Use Dusk" }).click();

    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("owncord:theme:custom:bg:"));
      return key === undefined
        ? null
        : (JSON.parse(localStorage.getItem(key) ?? "null") as {
            image: string;
            blur: number;
          });
    });
    expect(stored?.image).toMatch(/^data:image\/webp;base64,/);
    expect(stored?.blur).toBe(6);

    const chatBackground = (): Promise<string> =>
      page.evaluate(() => {
        const chat = document.querySelector(".chat-area");
        return chat === null ? "" : getComputedStyle(chat).backgroundImage;
      });
    await page.reload();
    await navigateToMainPageReady(page);
    await expect.poll(chatBackground).toContain("data:image/webp");

    await page.keyboard.press("Control+Shift+Backspace");
    await expect.poll(chatBackground).not.toContain("data:image");
  });
});
