import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  buildTauriMockScript,
  grantExternalConsent,
  navigateToMainPage,
  waitForWsReady,
  MOCK_LOGIN_RESPONSE,
  MOCK_PINNED_MESSAGES,
} from "./helpers";

// Chat scroll-up guard (chat-scroll-perf PR c). A channel of 600 messages is
// served in 50-row pages, newest first, exactly as the server does; the spec
// scrolls to the top with the mouse wheel and counts what the list did, not how
// long it took: every history page must land without the window being rebuilt,
// so no row is torn down and no image is loaded again. Counters, not
// milliseconds, so a slow CI machine cannot flip it. The long-task figure is a
// soft report (an annotation), never an assertion. Trace and video are off:
// Playwright's DOM snapshotter walks the whole page on every action.
test.use({ trace: "off", video: "off" });

const TOTAL = 600;
const PAGE = 50;
/** A direct GIF link in every 12th message (distinct URL per row). */
const GIF_EVERY = 12;
/** The smallest valid GIF (1x1), served for every external image. */
const GIF_BYTES = [
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
];

function gifUrl(id: number): string {
  return `https://img.example.com/clip-${id}.gif`;
}

function gifImages(): Record<string, number[]> {
  const images: Record<string, number[]> = {};
  for (let id = GIF_EVERY; id <= TOTAL; id += GIF_EVERY) images[`url:${gifUrl(id)}`] = GIF_BYTES;
  return images;
}

/** Serves `/channels/1/messages` as 50-row pages from a generated history, by
 *  intercepting the three-step plugin:http exchange for that path only. */
