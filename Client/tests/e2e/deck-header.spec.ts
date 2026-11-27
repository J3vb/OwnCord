/**
 * Command Deck's panel top (opt-H2): a strip of buttons labelled "Server tree",
 * and under it the server as the tree's first row. Classic keeps its header.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { emitWsEvent, startFullSession } from "./helpers";
import { undersizedTargets } from "./support/a11yHarness";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";
const DESKTOP = { width: 1333, height: 934 } as const;

async function startDeck(page: Page): Promise<void> {
  await page.addInitScript(
    ([dev, layout]) => {
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify("deck"));
    },
    [DEV_KEY, LAYOUT_KEY] as const,
  );
  await page.setViewportSize(DESKTOP);
  await startFullSession(page);
  await expect(page.locator("html")).toHaveClass(/layout-deck/);
}

const strip = (page: Page) => page.locator(".server-tree-strip");
const root = (page: Page) => page.locator(".server-root");

test.describe("Command Deck panel top", () => {
  test("a labelled strip sits over the root row, about 51 px together", async ({ page }) => {
    await startDeck(page);
    await expect(strip(page).locator(".server-tree-strip-label")).toHaveText("Server tree");
    await expect(strip(page).locator(".server-tree-strip-label")).toHaveCSS(
      "text-transform",
      "uppercase",
    );
    const stripBox = (await strip(page).boundingBox())!;
    const rootBox = (await root(page).boundingBox())!;
    expect(stripBox.height).toBeGreaterThanOrEqual(25);
    expect(rootBox.height).toBeGreaterThanOrEqual(26);
    expect(rootBox.y).toBeGreaterThanOrEqual(stripBox.y + stripBox.height - 0.5);
    expect(Math.abs(stripBox.height + rootBox.height - 51)).toBeLessThanOrEqual(3);
  });

  test("the strip holds the menu, invite, Audit Log and moderation buttons in that order", async ({
    page,
  }) => {
    await startDeck(page);
    const ids = await strip(page)
      .locator("button")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(ids).toEqual(["server-menu-btn", "invite-btn", "audit-log-btn", "moderation-btn"]);
    await expect(page.getByTestId("server-menu-btn")).toHaveAccessibleName("Server menu");
  });

  test("every strip button has a 24x24 px hit area", async ({ page }) => {
    await startDeck(page);
    const buttons = strip(page).locator("button");
    expect(await buttons.count()).toBe(4);
    expect(
      await undersizedTargets(buttons, { label: (t) => t.getAttribute("data-testid") }),
    ).toEqual([]);
  });

  test("the root row shows the status dot, the name and the online count", async ({ page }) => {
    await startDeck(page);
    const name = root(page).locator("h2#server-tree-name");
    await expect(name).toBeVisible();
    await expect(name).toHaveText(await page.getByTestId("deck-top-name").innerText());
    await expect(name).toHaveCSS("font-weight", "700");
    await expect(root(page).locator(".server-online")).toHaveText(/^\d+ online$/);
    await expect(root(page).locator(".deck-led")).toHaveAttribute("aria-hidden", "true");
    // The count sits at the row's right edge, the dot at its left.
    const rowBox = (await root(page).boundingBox())!;
    const dotBox = (await root(page).locator(".deck-led").boundingBox())!;
    const countBox = (await root(page).locator(".server-online").boundingBox())!;
    expect(dotBox.x).toBeLessThan(rowBox.x + 24);
    expect(countBox.x + countBox.width).toBeGreaterThan(rowBox.x + rowBox.width - 12);
  });

  test("the dot follows the connection: connected, reconnecting, offline, connected again", async ({
    page,
  }) => {
    await startDeck(page);
    const dot = root(page).locator("[data-testid='server-root-led']");
    const topDot = page.locator(".deck-top-bar .deck-led");
    await expect(dot).toHaveAttribute("data-state", "connected");
    await emitWsEvent(page, "ws-state", "closed");
    await expect(dot).toHaveAttribute("data-state", "reconnecting");
    await expect(topDot).toHaveAttribute("data-state", "reconnecting");
    await page.context().setOffline(true);
    await expect(dot).toHaveAttribute("data-state", "offline");
    await expect(topDot).toHaveAttribute("data-state", "offline");
    await page.context().setOffline(false);
    await emitWsEvent(page, "ws-state", "open");
    await expect(dot).toHaveAttribute("data-state", "connected");
    await expect(topDot).toHaveAttribute("data-state", "connected");
  });

  test("Classic keeps its own header", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await startFullSession(page);
    await expect(page.locator("html")).not.toHaveClass(/layout-deck/);
    await expect(page.locator(".deck-server-header")).toHaveCount(0);
    await expect(page.locator(".server-tree-strip")).toHaveCount(0);
    await expect(page.locator("button.server-name[data-testid='server-name']")).toBeVisible();
    await expect(page.getByTestId("server-menu-btn")).toHaveCount(0);
  });
});
