/**
 * Command Deck's server tabs: the row under the top bar's first row, its folder
 * dropdowns and "+N" menu, the fold into the Servers button at most 640 px wide
 * or 499 px tall, and where focus goes after a dialog opened from the row.
 *
 * Two fixtures, both with the current host saved: "few" (four loose servers)
 * and "many" (fourteen servers, three of them in an unnamed folder stored at
 * index 7, so twelve top-level items). The width check's tab counts are
 * estimates, so the cases assert relations and only the counts a fixture forces.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  BASE_SESSION_ROUTES,
  buildTauriMockScript,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import { contrastMatrix, horizontalOverflow, undersizedTargets } from "./support/a11yHarness";
import { setAppearance } from "./support/accessibility";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";
const RAIL_LAYOUT_KEY = "owncord:server-rail-layout";
const CURRENT = "localhost:8443";

interface Size {
  readonly width: number;
  readonly height: number;
}
const DESKTOP: Size = { width: 1333, height: 934 };
const MIN_WINDOW: Size = { width: 940, height: 500 };
const NARROW: Size = { width: 780, height: 600 };
const ZOOMED: Size = { width: 640, height: 400 };

interface Fixture {
  readonly servers: ReadonlyArray<readonly [name: string, host: string]>;
  readonly layout: unknown[] | null;
}

const FEW: Fixture = {
  servers: [
    ["Hangar 9", CURRENT],
    ["Night Owls", "night.example:8443"],
    ["Pixel Forge", "pixel.example:8443"],
    ["Retro LAN", "retro.example:8443"],
  ],
  layout: null,
};

const hostOf = (n: number): string => `s${String(n).padStart(2, "0")}.example:8443`;
const FOLDER_ID = "f-many";
const FOLDER_HOSTS = [3, 4, 5].map(hostOf);
const MANY: Fixture = {
  servers: [
    ["Hangar 9", CURRENT],
    ...Array.from({ length: 13 }, (_, i) => {
      const n = i + 2;
      return [`Server ${String(n).padStart(2, "0")}`, hostOf(n)] as const;
    }),
  ],
  layout: [
    { kind: "server", host: CURRENT },
    { kind: "server", host: hostOf(2) },
    ...[6, 7, 8, 9, 10].map((n) => ({ kind: "server", host: hostOf(n) })),
    {
      kind: "folder",
      id: FOLDER_ID,
      name: "",
      color: "#3ba55d",
      collapsed: false,
      hosts: FOLDER_HOSTS,
    },
    ...[11, 12, 13, 14].map((n) => ({ kind: "server", host: hostOf(n) })),
  ],
};
const MANY_ITEMS = 12;

function profiles(fixture: Fixture) {
  return {
    schemaVersion: 1,
    profiles: fixture.servers.map(([name, host]) => ({
      id: host,
      name,
      host,
      username: "testuser",
      autoConnect: false,
      rememberPassword: false,
      color: "#5865f2",
      lastConnected: null,
    })),
  };
}

/** Developer mode, Deck and the stored layout, once: a reload must not put them back. */
async function seed(page: Page, fixture: Fixture): Promise<void> {
  await page.addInitScript(
    ([dev, layout, railKey, rail]) => {
      if (sessionStorage.getItem("deck-tabs-seeded") !== null) return;
      sessionStorage.setItem("deck-tabs-seeded", "1");
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify("deck"));
      if (rail !== null) localStorage.setItem(railKey, rail);
    },
    [
      DEV_KEY,
      LAYOUT_KEY,
      RAIL_LAYOUT_KEY,
      fixture.layout === null ? null : JSON.stringify(fixture.layout),
    ] as const,
  );
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: BASE_SESSION_ROUTES,
      simulateWsFlow: true,
      storedSettings: { "owncord:profiles": profiles(fixture) },
    }),
  );
}

