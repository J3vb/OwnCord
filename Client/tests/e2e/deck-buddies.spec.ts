/**
 * Command Deck's Buddies column: members grouped by what they are doing, two
 * fixed lines a row, a voice icon for anyone in a server voice room, and the
 * column's reach and reflow at small windows. Games arrive as presence frames
 * after load, as they do from a server.
 *
 * Screenshots for the hand check: buddies-1333x934.png (all five groups and a
 * voice icon), buddies-1333x934-20px.png (the same at 20 px text) and
 * buddies-940x500.png (the column at 940x500).
 */
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";
import { emitWsMessage } from "./helpers";
import { expectReachable, undersizedTargets } from "./support/a11yHarness";
import { contrastMeter, findUnnamedControls, keyboardReachable } from "./support/accessibility";
import { startDeckScene, type SceneOptions } from "./support/deckTreeScene";
import { auditReflow, ZOOM_VIEWPORT, type ReflowAudit } from "./support/zoom-reflow";

/** Rin and Marco are in Lounge (the scene's voice states); Juno and Marco start
 *  games after load. */
const ROSTER = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  { id: 2, username: "Rin", avatar: "", status: "online", role: "member" },
  { id: 3, username: "Marco", avatar: "", status: "online", role: "member" },
  {
    id: 4,
    username: "Juno",
    avatar: "",
    status: "online",
    role: "member",
    custom_status: "Ranked grind",
  },
  {
    id: 5,
    username: "Pim",
    avatar: "",
    status: "idle",
    role: "member",
    custom_status: "Back after dinner",
  },
  { id: 6, username: "Rook", avatar: "", status: "dnd", role: "member" },
  { id: 7, username: "Tobs", avatar: "", status: "offline", role: "member" },
  { id: 8, username: "Wes", avatar: "", status: "offline", role: "member" },
];

/** 600 members: in a game, with a custom status, with a song, with nothing,
 *  offline; the scene puts members 2 and 3 in a room. */
function bigRoster(): unknown[] {
  return Array.from({ length: 600 }, (_, i) => {
    const id = i + 1;
    const kind = id % 5;
    return {
      id,
      username: `user${String(id).padStart(4, "0")}`,
      avatar: "",
      status: kind === 4 ? "offline" : kind === 3 ? "idle" : "online",
      role: id === 1 ? "admin" : "member",
      custom_status: kind === 1 ? `status ${id}` : null,
    };
  });
}

/**
 * The reflow audit of the column overlay at 640x400 on dev at d4ce80a4, the
 * same scene with Classic's member list under Deck, measured before Buddies
 * existed. dev was clean: every value is 0 or empty. Entries are compared by
 * count, since the audit labels them by class and text.
 */
const DEV_BASELINE: ReflowAudit = {
  pageOverflow: 0,
  clipped: [],
  covered: [],
  twoDimensional: [],
};

const column = (page: Page): Locator => page.locator("#member-column");
const groups = (page: Page): Locator => column(page).locator(".buddies-group");
const rows = (page: Page): Locator => column(page).locator(".buddy-row");

/** A presence frame that starts a game for `userId`. */
async function startGame(page: Page, userId: number, game: string): Promise<void> {
  await emitWsMessage(page, {
    type: "presence",
    payload: {
      user_id: userId,
      status: "online",
      activity: { name: game, started_at: Date.now() },
    },
  });
}

/** The scene with ROSTER, Juno and Marco in games, and the given text size. */
async function bootBuddies(page: Page, options: SceneOptions & { fontSize?: number } = {}) {
  if (options.fontSize !== undefined) {
    await page.addInitScript((size) => {
      localStorage.setItem("owncord:settings:fontSize", JSON.stringify(size));
    }, options.fontSize);
  }
  await startDeckScene(page, { theme: "gunmetal", members: ROSTER, ...options });
  // Below 900 px the column is an overlay, opened by the chat header's toggle.
  if (!(await column(page).isVisible())) await page.getByTestId("member-list-toggle").click();
  await expect(column(page)).toBeVisible();
  await expect(groups(page).first()).toBeVisible();
}

