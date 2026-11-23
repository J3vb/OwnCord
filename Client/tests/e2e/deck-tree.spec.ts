/**
 * Command Deck's server tree (look A): rows are 24 px targets that stay
 * reachable as the tree scrolls, the focus ring is not clipped by its scroll
 * box, the active row keeps its bar and tint under High Contrast with a dark
 * custom accent, and the arrow keys walk it like a file tree.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { contrastMatrix, expectReachable, undersizedTargets } from "./support/a11yHarness";
import { focusIndicator, type AppearancePrefs } from "./support/accessibility";
import { arrangeScene, startDeckScene } from "./support/deckTreeScene";

const tree = (page: Page) => page.locator(".server-tree");
const items = (page: Page) => tree(page).locator("[role=treeitem]");
const strip = (page: Page) => page.locator(".server-tree-strip");
const root = (page: Page) => page.locator(".server-root");

/** The element's bounds grown by its outline, against the tree's padding box. */
async function ringInsideTree(page: Page, target: Locator): Promise<void> {
  const fit = await target.evaluate((el) => {
    const cs = getComputedStyle(el);
    const o = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    const box = el.getBoundingClientRect();
    const scroller = el.closest(".server-tree")!;
    const s = scroller.getBoundingClientRect();
    const left = s.left + scroller.clientLeft;
    const top = s.top + scroller.clientTop;
    return {
      grown: o,
      leftGap: box.left - o - left,
      topGap: box.top - o - top,
      rightGap: left + scroller.clientWidth - (box.right + o),
      bottomGap: top + scroller.clientHeight - (box.bottom + o),
    };
  });
  expect(fit.leftGap).toBeGreaterThanOrEqual(-0.5);
  expect(fit.topGap).toBeGreaterThanOrEqual(-0.5);
  expect(fit.rightGap).toBeGreaterThanOrEqual(-0.5);
  expect(fit.bottomGap).toBeGreaterThanOrEqual(-0.5);
}

test.describe("Command Deck server tree", () => {
  test("every row and header is at least a 24 px target", async ({ page }) => {
    await startDeckScene(page);
    await arrangeScene(page);
    expect(
      await undersizedTargets(items(page), {
        skipHidden: true,
        label: (t) => t.getAttribute("data-testid"),
      }),
    ).toEqual([]);
  });

  test("the arrow keys walk the tree like a file tree", async ({ page }) => {
    await startDeckScene(page);
    await arrangeScene(page);
    await expect(items(page).first()).toHaveAttribute("aria-level", "1");
    await page.getByTestId("channel-3").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("channel-4")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".category[data-category='General']")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".category[data-category='General']")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.locator(".category[data-category='General']")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".category[data-category='General']")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.keyboard.press("End");
    await expect(items(page).last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press("a");
    await expect(page.getByTestId("channel-1")).toBeFocused();
  });

  test("the tree is named by the server row's heading", async ({ page }) => {
    await startDeckScene(page);
    await expect(tree(page)).toHaveAttribute("aria-labelledby", "server-tree-name");
    await expect(tree(page)).toHaveAccessibleName(await root(page).locator("h2").innerText());
  });

  test("docked minimum: the tree scrolls, the strip and root row stay, every row is reachable", async ({
    page,
  }) => {
    await startDeckScene(page, { viewport: { width: 940, height: 500 }, fillers: 12 });
    await arrangeScene(page);
    expect(await tree(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expectReachable(items(page), { skipHidden: true });
    await expect(strip(page)).toBeInViewport();
    await expect(root(page)).toBeInViewport();
    await items(page).last().scrollIntoViewIfNeeded();
    await expect(items(page).last()).toBeInViewport();
  });

  test("drawer: the tree scrolls under the strip and the last row scrolls into view", async ({
    page,
  }) => {
    await startDeckScene(page, { viewport: { width: 780, height: 500 }, fillers: 12 });
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("unified-sidebar")).toBeVisible();
    expect(await tree(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(strip(page)).toBeInViewport();
    await expect(root(page)).toBeInViewport();
    await items(page).last().scrollIntoViewIfNeeded();
    await expect(items(page).last()).toBeInViewport();
    await expect(strip(page)).toBeInViewport();
  });

  test("the focus ring is not clipped on a header or a voice user", async ({ page }, testInfo) => {
    await startDeckScene(page);
    await arrangeScene(page);
    // A key press first, so a programmatic focus shows the keyboard ring.
    await page.keyboard.press("Shift");
    const measured: Record<string, number> = {};
    for (const [name, target] of [
      ["header", page.locator(".category[data-category='Information']")],
      ["voice user", page.locator(".voice-user-item").first()],
    ] as const) {
      await target.focus();
      await expect(target).toBeFocused();
      const ring = await focusIndicator(page);
      // Recorded, not asserted: it is measured over the parents' backgrounds, not the row's tint.
      measured[`${name} ratio`] = Number(ring.ratio.toFixed(2));
      expect(ring.style).not.toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(2);
      await ringInsideTree(page, target);
    }
    await testInfo.attach("tree-focus-ring.json", {
      body: JSON.stringify(measured, null, 2),
      contentType: "application/json",
    });
  });

  test("High Contrast with a dark custom accent: the bar is --accent-text, the tint --bg-active", async ({
    page,
  }) => {
    await startDeckScene(page, { highContrast: true, accent: "#202020", theme: "gunmetal" });
    const active = page.locator(".server-tree [role=treeitem][aria-current='page']").first();
    await expect(active).toBeVisible();
    const probe = await page.evaluate(() => {
      const el = document.createElement("span");
      document.body.appendChild(el);
      const read = (prop: "color" | "backgroundColor", token: string): string => {
        el.style[prop] = `var(${token})`;
        return getComputedStyle(el)[prop];
      };
      const out = {
        accentText: read("color", "--accent-text"),
        bgActive: read("backgroundColor", "--bg-active"),
      };
      el.remove();
      return out;
    });
    const look = await active.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { shadow: cs.boxShadow, image: cs.backgroundImage };
    });
    expect(look.shadow).toContain(probe.accentText);
    expect(look.image).toContain(probe.bgActive);
    // Not the accent mix: no srgb colour() from color-mix in the tint.
    expect(look.image).not.toContain("color(srgb");
  });
});

test.describe("Command Deck server tree: contrast", () => {
  for (const c of contrastMatrix({
    title: "active and unread rows",
    attachName: (theme, hc) => `deck-tree-contrast-${theme}-hc-${hc}.json`,
    boot: async (page: Page, prefs: AppearancePrefs) => {
      await startDeckScene(page, {
        ...(prefs.theme === undefined ? {} : { theme: prefs.theme }),
        ...(prefs.highContrast === true ? { highContrast: true } : {}),
      });
    },
    scenario: async (page, { measure }) => {
      await measure("active row", page.getByTestId("channel-3").locator(".ch-name"));
      await measure("unread row", page.getByTestId("channel-4").locator(".ch-name"));
    },
  })) {
    test(c.title, c.run);
  }
});
