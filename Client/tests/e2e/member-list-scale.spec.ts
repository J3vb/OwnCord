import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  buildTauriMockScript,
  navigateToMainPage,
  waitForWsReady,
  MOCK_CHANNELS,
  MOCK_PINNED_MESSAGES,
  MOCK_ROLES,
  BASE_SESSION_ROUTES,
} from "./helpers";

// 4.14c: 2,000 members in the right-hand column. The list draws only the rows in
// view, so store and render work must stay under the ARCH-048 bar of 50 ms per
// task. Trace and video are off: Playwright's DOM snapshotter walks the whole
// page on every action and inflates long tasks on a DOM this size.
test.use({ trace: "off", video: "off" });

const MEMBERS = 2000;
const LONG_TASK_BAR_MS = 50;
const NAMES = ["alice", "bob", "carol", "dave", "malik", "erin", "frank", "grace", "heidi", "ivan"];
const LAST_ID = MEMBERS;
const LAST_NAME = "zulu2000";

function seedMembers(): unknown[] {
  const members: unknown[] = [
    { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  ];
  for (let id = 2; id <= MEMBERS; id++) {
    const slot = id % 40;
    // 15% online, 5% idle, 2.5% dnd, the rest offline.
    const status = slot < 6 ? "online" : slot < 8 ? "idle" : slot === 8 ? "dnd" : "offline";
    const online = status !== "offline";
    members.push({
      id,
      username: id === LAST_ID ? LAST_NAME : `${NAMES[id % NAMES.length]}${id}`,
      avatar: "",
      status: id === LAST_ID ? "offline" : status,
      role: id <= 12 ? "admin" : id <= 60 ? "moderator" : "member",
      display_name:
        id !== LAST_ID && id % 3 === 0 ? `Nick ${NAMES[id % NAMES.length]} ${id}` : null,
      custom_status: online && id % 5 === 0 ? `status ${id}` : null,
    });
  }
  return members;
}

async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      ],
      simulateWsFlow: true,
      readyOverrides: { channels: MOCK_CHANNELS, members: seedMembers(), roles: MOCK_ROLES },
    }),
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-seeded") !== null) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.setItem("owncord:settings:memberListLayout", JSON.stringify("right"));
  });
  await page.addInitScript(() => {
    const tasks: Array<{ start: number; duration: number }> = [];
    (window as unknown as { __longTasks: typeof tasks }).__longTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  });
}

/** The longest long task that started inside `[from, to]`, in ms (0 for none). */
async function longestTask(page: Page, from: number, to: number): Promise<number> {
  return page.evaluate(
    ([lo, hi]) => {
      const tasks = (
        window as unknown as { __longTasks: Array<{ start: number; duration: number }> }
      ).__longTasks;
      return Math.max(
        0,
        ...tasks.filter((t) => t.start >= lo! && t.start <= hi!).map((t) => t.duration),
      );
    },
    [from, to] as const,
  );
}

function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/** Run `work` in the page, let the long-task entries arrive, and return the longest. */
async function measurePhase(page: Page, work: () => Promise<void>): Promise<number> {
  const from = await now(page);
  await work();
  await page.waitForTimeout(400);
  const to = await now(page);
  return longestTask(page, from, to);
}

function nodeCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector("#member-column")!.querySelectorAll("*").length,
  );
}

test.describe("Member list at 2,000 members", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await seedSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await waitForWsReady(page);
    await expect(page.locator("#member-column [data-testid='member-1']")).toBeVisible();
  });

  test("2,000 members: reopen, search 'ali' then clear, 200 presence events, a presence_batch of 200 - no long task over 50 ms", async ({
    page,
  }) => {
    const peaks: Record<string, number> = {};
    let nodes = await nodeCount(page);

    peaks["reopen"] = await measurePhase(page, async () => {
      await page.evaluate(async () => {
        const toggle = document.querySelector<HTMLElement>("[data-testid='member-list-toggle']")!;
        const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
        toggle.click();
        await frame();
        toggle.click();
        await frame();
      });
    });
    await expect(page.locator("#member-column [data-testid='member-1']")).toBeVisible();
    nodes = Math.max(nodes, await nodeCount(page));

    peaks["search"] = await measurePhase(page, async () => {
      await page.evaluate(async () => {
        const search = document.querySelector<HTMLInputElement>("[data-testid='member-search']")!;
        const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
        for (const text of ["a", "al", "ali", "al", "a", ""]) {
          search.value = text;
          search.dispatchEvent(new Event("input", { bubbles: true }));
          await frame();
          await frame();
        }
      });
    });
    await expect(page.locator("#member-column [data-testid='member-1']")).toBeVisible();
    nodes = Math.max(nodes, await nodeCount(page));

    peaks["presence x200"] = await measurePhase(page, async () => {
      await page.evaluate(async (members) => {
        const emit = (
          window as unknown as { __tauriEmitEvent: (name: string, payload: string) => void }
        ).__tauriEmitEvent;
        const statuses = ["online", "offline", "idle", "dnd"];
        for (let i = 0; i < 200; i++) {
          const userId = 2 + ((i * 37) % (members - 2));
          emit(
            "ws-message",
            JSON.stringify({
              type: "presence",
              payload: { user_id: userId, status: statuses[i % 4], custom_status: null },
            }),
          );
          await new Promise((r) => setTimeout(r, 50));
        }
      }, MEMBERS);
    });
    nodes = Math.max(nodes, await nodeCount(page));

    peaks["presence_batch x200"] = await measurePhase(page, async () => {
      await page.evaluate((members) => {
        const emit = (
          window as unknown as { __tauriEmitEvent: (name: string, payload: string) => void }
        ).__tauriEmitEvent;
        const statuses = ["idle", "online", "offline", "dnd"];
        const updates = Array.from({ length: 200 }, (_, i) => ({
          user_id: 2 + ((i * 11 + 5) % (members - 2)),
          status: statuses[i % 4],
          custom_status: null,
        }));
        emit("ws-message", JSON.stringify({ type: "presence_batch", payload: { updates } }));
      }, MEMBERS);
    });
    nodes = Math.max(nodes, await nodeCount(page));

    test.info().annotations.push({
      type: "long-task-max-ms",
      description: `${JSON.stringify(peaks)} nodes=${nodes}`,
    });
    for (const [phase, ms] of Object.entries(peaks)) {
      expect(ms, `${phase}: longest task ${ms} ms`).toBeLessThanOrEqual(LONG_TASK_BAR_MS);
    }
    expect(nodes).toBeLessThan(1500);
    const drawn = await page.locator("#member-column .member-item").count();
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(100);
  });

  test("a far member is reachable through search and by End, and opens its profile", async ({
    page,
  }) => {
    const column = page.locator("#member-column");
    const last = column.locator(`[data-testid='member-${LAST_ID}']`);
    // Far down the OFFLINE group: not drawn until reached.
    await expect(last).toHaveCount(0);

    const search = column.locator("[data-testid='member-search']");
    await search.fill(LAST_NAME);
    await expect(column.locator(".member-item")).toHaveCount(1);
    await expect(last).toBeVisible();
    await last.click();
    const popup = page.locator("[data-testid='user-profile-popup']");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(LAST_NAME);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();

    await search.fill("");
    await expect(last).toHaveCount(0);
    const first = column.locator("[data-testid='member-1']");
    await first.focus();
    await page.keyboard.press("End");
    await expect(last).toBeFocused();
    await expect(last).toBeVisible();
    expect(await column.locator(".member-item").count()).toBeLessThan(100);

    await page.keyboard.press("Enter");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(LAST_NAME);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(last).toBeFocused();
  });
});
