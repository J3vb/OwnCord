/**
 * The composer's "+" menu: a tile grid above the chat bar on desktop (Upload,
 * Poll, Sticker) and a bottom sheet on a phone (Take photo, Gallery, Files,
 * Poll). GIF and the mic stay in the bar; on a phone the mic and send take
 * turns so the text keeps its room.
 */
import { devices, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { buildTauriMockScript, navigateToMainPageReady, BASE_SESSION_ROUTES } from "./helpers";
import { Q1, findUnnamedControls, focusIndicator, textContrast } from "./support/accessibility";

async function start(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [...BASE_SESSION_ROUTES, { pattern: "/api/v1/stickers", status: 200, body: [] }],
      simulateWsFlow: true,
      readyOverrides: {
        capabilities: { stickers: true, polls: true, voice_messages: true },
      },
    }),
  );
  await page.goto("/");
  await navigateToMainPageReady(page);
}

test.describe("desktop", () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test("+ opens Upload, Poll and Sticker; GIF and the mic stay in the bar", async ({ page }) => {
    const row = page.locator(".message-input-box");
    for (const shown of [".gif-btn", ".emoji-btn", ".mic-btn", ".send-btn"]) {
      await expect(row.locator(shown)).toBeVisible();
    }
    for (const hidden of [".sticker-btn", ".poll-btn"]) {
      await expect(row.locator(hidden)).toBeHidden();
    }
    await page.locator(".attach-btn").click();
    const menu = page.locator(".attach-menu");
    await expect(menu.locator(".attach-sheet-tile")).toHaveText(["Upload", "Poll", "Sticker"]);
    await expect(menu.locator("[data-testid='attach-sheet-files']")).toBeFocused();

    const chooser = page.waitForEvent("filechooser");
    await menu.locator("[data-testid='attach-sheet-files']").click();
    expect((await chooser).isMultiple()).toBe(true);
    await expect(menu).toHaveCount(0);
  });

  test("arrow keys move between tiles, and Escape hands focus back to +", async ({ page }) => {
    await page.locator(".attach-btn").click();
    const menu = page.locator(".attach-menu");
    await page.keyboard.press("ArrowRight");
    await expect(menu.locator("[data-testid='attach-sheet-poll']")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator("[data-testid='attach-sheet-poll']")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator("[data-testid='attach-sheet-sticker']")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".attach-btn")).toBeFocused();
  });

  test("a second click on + closes the menu", async ({ page }) => {
    await page.locator(".attach-btn").click();
    await expect(page.locator(".attach-menu")).toBeVisible();
    await page.locator(".attach-btn").click();
    await expect(page.locator(".attach-menu")).toHaveCount(0);
  });

  test("the open menu meets the shared accessibility checks", async ({ page }) => {
    await page.locator(".attach-btn").focus();
    await page.keyboard.press("Enter");
    const menu = page.locator(".attach-menu");
    await expect(menu.locator(".attach-sheet-tile")).toHaveCount(3);
    expect(await findUnnamedControls(menu)).toEqual([]);
    await page.keyboard.press("ArrowRight");
    const ring = await focusIndicator(page);
    expect(ring.problems).toEqual([]);
    expect(ring.ratio).toBeGreaterThanOrEqual(Q1.focus);
    for (const label of await menu.locator(".attach-sheet-tile > span:last-child").all()) {
      expect((await textContrast(label)).ratio).toBeGreaterThanOrEqual(Q1.text);
    }
  });
});

const { defaultBrowserType: _pixelBrowser, ...pixel7 } = devices["Pixel 7"];

test.describe("phone", () => {
  test.use(pixel7);

  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test("the mic shows while there is nothing to send, and send once there is", async ({ page }) => {
    const row = page.locator(".message-input-box");
    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(row.locator(".gif-btn")).toBeVisible();
    await expect(row.locator(".mic-btn")).toBeVisible();
    await expect(row.locator(".send-btn")).toBeHidden();
    await textarea.fill("On my way");
    await expect(row.locator(".mic-btn")).toBeHidden();
    await expect(row.locator(".send-btn")).toBeVisible();
    await textarea.fill("");
    await expect(row.locator(".mic-btn")).toBeVisible();
  });

  test("a picked file with no text shows send instead of the mic", async ({ page }) => {
    const row = page.locator(".message-input-box");
    await page.locator("input[data-attach-source='files']").setInputFiles({
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(page.locator(".attachment-preview-bar")).toHaveClass(/\bvisible\b/);
    await expect(row.locator(".send-btn")).toBeVisible();
    await expect(row.locator(".mic-btn")).toBeHidden();
  });

  test("+ opens the sheet with the file sources and Poll, and it meets the shared checks", async ({
    page,
  }) => {
    await page.locator(".attach-btn").tap();
    const sheet = page.locator("[data-testid='attach-sheet']");
    await expect(sheet.locator(".attach-sheet-tile")).toHaveText([
      "Take photo",
      "Gallery",
      "Files",
      "Poll",
    ]);
    expect(await findUnnamedControls(sheet)).toEqual([]);
    for (const label of await sheet.locator(".attach-sheet-tile > span:last-child").all()) {
      expect((await textContrast(label)).ratio).toBeGreaterThanOrEqual(Q1.text);
    }
  });
});
