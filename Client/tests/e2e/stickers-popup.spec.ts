/**
 * WP 8.8: the tabbed expression popup and sticker sending.
 *
 * The journey: open the popup from the sticker button, move between its tabs by
 * keyboard, pick a sticker (one `chat_send` with `sticker_id`), and leave with
 * Escape, which hands focus back to the button. The shared B9 accessibility
 * checks run on the open popup. Drives the real app through the mocked Tauri
 * transport, with the `stickers` capability and the sticker routes stubbed.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { buildTauriMockScript, MOCK_LOGIN_RESPONSE, navigateToMainPageReady } from "./helpers";
import { Q1, findUnnamedControls, focusIndicator } from "./support/b9-accessibility";

/** A 1x1 transparent PNG, as the sticker image bytes. */
const PNG_1X1 = [
  ...Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
];

const STICKERS = [
  { id: 1, name: "Wave", emoji: "👋", url: "/api/v1/stickers/1/image" },
  { id: 2, name: "Party Blob", emoji: null, url: "/api/v1/stickers/2/image" },
];

interface SentFrame {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

/** The client's own outgoing WS frames, as recorded by the Tauri mock's IPC log. */
async function sentFrames(page: Page): Promise<SentFrame[]> {
  return page.evaluate(() => {
    const log = (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { message?: string } }> }
    ).__invokeLog;
    const frames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    for (const entry of log) {
      if (entry.cmd !== "ws_send") continue;
      try {
        frames.push(JSON.parse(entry.args?.message ?? "{}"));
      } catch {
        // Not a client WS message.
      }
    }
    return frames;
  });
}

async function start(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        ...STICKERS.map((s) => ({
          pattern: s.url,
          status: 200,
          body: null,
          bodyBytes: PNG_1X1,
          contentType: "image/png",
        })),
        { pattern: "/api/v1/stickers", status: 200, body: STICKERS },
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
      ],
      simulateWsFlow: true,
      readyOverrides: { capabilities: { stickers: true, message_deduplication: true } },
    }),
  );
  await page.goto("/");
  await navigateToMainPageReady(page);
}

test.describe("WP 8.8 stickers and the expression popup", () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test("the sticker button opens the popup on Stickers; the tabs follow the keyboard", async ({
    page,
  }) => {
    const button = page.locator("[data-testid='sticker-btn']");
    await button.click();

    const popup = page.locator("[data-testid='expression-popup']");
    await expect(popup).toBeVisible();
    await expect(popup.locator("[role='tab'][aria-selected='true']")).toHaveText("Stickers");
    await expect(popup.locator(".sp-item")).toHaveCount(2);

    // The tablist is a proper one: arrows move and select, the tab keeps focus.
    const stickersTab = page.locator("[data-testid='xp-tab-sticker']");
    await stickersTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-testid='xp-tab-emoji']")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(popup.locator(".emoji-picker")).toBeVisible();
    await expect(page.locator("[data-testid='xp-tab-emoji']")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("[data-testid='xp-tab-gif']")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("[data-testid='xp-tab-emoji']")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("the emoji tab's category rail sits beside the grid and follows the scroll", async ({
    page,
  }) => {
    await page.locator("[data-testid='sticker-btn']").click();
    await page.locator("[data-testid='xp-tab-emoji']").click();
    const popup = page.locator("[data-testid='expression-popup']");
    const rail = popup.locator(".ep-categories");
    const food = rail.locator(".ep-category-btn[aria-label='Food']");
    await expect(food).toBeVisible();

    const fit = await popup.evaluate((el) => {
      const rail = el.querySelector(".ep-categories")!.getBoundingClientRect();
      const grid = el.querySelector(".ep-scroll")!.getBoundingClientRect();
      const header = el.querySelector(".ep-header")!.getBoundingClientRect();
      const buttons = [...el.querySelectorAll(".ep-category-btn")].map((b) =>
        b.getBoundingClientRect(),
      );
      return {
        railLeftOfGrid: rail.right <= grid.left + 0.5,
        railBelowHeader: rail.top >= header.bottom - 0.5,
        sameHeight: Math.abs(rail.height - grid.height) < 1,
        buttonsInsideRail: buttons.every((b) => b.left >= rail.left && b.right <= rail.right),
      };
    });
    expect(fit).toEqual({
      railLeftOfGrid: true,
      railBelowHeader: true,
      sameHeight: true,
      buttonsInsideRail: true,
    });

    await expect(rail.locator(".ep-category-btn").first()).toHaveClass(/\bactive\b/);
    await food.click();
    await expect(food).toHaveClass(/\bactive\b/);
    await expect(rail.locator(".ep-category-btn.active")).toHaveCount(1);
  });

  test("the open popup meets the shared accessibility checks", async ({ page }) => {
    await page.locator("[data-testid='sticker-btn']").click();
    const popup = page.locator("[data-testid='expression-popup']");
    await expect(popup.locator(".sp-item")).toHaveCount(2);

    expect(await findUnnamedControls(popup)).toEqual([]);

    // A keystroke first, so the browser treats the focus as keyboard focus.
    await page.keyboard.press("Shift");
    await page.locator("[data-testid='xp-tab-sticker']").focus();
    const tabIndicator = await focusIndicator(page);
    expect(tabIndicator.problems).toEqual([]);
    expect(tabIndicator.width).toBeGreaterThanOrEqual(2);
    expect(tabIndicator.ratio).toBeGreaterThanOrEqual(Q1.focus);

    await popup.locator(".sp-item").first().focus();
    expect((await focusIndicator(page)).problems).toEqual([]);
  });

  test("picking a sticker sends one chat_send with its id and closes the popup", async ({
    page,
  }) => {
    await page.locator("[data-testid='sticker-btn']").click();
    await page.locator(".sp-item[data-sticker-id='2']").click();

    await expect(page.locator("[data-testid='expression-popup']")).toHaveCount(0);
    const sends = (await sentFrames(page)).filter((f) => f.type === "chat_send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toMatchObject({
      channel_id: 1,
      content: "",
      sticker_id: 2,
      reply_to: null,
    });
    expect(typeof sends[0]!.payload!["client_message_id"]).toBe("string");
  });

  test("Escape closes the popup and returns focus to the sticker button", async ({ page }) => {
    const button = page.locator("[data-testid='sticker-btn']");
    await button.click();
    await expect(page.locator("[data-testid='expression-popup']")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='expression-popup']")).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("clicking the active tab's button again closes the popup", async ({ page }) => {
    const button = page.locator("[data-testid='sticker-btn']");
    await button.click();
    await expect(page.locator("[data-testid='expression-popup']")).toBeVisible();
    await button.click();
    await expect(page.locator("[data-testid='expression-popup']")).toHaveCount(0);
  });
});