async function withGames(page: Page): Promise<void> {
  await startGame(page, 4, "Starfall Tactics");
  await startGame(page, 3, "Rift Runners");
  await expect(column(page).getByTestId("buddies-group-game")).toHaveText("IN GAME — 2");
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Every drawn row is directly below the one before it, with no overlap. */
async function expectContiguous(page: Page): Promise<void> {
  const tops = await column(page)
    .locator(".member-list > *")
    .evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect())
        .toSorted((a, b) => a.top - b.top)
        .map((r) => [r.top, r.bottom] as const),
    );
  expect(tops.length).toBeGreaterThan(1);
  for (let i = 1; i < tops.length; i++) {
    expect(tops[i]![0]).toBeGreaterThanOrEqual(tops[i - 1]![1] - 0.5);
    // Rows carry 1 px margins; headers sit flush.
    expect(tops[i]![0] - tops[i - 1]![1]).toBeLessThanOrEqual(2.5);
  }
}

test.describe("Command Deck Buddies", () => {
  test("groups by activity in order, and a presence frame moves a member into IN GAME", async ({
    page,
  }, testInfo) => {
    await bootBuddies(page);
    await expect(column(page).getByTestId("buddies-title")).toContainText("Buddies");
    await expect(column(page).getByTestId("buddies-count")).toHaveText("6/8");
    await expect(groups(page)).toHaveText([
      "ONLINE — 4",
      "AWAY — 1",
      "DO NOT DISTURB — 1",
      "OFFLINE — 2",
    ]);
    await expect(column(page).getByTestId("member-custom-status-4")).toHaveText("Ranked grind");

    await withGames(page);
    await expect(groups(page)).toHaveText([
      "IN GAME — 2",
      "ONLINE — 2",
      "AWAY — 1",
      "DO NOT DISTURB — 1",
      "OFFLINE — 2",
    ]);
    // The game wins line 2 over the custom status.
    await expect(column(page).getByTestId("member-activity-4")).toHaveText("Starfall Tactics");
    const voice = column(page).getByTestId("buddy-voice-2");
    await expect(voice).toBeVisible();
    await expect(voice).toHaveAttribute("title", "In Lounge");
    await expect(column(page).getByTestId("buddy-voice-4")).toBeHidden();
    await shot(page, testInfo, "buddies-1333x934.png");
  });

  test("the keyboard reaches a row, and Enter opens its profile", async ({ page }) => {
    await bootBuddies(page);
    const row = column(page).getByTestId("member-5");
    expect(await keyboardReachable(page, row)).toBe(true);
    await page.keyboard.press("Enter");
    const popup = page.getByTestId("user-profile-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Pim");
  });

  for (const highContrast of [false, true]) {
    test(`targets, contrast and names in Gunmetal${highContrast ? " with High Contrast" : ""}`, async ({
      page,
    }, testInfo) => {
      await bootBuddies(page, { theme: "gunmetal", highContrast });
      await withGames(page);
      const label = (t: Locator) => t.getAttribute("data-testid");
      expect(
        await undersizedTargets(column(page).locator(".buddy-row, .buddies-group"), { label }),
      ).toEqual([]);
      const meter = contrastMeter(page);
      await meter.measure("title", column(page).locator(".buddies-title-text"));
      await meter.measure("count", column(page).getByTestId("buddies-count"));
      for (const header of await groups(page).all()) {
        await meter.measure(
          `header ${await header.getAttribute("data-testid")}`,
          header.locator(".buddies-group-text"),
        );
      }
      // Dimmed offline rows are skipped: textContrast ignores opacity.
      for (const row of await column(page).locator(".buddy-row:not(.offline)").all()) {
        const id = await row.getAttribute("data-testid");
        await meter.measure(`name ${id}`, row.locator(".mi-name"));
        const line = row.locator(".buddy-line2 > *");
        if ((await line.count()) > 0) await meter.measure(`line 2 ${id}`, line);
      }
      await testInfo.attach(`buddies-contrast-gunmetal${highContrast ? "-hc" : ""}.json`, {
        body: JSON.stringify(meter.measured, null, 2),
        contentType: "application/json",
      });
      expect(meter.failures).toEqual([]);
      // The repository's structural accessibility check: every control is named.
      expect(await findUnnamedControls(column(page))).toEqual([]);
    });
  }

  for (const fontSize of [12, 16, 20]) {
    test(`at ${fontSize} px text a row focused after a search clears the strips`, async ({
      page,
    }) => {
      await bootBuddies(page, { fontSize, members: bigRoster() });
      const body = column(page).locator(".member-column-body");
      const search = column(page).getByTestId("member-search");
      await search.fill("user01");
      await expect(column(page).getByTestId("member-1")).toHaveCount(0);
      await search.press("Tab");
      await expect(column(page).locator(".buddy-row:focus")).toHaveCount(1);
      await page.keyboard.press("End");
      await page.keyboard.press("Home");
      const focused = column(page).locator(".buddy-row:focus");
      await expect(focused).toHaveCount(1);
      const stripsBottom = await column(page)
        .locator(".member-search-wrap")
        .evaluate((el) => el.getBoundingClientRect().bottom);
      const titleBottom = await column(page)
        .getByTestId("buddies-title")
        .evaluate((el) => el.getBoundingClientRect().bottom);
      const rowTop = await focused.evaluate((el) => el.getBoundingClientRect().top);
      expect(titleBottom).toBeLessThanOrEqual(stripsBottom);
      expect(rowTop).toBeGreaterThanOrEqual(stripsBottom - 0.5);
      expect(await body.evaluate((el) => getComputedStyle(el).scrollPaddingTop)).toBe("64px");
      const short = await column(page)
        .locator(".buddy-row, .buddies-group")
        .evaluateAll((els) =>
          els.map((el) => el.getBoundingClientRect().height).filter((h) => h < 24),
        );
      expect(short).toEqual([]);
    });
  }

  test("the 20 px column shows every group", async ({ page }, testInfo) => {
    await bootBuddies(page, { fontSize: 20 });
    await withGames(page);
    await expect(groups(page)).toHaveCount(5);
    const heights = await rows(page).evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    for (const h of heights) expect(Math.abs(h - 50)).toBeLessThanOrEqual(0.5);
    await shot(page, testInfo, "buddies-1333x934-20px.png");
  });

  test("at 940x500 the composer and the tree are reachable", async ({ page }) => {
    await bootBuddies(page, { viewport: { width: 940, height: 500 } });
    await expectReachable(page.getByTestId("message-input"));
    await expectReachable(page.locator(".server-tree [role=treeitem]"), { skipHidden: true });
  });

  // Until the fold: at 1200 px or less a later layout folds the column behind a
  // top-bar toggle, and this check then expects the overlay.
  test("at 940x500 the column sits beside the chat (until the fold)", async ({
    page,
  }, testInfo) => {
    await bootBuddies(page, { viewport: { width: 940, height: 500 } });
    await withGames(page);
    const chat = (await page.getByTestId("chat-area").boundingBox())!;
    const side = (await column(page).boundingBox())!;
    expect(await column(page).evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
    expect(side.x).toBeGreaterThanOrEqual(chat.x + chat.width - 0.5);
    await shot(page, testInfo, "buddies-940x500.png");
  });

  test("the overlay at 640x400 reflows no worse than dev's member list", async ({ page }) => {
    await bootBuddies(page, { viewport: ZOOM_VIEWPORT });
    await withGames(page);
    const audit = await auditReflow(column(page));
    test.info().annotations.push({ type: "reflow", description: JSON.stringify(audit) });
    expect(audit.pageOverflow).toBeLessThanOrEqual(DEV_BASELINE.pageOverflow);
    expect(audit.clipped.length).toBeLessThanOrEqual(DEV_BASELINE.clipped.length);
    expect(audit.covered.length).toBeLessThanOrEqual(DEV_BASELINE.covered.length);
    expect(audit.twoDimensional.length).toBeLessThanOrEqual(DEV_BASELINE.twoDimensional.length);
  });

  test("a mixed 600-member roster scrolls to the end with contiguous rows", async ({ page }) => {
    await bootBuddies(page, { members: bigRoster() });
    for (let id = 6; id <= 600; id += 25) await startGame(page, id, `Game ${id}`);
    await expect(column(page).getByTestId("buddies-group-game")).toBeVisible();
    const body = column(page).locator(".member-column-body");
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(column(page).getByTestId("member-599")).toBeVisible();
    await expectContiguous(page);
    const heights = await rows(page).evaluateAll((els) => [
      ...new Set(els.map((el) => Math.round(el.getBoundingClientRect().height * 2) / 2)),
    ]);
    expect(heights).toEqual([40]);
  });
});