async function boot(page: Page, fixture: Fixture, size: Size): Promise<void> {
  await page.setViewportSize(size);
  await seed(page, fixture);
  await page.goto("/");
  await navigateToMainPageReady(page);
  await expect(page.locator("html")).toHaveClass(/layout-deck/);
  await expect(page.locator(".deck-top-bar.has-server-tabs")).toHaveCount(1);
}

// --- Locators -----------------------------------------------------------------

const nav = (page: Page) => page.getByTestId("server-tabs");
const cells = (page: Page) =>
  page.locator(".server-tabs-track > .server-tab:not(.server-tabs-more)");
const visibleCells = (page: Page) => cells(page).filter({ visible: true });
const serverTab = (page: Page, host: string) =>
  page.locator(`[data-testid='server-tab'][data-host='${host}']`);
const currentTab = (page: Page) => page.locator("[data-testid='server-tab'][aria-current='page']");
const folderTab = (page: Page) => page.getByTestId("server-tab-folder");
const more = (page: Page) => page.getByTestId("server-tabs-more");
const addBtn = (page: Page) => page.getByTestId("server-tabs-add");
const direct = (page: Page) => page.getByTestId("deck-direct");
const serversBtn = (page: Page) => page.getByTestId("deck-servers-btn");
const openMenu = (page: Page) => page.locator(".server-tabs-menu");
const switchDialog = (page: Page) => page.getByTestId("server-switch-dialog");

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  return box;
}

async function boxOfLocator(target: Locator): Promise<Box> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The "+N" count, 0 while it is hidden. */
async function moreCount(page: Page): Promise<number> {
  if (!(await more(page).isVisible())) return 0;
  const text = (await more(page).textContent()) ?? "";
  return Number(text.replace(/\D/g, ""));
}

/** Nothing shown in the row overlaps `target`. */
async function expectNothingOver(page: Page, target: Locator): Promise<void> {
  const box = await boxOfLocator(target);
  for (const cell of await page
    .locator(".server-tabs-track > .server-tab")
    .filter({ visible: true })
    .all()) {
    expect(overlaps(await boxOfLocator(cell), box)).toBe(false);
  }
}

/** Visible tabs plus "+N" account for every item; the current tab shows; nothing overflows or overlaps. */
async function expectRowAccountsForAll(page: Page): Promise<number> {
  await expect(currentTab(page)).toBeVisible();
  const shown = await visibleCells(page).count();
  expect(shown + (await moreCount(page))).toBe(MANY_ITEMS);
  expect(await horizontalOverflow(nav(page))).toBe(0);
  await expectNothingOver(page, direct(page));
  await expectNothingOver(page, addBtn(page));
  return shown;
}

/** The data-host or data-folder-id of an element. */
const keyOf = (el: Locator): Promise<string | null> =>
  el.evaluate(
    (n) => (n as HTMLElement).dataset["host"] ?? (n as HTMLElement).dataset["folderId"] ?? null,
  );

// --- The row ------------------------------------------------------------------

