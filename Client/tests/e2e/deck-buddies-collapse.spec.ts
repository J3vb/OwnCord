/**
 * Command Deck's Buddies groups fold: every header is a button that folds or
 * opens its group on click, Enter or Space, all groups start open, and the
 * folded set is kept on this device. During a search every header is plain
 * text and every match shows.
 *
 * Each test starts in a fresh browser context, so storage starts empty; the
 * reload case reloads within one test.
 *
 * Screenshots for the hand check: buddies-collapse-focused.png (OFFLINE
 * folded with its header focused) and buddies-collapse-search.png (the same
 * list during a search).
 */
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";
import { navigateToMainPageReady } from "./helpers";
import { contrastMeter, findUnnamedControls, keyboardReachable } from "./support/accessibility";
import { startDeckScene } from "./support/deckTreeScene";

/** Four online members in ONLINE, one AWAY, one DO NOT DISTURB, two OFFLINE. */
const ROSTER = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  { id: 2, username: "Rin", avatar: "", status: "online", role: "member" },
  { id: 3, username: "Marco", avatar: "", status: "online", role: "member" },
  { id: 4, username: "Juno", avatar: "", status: "online", role: "member" },
  { id: 5, username: "Pim", avatar: "", status: "idle", role: "member" },
  { id: 6, username: "Rook", avatar: "", status: "dnd", role: "member" },
  { id: 7, username: "Tobs", avatar: "", status: "offline", role: "member" },
  { id: 8, username: "Wes", avatar: "", status: "offline", role: "member" },
];

const column = (page: Page): Locator => page.locator("#member-column");
const groups = (page: Page): Locator => column(page).locator(".buddies-group");
const offline = (page: Page): Locator => column(page).getByTestId("buddies-group-offline");
const search = (page: Page): Locator => column(page).getByTestId("member-search");

async function bootBuddies(page: Page, fontSize?: number): Promise<void> {
  if (fontSize !== undefined) {
    await page.addInitScript((size) => {
      localStorage.setItem("owncord:settings:fontSize", JSON.stringify(size));
    }, fontSize);
  }
  await startDeckScene(page, { theme: "gunmetal", members: ROSTER });
  await expect(groups(page).first()).toBeVisible();
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("Command Deck Buddies: folding groups", () => {
  test("every group starts open, as a focusable button", async ({ page }) => {
    await bootBuddies(page);
    await expect(groups(page)).toHaveText([
      "ONLINE — 4",
      "AWAY — 1",
      "DO NOT DISTURB — 1",
      "OFFLINE — 2",
    ]);
    for (const header of await groups(page).all()) {
      await expect(header).toHaveAttribute("role", "button");
      await expect(header).toHaveAttribute("tabindex", "0");
      await expect(header).toHaveAttribute("aria-expanded", "true");
    }
    await expect(column(page).locator(".buddy-row")).toHaveCount(8);
  });

  test("a fold survives a reload, and Enter opens it again", async ({ page }) => {
    await bootBuddies(page);
    await offline(page).click();
    await expect(offline(page)).toHaveAttribute("aria-expanded", "false");
    await expect(offline(page)).toHaveText("OFFLINE — 2");
    await expect(column(page).getByTestId("member-7")).toHaveCount(0);

    await page.reload();
    await navigateToMainPageReady(page);
    await expect(offline(page)).toHaveAttribute("aria-expanded", "false");
    await expect(column(page).getByTestId("member-7")).toHaveCount(0);
    await expect(column(page).getByTestId("member-2")).toBeVisible();

    await offline(page).focus();
    await page.keyboard.press("Enter");
    await expect(offline(page)).toHaveAttribute("aria-expanded", "true");
    await expect(column(page).getByTestId("member-7")).toBeVisible();
    await expect(offline(page)).toBeFocused();
  });

  test("a search finds a member in a folded group, and its header is plain then", async ({
    page,
  }, testInfo) => {
    await bootBuddies(page);
    await offline(page).click();
    await expect(column(page).getByTestId("member-8")).toHaveCount(0);

    await search(page).fill("wes");
    await expect(column(page).getByTestId("member-8")).toBeVisible();
    await expect(groups(page)).toHaveText(["OFFLINE — 1"]);
    await expect(offline(page)).not.toHaveAttribute("aria-expanded");
    await expect(offline(page)).not.toHaveAttribute("tabindex");
    await expect(offline(page).locator(".buddies-group-chevron")).toHaveCount(0);
    await shot(page, testInfo, "buddies-collapse-search.png");

    await search(page).fill("");
    await expect(offline(page)).toHaveAttribute("aria-expanded", "false");
    await expect(column(page).getByTestId("member-8")).toHaveCount(0);
  });

  for (const fontSize of [12, 16, 20]) {
    test(`at ${fontSize} px text every header is at least 24 px tall`, async ({ page }) => {
      await bootBuddies(page, fontSize);
      await offline(page).click();
      const heights = await groups(page).evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().height),
      );
      expect(heights).toHaveLength(4);
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(24);
    });
  }

  test("a focused header shows the focus ring, and every header is named", async ({
    page,
  }, testInfo) => {
    await bootBuddies(page);
    expect(await keyboardReachable(page, offline(page))).toBe(true);
    await page.keyboard.press("Space");
    await expect(offline(page)).toHaveAttribute("aria-expanded", "false");
    await expect(offline(page)).toBeFocused();
    // The arrows walk rows only: on a header they are left to the browser.
    await page.keyboard.press("ArrowUp");
    await expect(offline(page)).toBeFocused();
    const meter = contrastMeter(page);
    await meter.ring("OFFLINE header");
    await testInfo.attach("buddies-collapse-ring.json", {
      body: JSON.stringify(meter.measured, null, 2),
      contentType: "application/json",
    });
    expect(meter.failures).toEqual([]);
    expect(await findUnnamedControls(column(page))).toEqual([]);
    await shot(page, testInfo, "buddies-collapse-focused.png");
  });
});