function pagedHistory(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const total = 600;
  const page = 50;
  const gifEvery = 12;
  const internals = (window as any).__TAURI_INTERNALS__;
  const orig = internals.invoke;
  const scale = { pages: 0, rebuilds: 0, rows: 0 };
  (window as any).__scale = scale;
  const mine: Record<number, Uint8Array | { status: number; headers: string[][]; url: string }> =
    {};
  const pendingUrl: Record<number, string> = {};
  let nextRid = 5_000_000;

  const message = (id: number): unknown => ({
    id,
    channel_id: 1,
    user: { id: 1 + (id % 3), username: `user${id % 3}`, avatar: "" },
    content:
      id % gifEvery === 0
        ? `look https://img.example.com/clip-${id}.gif`
        : `message ${id} ${"lorem ipsum ".repeat(1 + (id % 5))}`,
    // Ten minutes apart: a day divider about every 144 rows, no grouping.
    timestamp: new Date(Date.UTC(2026, 2, 1, 0, id * 10)).toISOString(),
    edited_at: null,
    attachments: [],
    reactions: [],
    reply_to: null,
    pinned: false,
    deleted: false,
  });

  internals.invoke = async (cmd: string, args: any) => {
    if (cmd === "plugin:http|fetch") {
      const url: string = args?.clientConfig?.url ?? args?.url ?? "";
      if (
        /\/channels\/1\/messages(\?|$)/.test(url) &&
        (args?.clientConfig?.method ?? "GET") === "GET"
      ) {
        const rid = nextRid++;
        pendingUrl[rid] = url;
        return rid;
      }
    }
    if (cmd === "plugin:http|fetch_send" && pendingUrl[args?.rid] !== undefined) {
      const url = pendingUrl[args.rid]!;
      delete pendingUrl[args.rid];
      const before = Number(new URL(url, "http://x").searchParams.get("before") ?? total + 1);
      const newest = Math.min(before - 1, total);
      const oldest = Math.max(1, newest - page + 1);
      const messages = [];
      for (let id = newest; id >= oldest; id--) messages.push(message(id));
      if (before <= total) scale.pages++;
      const body = new TextEncoder().encode(JSON.stringify({ messages, has_more: oldest > 1 }));
      const responseRid = nextRid++;
      mine[responseRid] = body;
      return {
        status: 200,
        statusText: "OK",
        url,
        headers: [["content-type", "application/json"]],
        rid: responseRid,
      };
    }
    if (cmd === "plugin:http|fetch_read_body" && mine[args?.rid] !== undefined) {
      const body = mine[args.rid] as Uint8Array;
      delete mine[args.rid];
      return [...body, 0];
    }
    return orig(cmd, args);
  };

  // A rebuild replaces (nearly) every rendered row at once; a slide only the
  // few that left or entered.
  new MutationObserver((records) => {
    const rows = records.filter(
      (r) =>
        (r.target as HTMLElement).classList !== undefined &&
        (r.target as HTMLElement).classList.contains("virtual-content"),
    );
    if (rows.length === 0) return;
    // One batch is one task: the rows it removed, against the window's size
    // before it. (A rebuild may remove them one by one.)
    const container = rows[0]!.target as HTMLElement;
    let removed = 0;
    let added = 0;
    for (const r of rows) {
      removed += r.removedNodes.length;
      added += r.addedNodes.length;
    }
    const size = container.children.length + removed - added;
    if (removed >= 10 && removed >= size * 0.8) scale.rebuilds++;
  }).observe(document, { childList: true, subtree: true });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

async function seedSession(page: Page): Promise<void> {
  await grantExternalConsent(page);
  await page.addInitScript(
    buildTauriMockScript({
      wrappers: [pagedHistory],
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      ],
      simulateWsFlow: true,
      externalContent: { image: gifImages() },
    }),
  );
  await page.addInitScript(() => {
    const tasks: number[] = [];
    (window as unknown as { __longTasks: number[] }).__longTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
}

interface Scale {
  readonly pages: number;
  readonly rebuilds: number;
}

function scale(page: Page): Promise<Scale> {
  return page.evaluate(() => (window as unknown as { __scale: Scale }).__scale);
}

test.describe("Message list scrolling up through 600 messages", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await seedSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await waitForWsReady(page);
    await expect(page.locator("[data-testid='message-600']")).toBeVisible();
  });

  test("history pages land without rebuilding the window or loading an image again", async ({
    page,
  }) => {
    const region = page.locator(".messages-container");
    const box = (await region.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // Counted from here: the first paint is allowed to build the window.
    const first = await scale(page);
    const brokerBefore = await page.evaluate(
      () =>
        (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.filter(
          (c) => c.cmd === "external_image",
        ).length,
    );

    // Scroll up until at least 5 history pages have landed (the store keeps
    // 500 rows, so the window slides as they do), or give up.
    for (let tick = 0; tick < 400; tick++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(25);
      if ((await scale(page)).pages - first.pages >= 5) break;
    }
    // Let the last page and its slide settle.
    await page.waitForTimeout(500);

    const done = await scale(page);
    const pages = done.pages - first.pages;
    const rebuilds = done.rebuilds - first.rebuilds;
    const brokerCalls = await page.evaluate(() =>
      (
        window as unknown as { __invokeLog: Array<{ cmd: string; args: { url?: string } }> }
      ).__invokeLog
        .filter((c) => c.cmd === "external_image")
        .map((c) => c.args.url),
    );
    const longTasks = await page.evaluate(
      () => (window as unknown as { __longTasks: number[] }).__longTasks,
    );
    test.info().annotations.push({
      type: "message-list-scale",
      description: `pages=${pages} rebuilds=${rebuilds} brokerImageCalls=${brokerCalls.length - brokerBefore} longTasksOver50ms=${longTasks.filter((d) => d > 50).length} (soft report)`,
    });

    expect(pages, "history pages that landed").toBeGreaterThanOrEqual(5);
    expect(rebuilds, "full window rebuilds while pages landed").toBe(0);
    // Each distinct GIF is fetched through the broker at most once: a rebuilt
    // window would ask for the ones it had already drawn again.
    expect(brokerCalls.length, "broker image calls").toBeLessThanOrEqual(new Set(brokerCalls).size);
  });
});