test.describe("Command Deck server tabs", () => {
  test("the rail is gone and the current tab is marked", async ({ page }) => {
    await boot(page, FEW, DESKTOP);
    await expect(page.getByTestId("server-rail")).toHaveCount(0);
    await expect(page.locator(".server-rail-slot")).toHaveCount(0);
    await expect(currentTab(page)).toBeVisible();
    await expect(currentTab(page)).toHaveAttribute("data-host", CURRENT);
    await expect(page.getByTestId("disconnect-btn")).toBeHidden();
  });

  test("with few servers at 1333x934 every tab shows and +N is hidden", async ({ page }) => {
    await boot(page, FEW, DESKTOP);
    await expect(visibleCells(page)).toHaveCount(4);
    await expect(more(page)).toBeHidden();
  });

  for (const size of [DESKTOP, MIN_WINDOW, NARROW]) {
    test(`with many servers the visible tabs and the +N count add up to the items, the current tab is visible and the row does not overflow at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await boot(page, MANY, size);
      await expectRowAccountsForAll(page);
    });
  }

  test("with many servers at 940x500 +N is visible", async ({ page }) => {
    await boot(page, MANY, MIN_WINDOW);
    await expect(more(page)).toBeVisible();
    expect(await moreCount(page)).toBeGreaterThan(0);
  });

  test("a live text-size change with many servers refits the row", async ({ page }) => {
    await boot(page, MANY, DESKTOP);
    const before = await expectRowAccountsForAll(page);
    await openSettings(page);
    await switchSettingsTab(page, "Accessibility");
    await page.getByRole("switch", { name: "Large font" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-overlay")).not.toHaveClass(/open/);
    await expect
      .poll(async () => (await visibleCells(page).count()) + (await moreCount(page)))
      .toBe(MANY_ITEMS);
    const after = await expectRowAccountsForAll(page);
    expect(after).toBeLessThanOrEqual(before);
  });

  test("the top bar's first row is unchanged", async ({ page }) => {
    await boot(page, FEW, DESKTOP);
    const [n, s, c, bar] = await Promise.all([
      boxOf(page, "deck-top-name"),
      boxOf(page, "deck-search"),
      boxOf(page, "deck-connection"),
      boxOf(page, "deck-top-bar"),
    ]);
    expect(n.x + n.width).toBeLessThanOrEqual(s.x + 0.5);
    expect(s.x + s.width).toBeLessThanOrEqual(c.x + 0.5);
    expect(Math.abs(s.x + s.width / 2 - DESKTOP.width / 2)).toBeLessThanOrEqual(1);
    const row = await boxOf(page, "server-tabs");
    expect(n.y + n.height).toBeLessThanOrEqual(row.y + 0.5);
    expect(bar.height).toBeGreaterThanOrEqual(68 - 0.5);
  });

  test("the Direct button stays 26 px and is not undersized", async ({ page }) => {
    await boot(page, FEW, DESKTOP);
    for (const size of [DESKTOP, ZOOMED]) {
      await page.setViewportSize(size);
      const box = await boxOf(page, "deck-direct");
      expect([box.width, box.height]).toEqual([26, 26]);
      expect(await undersizedTargets(direct(page))).toEqual([]);
    }
  });
});

// --- Folders and +N -------------------------------------------------------------

test.describe("Command Deck server tabs: folders and +N", () => {
  test("the folder dropdown lists its servers and a choice asks to switch", async ({ page }) => {
    await boot(page, MANY, DESKTOP);
    await expect(folderTab(page)).toBeVisible();
    await expect(folderTab(page).locator(".server-tab-name")).toHaveText("Folder");
    await folderTab(page).click();
    const items = openMenu(page).getByTestId("server-tab-folder-item");
    await expect(items).toHaveCount(3);
    await items.nth(1).click();
    await expect(switchDialog(page)).toBeVisible();
  });

  test("a folder member's menu moves it and removes it from the folder", async ({ page }) => {
    await boot(page, MANY, DESKTOP);
    const member = (host: string) =>
      openMenu(page).locator(`[data-testid='server-tab-folder-item'][data-host='${host}']`);
    await folderTab(page).click();
    await member(hostOf(3)).click({ button: "right" });
    await openMenu(page).getByTestId("rail-move-down").click();
    await folderTab(page).click();
    const order = await openMenu(page)
      .getByTestId("server-tab-folder-item")
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset["host"]));
    expect(order).toEqual([hostOf(4), hostOf(3), hostOf(5)]);
    await member(hostOf(3)).click({ button: "right" });
    await openMenu(page).getByTestId("rail-remove-from-folder").click();
    await expect(serverTab(page, hostOf(3))).toHaveCount(1);
    await expect(folderTab(page)).toBeVisible();
    await expect(folderTab(page).locator(".server-tab-count")).toHaveText("2");
  });

  test("the +N menu lists the hidden servers in order and Move to start brings one back", async ({
    page,
  }) => {
    await boot(page, MANY, MIN_WINDOW);
    const hidden: string[] = [];
    for (const cell of await cells(page).all()) {
      if (!(await cell.isVisible())) hidden.push((await keyOf(cell)) ?? "");
    }
    expect(hidden.length).toBeGreaterThan(0);
    await more(page).click();
    const rows = openMenu(page).locator(
      "[data-testid='server-tab-menu-server'], [data-testid='server-tab-menu-folder']",
    );
    const listed: string[] = [];
    for (const r of await rows.all()) listed.push((await keyOf(r)) ?? "");
    expect(listed).toEqual(hidden);

    const last = openMenu(page).getByTestId("server-tab-menu-server").last();
    const host = await keyOf(last);
    await last.click({ button: "right" });
    await openMenu(page).getByTestId("rail-move-to-start").click();
    await expect(cells(page).first()).toHaveAttribute("data-host", host ?? "");
    await expect(serverTab(page, host ?? "")).toBeVisible();
  });

  test("a folder behind +N is a heading with its servers, and choosing one asks to switch", async ({
    page,
  }) => {
    await boot(page, MANY, NARROW);
    await expect(folderTab(page)).toBeHidden();
    await more(page).click();
    const heading = openMenu(page).getByTestId("server-tab-menu-folder");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText("Folder");
    const group = openMenu(page).locator("[role='group']");
    await expect(group.getByTestId("server-tab-folder-item")).toHaveCount(3);
    const first = await boxOfLocator(group.getByTestId("server-tab-folder-item").first());
    const head = await boxOfLocator(heading);
    expect(first.y).toBeGreaterThanOrEqual(head.y + head.height - 0.5);
    await group.getByTestId("server-tab-folder-item").first().click();
    await expect(switchDialog(page)).toBeVisible();
  });
});

// --- Drag ---------------------------------------------------------------------

/** Every top-level item's key in the row's DOM order, hidden ones included. */
const rowOrder = (page: Page): Promise<string[]> =>
  cells(page).evaluateAll((els) =>
    els.map(
      (n) => (n as HTMLElement).dataset["host"] ?? (n as HTMLElement).dataset["folderId"] ?? "",
    ),
  );

/** The stored layout's top-level keys. */
const storedOrder = (page: Page): Promise<string[]> =>
  page.evaluate((key) => {
    const items = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
      kind: string;
      host?: string;
      id?: string;
    }>;
    return items.map((i) => (i.kind === "server" ? (i.host ?? "") : (i.id ?? "")));
  }, RAIL_LAYOUT_KEY);

/**
 * Drags `from` with the mouse and drops it at `fx` of `to`'s width. Chromium
 * runs its own HTML drag session from these moves, as the user's mouse would.
 */
async function dragTo(page: Page, from: Locator, to: Locator, fx: number): Promise<void> {
  const a = await boxOfLocator(from);
  const b = await boxOfLocator(to);
  const y0 = a.y + a.height / 2;
  const y1 = b.y + b.height / 2;
  await page.mouse.move(a.x + a.width / 2, y0);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 5, y0, { steps: 2 });
  await page.mouse.move(b.x + b.width * fx, y1, { steps: 12 });
  await page.mouse.move(b.x + b.width * fx + 0.5, y1);
  await page.mouse.up();
}

const NIGHT = "night.example:8443";
const PIXEL = "pixel.example:8443";
const RETRO = "retro.example:8443";

test.describe("Command Deck server tabs: drag", () => {
  test("a tab dropped on the left part of another tab moves before it", async ({ page }) => {
    await boot(page, FEW, DESKTOP);
    await dragTo(page, serverTab(page, RETRO), serverTab(page, NIGHT), 0.1);
    await expect.poll(() => rowOrder(page)).toEqual([CURRENT, RETRO, NIGHT, PIXEL]);
    expect(await storedOrder(page)).toEqual([CURRENT, RETRO, NIGHT, PIXEL]);
    await expect(folderTab(page)).toHaveCount(0);
  });

  test("a tab dropped on the right part of another tab moves after it", async ({ page }) => {
    await boot(page, FEW, DESKTOP);
    await dragTo(page, serverTab(page, NIGHT), serverTab(page, PIXEL), 0.9);
    await expect.poll(() => rowOrder(page)).toEqual([CURRENT, PIXEL, NIGHT, RETRO]);
    expect(await storedOrder(page)).toEqual([CURRENT, PIXEL, NIGHT, RETRO]);
    await expect(folderTab(page)).toHaveCount(0);
  });

  test("a tab dropped on the middle of a server tab makes a folder of the two", async ({
    page,
  }) => {
    await boot(page, FEW, DESKTOP);
    await dragTo(page, serverTab(page, NIGHT), serverTab(page, PIXEL), 0.5);
    await expect(folderTab(page)).toHaveCount(1);
    await expect(folderTab(page).locator(".server-tab-count")).toHaveText("2");
    await expect(serverTab(page, NIGHT)).toHaveCount(0);
    await expect(serverTab(page, PIXEL)).toHaveCount(0);
    await folderTab(page).click();
    const members = await openMenu(page)
      .getByTestId("server-tab-folder-item")
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset["host"]));
    expect(members).toEqual([PIXEL, NIGHT]);
  });

  test("a tab dropped on a folder tab joins the folder", async ({ page }) => {
    await boot(page, MANY, DESKTOP);
    await expect(folderTab(page)).toBeVisible();
    await dragTo(page, serverTab(page, hostOf(2)), folderTab(page), 0.5);
    await expect(folderTab(page).locator(".server-tab-count")).toHaveText("4");
    await expect(serverTab(page, hostOf(2))).toHaveCount(0);
    expect(await storedOrder(page)).toHaveLength(MANY_ITEMS - 1);
  });

  test("a tab dropped on +N moves to the end of the row", async ({ page }) => {
    await boot(page, MANY, MIN_WINDOW);
    await expect(more(page)).toBeVisible();
    await expect(serverTab(page, hostOf(2))).toBeVisible();
    await dragTo(page, serverTab(page, hostOf(2)), more(page), 0.5);
    await expect.poll(async () => (await rowOrder(page)).at(-1)).toBe(hostOf(2));
    expect((await storedOrder(page)).at(-1)).toBe(hostOf(2));
    await expect(serverTab(page, hostOf(2))).toBeHidden();
    await expectRowAccountsForAll(page);
  });
});

// --- The fold -------------------------------------------------------------------

test.describe("Command Deck server tabs: the fold", () => {
  test("at 640x400 the row is merged into the Servers button and the bars use at most 82 px", async ({
    page,
  }) => {
    await boot(page, MANY, ZOOMED);
    await expect(nav(page)).toBeHidden();
    await expect(serversBtn(page)).toBeVisible();
    const top = await boxOf(page, "deck-top-bar");
    const status = await boxOf(page, "deck-status-bar");
    expect(top.height + status.height).toBeLessThanOrEqual(82.5);
    await expect(page.getByTestId("disconnect-btn")).toBeVisible();
  });

  test("at 640x400 the Servers button is named Servers and the server", async ({ page }) => {
    await boot(page, FEW, ZOOMED);
    await expect(serversBtn(page)).toHaveAccessibleName("Servers, Hangar 9");
    await expect(serversBtn(page).locator(".deck-servers-text")).toBeHidden();
  });

  test("at 640x499 the row is folded", async ({ page }) => {
    await boot(page, FEW, { width: 640, height: 499 });
    await expect(nav(page)).toBeHidden();
    await expect(serversBtn(page)).toBeVisible();
  });

  test("at 900x499 the row is folded by height alone", async ({ page }) => {
    await boot(page, FEW, { width: 900, height: 499 });
    await expect(nav(page)).toBeHidden();
    await expect(serversBtn(page)).toBeVisible();
    await expect(serversBtn(page).locator(".deck-servers-text")).toBeVisible();
  });

  test("at 641x500 the row shows and the top bar is 68 px", async ({ page }) => {
    await boot(page, FEW, { width: 641, height: 500 });
    await expect(nav(page)).toBeVisible();
    await expect(serversBtn(page)).toBeHidden();
    const top = await boxOf(page, "deck-top-bar");
    expect(Math.abs(top.height - 68)).toBeLessThanOrEqual(0.5);
  });

  test("the Servers menu lists every item, then Add and Join", async ({ page }) => {
    await boot(page, MANY, ZOOMED);
    await serversBtn(page).click();
    const menu = openMenu(page);
    await expect(menu).toHaveAccessibleName("Servers");
    const keys = await menu.evaluate((m) =>
      Array.from(m.children, (c) => {
        const el = c as HTMLElement;
        return (
          el.dataset["host"] ??
          el.dataset["folderId"] ??
          el.dataset["testid"] ??
          el.getAttribute("role")
        );
      }),
    );
    const expected = (MANY.layout as Array<{ host?: string; id?: string }>).flatMap((item) =>
      item.host !== undefined ? [item.host] : [item.id ?? "", "group"],
    );
    expect(keys).toEqual([...expected, "separator", "server-tabs-add-server", "server-tabs-join"]);
  });

  test("at 640x400 a folder member is chosen from the Servers menu and the switch question opens", async ({
    page,
  }) => {
    await boot(page, MANY, ZOOMED);
    await serversBtn(page).focus();
    await page.keyboard.press("Enter");
    await expect(openMenu(page)).toBeVisible();
    const target = openMenu(page).locator(
      `[data-testid='server-tab-folder-item'][data-host='${hostOf(4)}']`,
    );
    // Walk down to the member with the keyboard; the menu scrolls it into view.
    for (let i = 0; i < 20; i++) {
      if (await target.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(switchDialog(page)).toBeVisible();
  });

  test("at 640x400 a Servers menu row's context menu moves it down", async ({ page }) => {
    await boot(page, MANY, ZOOMED);
    await serversBtn(page).click();
    const row = openMenu(page).locator(
      `[data-testid='server-tab-menu-server'][data-host='${hostOf(2)}']`,
    );
    await row.click({ button: "right" });
    await openMenu(page).getByTestId("rail-move-down").click();
    await serversBtn(page).click();
    const servers = await openMenu(page)
      .getByTestId("server-tab-menu-server")
      .evaluateAll((rows) => rows.slice(0, 3).map((r) => (r as HTMLElement).dataset["host"]));
    expect(servers).toEqual([CURRENT, hostOf(6), hostOf(2)]);
  });
});

// --- Text, names and focus -------------------------------------------------------

test.describe("Command Deck server tabs: names and focus", () => {
  test("a server named with markup is drawn as text", async ({ page }) => {
    const name = "<img src=x onerror=1>";
    const host = hostOf(7);
    const fixture: Fixture = {
      ...MANY,
      servers: MANY.servers.map(([n, h]) => (h === host ? [name, h] : [n, h])),
    };
    await boot(page, fixture, MIN_WINDOW);
    const tab = serverTab(page, host);
    await expect(tab).toHaveAccessibleName(name);
    await expect(tab.locator(".server-tab-name")).toHaveText(name);
    await expect(page.locator("img[src='x']")).toHaveCount(0);
    // In +N when hidden, else in the dropdown after moving it into the folder.
    if (!(await tab.isVisible())) {
      await more(page).click();
      await expect(openMenu(page).locator(`[data-host='${host}']`)).toHaveAccessibleName(name);
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize(DESKTOP);
    await expect(tab).toBeVisible();
    await tab.click({ button: "right" });
    await openMenu(page).getByTestId("rail-move-to-folder-0").click();
    await folderTab(page).click();
    const row = openMenu(page).locator(`[data-host='${host}']`);
    await expect(row).toHaveAccessibleName(name);
    await expect(row).toContainText(name);
    await expect(page.locator("img[src='x']")).toHaveCount(0);
  });

  test("a folder renamed from its tab by keyboard returns focus to the new folder tab", async ({
    page,
  }) => {
    await boot(page, MANY, DESKTOP);
    await folderTab(page).focus();
    await page.keyboard.press("Shift+F10");
    await expect(openMenu(page)).toBeVisible();
    await openMenu(page).getByTestId("rail-rename-folder").focus();
    await page.keyboard.press("Enter");
    const input = page.getByTestId("server-rail-rename-input");
    await expect(input).toBeFocused();
    await input.fill("Crew");
    await page.keyboard.press("Enter");
    await expect(folderTab(page).locator(".server-tab-name")).toHaveText("Crew");
    await expect(folderTab(page)).toBeFocused();
  });

  test("the switch question opened from a folder dropdown and cancelled after a render returns focus to the folder tab", async ({
    page,
  }) => {
    await boot(page, MANY, DESKTOP);
    await folderTab(page).click();
    await openMenu(page).getByTestId("server-tab-folder-item").first().click();
    await expect(switchDialog(page)).toBeVisible();
    const old = await folderTab(page).elementHandle();
    await page.evaluate(() => window.dispatchEvent(new Event("owncord:server-icon-changed")));
    expect(await old?.evaluate((el) => el.isConnected)).toBe(false);
    await page.getByTestId("server-switch-cancel").click();
    await expect(folderTab(page)).toBeFocused();
  });

  test("the switch question cancelled after a render returns focus to the row", async ({
    page,
  }) => {
    await boot(page, FEW, DESKTOP);
    const host = "night.example:8443";
    await serverTab(page, host).click();
    await expect(switchDialog(page)).toBeVisible();
    const old = await serverTab(page, host).elementHandle();
    await page.evaluate(() => window.dispatchEvent(new Event("owncord:server-icon-changed")));
    expect(await old?.evaluate((el) => el.isConnected)).toBe(false);
    await page.getByTestId("server-switch-cancel").click();
    await expect(serverTab(page, host)).toBeFocused();
  });
});

// --- Accessibility --------------------------------------------------------------

test.describe("Command Deck server tabs: accessibility", () => {
  test("no tab, +N, +, Servers or Direct control is undersized", async ({ page }) => {
    await boot(page, MANY, MIN_WINDOW);
    const targets = page.locator(
      ".server-tabs-track > .server-tab, [data-testid='server-tabs-add'], [data-testid='deck-servers-btn'], [data-testid='deck-direct']",
    );
    const label = (t: Locator) => t.getAttribute("aria-label");
    expect(await undersizedTargets(targets, { skipHidden: true, label })).toEqual([]);
    await page.setViewportSize(ZOOMED);
    await expect(serversBtn(page)).toBeVisible();
    expect(await undersizedTargets(targets, { skipHidden: true, label })).toEqual([]);
  });

  test("High Contrast keeps the current tab's top line and adds a bottom inset", async ({
    page,
  }) => {
    await boot(page, FEW, DESKTOP);
    await setAppearance(page, { highContrast: true });
    await navigateToMainPageReady(page);
    await expect(currentTab(page)).toBeVisible();
    const shadow = await currentTab(page).evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).toContain("inset");
    // Four insets: the 2 px top line, both sides and the 1 px bottom line.
    expect(shadow.split("inset").length - 1).toBe(4);
    expect(shadow).toMatch(/0px 2px 0px 0px inset/);
    expect(shadow).toMatch(/0px -1px 0px 0px inset/);
  });

  for (const c of contrastMatrix({
    title: "the current and an inactive tab's text",
    attachName: (theme, hc) => `deck-tabs-contrast-${theme}-hc-${hc}.json`,
    boot: async (page, prefs) => {
      await page.setViewportSize(DESKTOP);
      await seed(page, FEW);
      await page.goto("/");
      await setAppearance(page, prefs);
      await navigateToMainPageReady(page);
      await expect(currentTab(page)).toBeVisible();
    },
    scenario: async (page, { measure }) => {
      await measure("current tab", currentTab(page).locator(".server-tab-name"));
      await measure(
        "inactive tab",
        serverTab(page, "night.example:8443").locator(".server-tab-name"),
      );
    },
  })) {
    test(c.title, c.run);
  }
});
