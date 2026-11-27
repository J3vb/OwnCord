/**
 * The drawers on phone Command Deck: the tree drawer from the left with 44 px
 * rows, the Buddies drawer from the right between the bars, and the order in
 * which Back closes them in the Android app.
 *
 * The Pixel 7 profile runs the Android app (the Tauri mock and an Android user
 * agent); the iPhone SE profile is a phone browser. Both run on Chromium.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { navigateToMainPage } from "./helpers";
import { findUnnamedControls } from "./support/accessibility";
import { attachScreenshot, expectControlFits } from "./support/a11yHarness";
import {
  IPHONE_SE,
  PIXEL_7,
  dragCases,
  holdFinger,
  startPhoneDeck,
  type PhoneProfile,
} from "./support/phone";
import {
  PHONE_DM as DM,
  boxOf,
  dmCallScene,
  enterCall,
  openTree,
  statusBar,
  swipeBuddiesOpen,
} from "./support/phoneCall";

const TREE = "[data-testid='unified-sidebar']";
const ROWS =
  ".server-tree-strip .sidebar-header-action, .server-tree .category, .server-tree .channel-item, .server-tree-direct-head, .server-tree-direct .dm-nav-row";

const tree = (page: Page): Locator => page.locator(TREE);
const column = (page: Page): Locator => page.locator("#member-column");
const buddiesButton = (page: Page): Locator => page.getByTestId("member-list-toggle");
const heading = (page: Page): Locator => column(page).locator(".buddies-title-text");

const DM_SCENE = dmCallScene();

const pressBack = (page: Page): Promise<void> => page.evaluate(() => history.back());

/** The Buddies drawer sits between the bars, at its phone width. */
async function expectBetweenTheBars(page: Page): Promise<void> {
  const box = await boxOf(column(page));
  const top = await boxOf(page.locator(".deck-top-bar"));
  const bottom = await boxOf(statusBar(page));
  const width = page.viewportSize()!.width;
  expect(box.y).toBeGreaterThanOrEqual(top.y + top.height - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(bottom.y + 0.5);
  expect(Math.round(box.width)).toBe(Math.round(Math.min(320, width * 0.88)));
  expect(Math.round(box.x + box.width)).toBe(width);
}

for (const profile of [PIXEL_7, IPHONE_SE] as readonly PhoneProfile[]) {
  test.describe(`phone Command Deck drawers, ${profile.name}`, () => {
    test.use(profile.use);

    test("the tree drawer: 44 px rows, server row first, Direct last, a channel closes it", async ({
      page,
    }, testInfo) => {
      await startPhoneDeck(page, { theme: "gunmetal" });
      await openTree(page);
      const rows = tree(page).locator(ROWS);
      expect(await rows.count()).toBeGreaterThan(8);
      for (const row of await rows.all()) await expectControlFits(row, 44);
      const order = await tree(page).evaluate((root) => {
        const server = root.querySelector(".server-root")!;
        const first = root.querySelector(".server-tree [role='treeitem']")!;
        const items = root.querySelectorAll("[role='treeitem'], .dm-nav-row");
        const last = items[items.length - 1]!;
        return {
          serverFirst: (server.compareDocumentPosition(first) & 4) !== 0,
          directLast: last.closest(".server-tree-direct") !== null,
        };
      });
      expect(order).toEqual({ serverFirst: true, directLast: true });
      expect(await findUnnamedControls(tree(page))).toEqual([]);
      await attachScreenshot(testInfo, "tree drawer", page);

      await page.getByTestId("channel-2").tap();
      await expect(tree(page)).not.toHaveClass(/drawer-open/);
    });

    test("the Buddies drawer opens by button with focus on its heading, and by swipe without a focus move", async ({
      page,
    }, testInfo) => {
      await startPhoneDeck(page, { theme: "gunmetal" });
      await buddiesButton(page).tap();
      await expect(column(page)).toBeVisible();
      await expect(heading(page)).toBeFocused();
      await expect(heading(page)).toHaveAttribute("tabindex", "-1");
      await expect(buddiesButton(page)).toHaveAttribute("aria-pressed", "true");
      await expectBetweenTheBars(page);
      expect(await findUnnamedControls(column(page))).toEqual([]);
      for (const header of await column(page).locator(".buddies-group[role='button']").all())
        await expectControlFits(header, 44);
      await attachScreenshot(testInfo, "Buddies drawer", page);
      await page.keyboard.press("Escape");
      await expect(column(page)).toBeHidden();
      await expect(buddiesButton(page)).toBeFocused();
      // From the keyboard too, Enter on the button lands on the heading.
      await page.keyboard.press("Enter");
      await expect(heading(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(buddiesButton(page)).toBeFocused();

      await swipeBuddiesOpen(page);
      await expect(column(page)).toBeVisible();
      await expect(buddiesButton(page)).toHaveAttribute("aria-pressed", "true");
      await expect(buddiesButton(page)).toBeFocused();
    });

    test("folded Buddies groups stay folded after a reload", async ({ page }) => {
      await startPhoneDeck(page, { seedOnce: true });
      await buddiesButton(page).tap();
      const group = column(page).locator(".buddies-group[role='button']").first();
      await group.tap();
      await expect(group).toHaveAttribute("aria-expanded", "false");
      const id = await group.getAttribute("data-testid");

      await page.reload();
      await navigateToMainPage(page);
      await expect(page.locator("html")).toHaveClass(/layout-deck/);
      await buddiesButton(page).tap();
      await expect(column(page).getByTestId(id!)).toHaveAttribute("aria-expanded", "false");
    });

    test("in a voice room Info shows under Buddies", async ({ page }) => {
      await startPhoneDeck(page, { voice: true });
      await enterCall(page);
      await buddiesButton(page).tap();
      const info = page.getByTestId("room-info");
      await expect(info).toBeVisible();
      const body = await boxOf(column(page).locator(".member-column-body"));
      expect((await boxOf(info)).y).toBeGreaterThanOrEqual(body.y + body.height - 0.5);
      await expectBetweenTheBars(page);
    });

    test("the Buddies button is hidden in a DM", async ({ page }) => {
      await startPhoneDeck(page, { mock: DM_SCENE });
      await expect(buddiesButton(page)).toBeVisible();
      await openTree(page);
      await page.locator(`[data-testid=dm-entry][data-channel-id="${DM}"]`).tap();
      await expect(buddiesButton(page)).toBeHidden();
    });
  });
}

test.describe("phone Command Deck drawers, Back in the Android app", () => {
  test.use(PIXEL_7.use);

  test("tree drawer then a row sheet: the sheet closes, the drawer closes, then Back opens the drawer", async ({
    page,
  }) => {
    await startPhoneDeck(page);
    await openTree(page);
    await holdFinger(page, `${TREE} [data-testid='channel-2']`, 700);
    const sheet = page.getByTestId("channel-sheet");
    await expect(sheet).toBeVisible();

    await pressBack(page);
    await expect(sheet).toBeHidden();
    await expect(tree(page)).toHaveClass(/drawer-open/);
    await pressBack(page);
    await expect(tree(page)).not.toHaveClass(/drawer-open/);
    await pressBack(page);
    await expect(tree(page)).toHaveClass(/drawer-open/);
  });

  test("the Buddies drawer and a buddy menu close on one Back", async ({ page }) => {
    await startPhoneDeck(page);
    await buddiesButton(page).tap();
    await holdFinger(page, "#member-column .buddy-row", 700);
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();

    await pressBack(page);
    await expect(menu).toHaveCount(0);
    await expect(column(page)).toBeHidden();
    await expect(buddiesButton(page)).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("phone Command Deck drawers, the finger", () => {
  test.use(PIXEL_7.use);
  dragCases("deck", (page) => startPhoneDeck(page));
});
