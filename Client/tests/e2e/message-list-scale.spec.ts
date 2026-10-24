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

// Chat scroll-up guard (chat-scroll-perf PRs c, e, f and g). A channel of 600 messages is
// served in 50-row pages, newest first, exactly as the server does; the spec
// scrolls to the top with the mouse wheel and counts what the list did, not how
// long it took: every history page must land without the window being rebuilt,
// so no row is torn down and no image is loaded again. Counters, not
// milliseconds, so a slow CI machine cannot flip it. The long-task figure is a
// soft report (an annotation), never an assertion. Trace and video are off:
// Playwright's DOM snapshotter walks the whole page on every action.
test.use({ trace: "off", video: "off" });

const TOTAL = 600;
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
  const scale = {
    pages: 0,
    rebuilds: 0,
    rows: 0,
    imageLoads: 0,
    imageLoadShifts: 0,
    phase: "first",
    firstLoads: 0,
    firstMountShifts: 0,
    revisitLoads: 0,
    revisitMountShifts: 0,
    slides: 0,
    overBudgetSlides: 0,
    maxExtraReads: 0,
  };
  (window as any).__scale = scale;
  // `offsetHeight` reads made while the list slides (chat-scroll-perf PR f).
  // The ResizeObserver pass re-measures the whole window, by design, in the
  // observer callback (or, when it may build rows, in a frame it schedules
  // from there), so reads inside either are not counted.
  let heightReads = 0;
  let skipReads = false;
  let inObserver = false;
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      if (!skipReads && !inObserver) heightReads++;
      return heightDesc.get!.call(this);
    },
  });
  const ResizeObserverOrig = window.ResizeObserver;
  window.ResizeObserver = class extends ResizeObserverOrig {
    constructor(cb: ResizeObserverCallback) {
      super((entries, observer) => {
        inObserver = true;
        try {
          cb(entries, observer);
        } finally {
          inObserver = false;
        }
      });
    }
  };
  const rafOrig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const fromObserver = inObserver;
    return rafOrig((t) => {
      skipReads = fromObserver;
      try {
        cb(t);
      } finally {
        skipReads = false;
      }
    });
  };
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

  // An image's box must already be its final size when the pixels arrive
  // (chat-scroll-perf PR e). Two measures: the wrapper's height just before
  // `load` fires against a frame after it (the sniffed box is in place), and
  // the height when the wrapper was first mounted against a frame after
  // `load`, which a revisit (box cached from the first sighting) must keep.
  // `load` does not bubble, so listen in capture, which runs before the app's
  // own handler for that image.
  const mountedHeight = new WeakMap<Element, number>();
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const wraps = node.classList.contains("msg-image")
          ? [node]
          : [...node.querySelectorAll(".msg-image")];
        for (const wrap of wraps) {
          if (!mountedHeight.has(wrap))
            mountedHeight.set(wrap, wrap.getBoundingClientRect().height);
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener(
    "load",
    (event) => {
      const img = event.target;
      const wrap = img instanceof HTMLImageElement ? img.closest(".msg-image") : null;
      if (wrap === null) return;
      const before = wrap.getBoundingClientRect().height;
      const mounted = mountedHeight.get(wrap) ?? before;
      const revisit = scale.phase === "revisit";
      scale.imageLoads++;
      if (revisit) scale.revisitLoads++;
      else scale.firstLoads++;
      requestAnimationFrame(() => {
        if (!wrap.isConnected) return;
        const after = wrap.getBoundingClientRect().height;
        if (Math.abs(after - before) > 0.5) scale.imageLoadShifts++;
        if (Math.abs(after - mounted) > 0.5) {
          if (revisit) scale.revisitMountShifts++;
          else scale.firstMountShifts++;
        }
      });
    },
    true,
  );

  // A rebuild replaces (nearly) every rendered row at once; a slide only the
  // few that left or entered.
  new MutationObserver((records) => {
    const reads = heightReads;
    heightReads = 0;
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
    else if (added > 0) {
      // A slide: only the rows that entered or left may be measured (+2 slack).
      scale.slides++;
      scale.maxExtraReads = Math.max(scale.maxExtraReads, reads - added - removed);
      if (reads - added - removed > 2) scale.overBudgetSlides++;
    }
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
  readonly imageLoads: number;
  readonly imageLoadShifts: number;
  readonly firstLoads: number;
  readonly firstMountShifts: number;
  readonly revisitLoads: number;
  readonly revisitMountShifts: number;
  readonly slides: number;
  readonly overBudgetSlides: number;
  readonly maxExtraReads: number;
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
    let maxRows = 0;
    const sampleRows = async (): Promise<void> => {
      const n = await page.locator(".virtual-content").evaluate((el) => el.children.length);
      maxRows = Math.max(maxRows, n);
    };
    for (let tick = 0; tick < 400; tick++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(25);
      await sampleRows();
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
      description: `pages=${pages} rebuilds=${rebuilds} slides=${done.slides} overBudgetSlides=${done.overBudgetSlides} maxExtraHeightReads=${done.maxExtraReads} brokerImageCalls=${brokerCalls.length - brokerBefore} imageLoads=${done.imageLoads} imageLoadShifts=${done.imageLoadShifts} firstSightingMountShifts=${done.firstMountShifts}/${done.firstLoads} maxRowsInWindow=${maxRows} longTasksOver50ms=${longTasks.filter((d) => d > 50).length} (soft report)`,
    });

    expect(pages, "history pages that landed").toBeGreaterThanOrEqual(5);
    expect(rebuilds, "full window rebuilds while pages landed").toBe(0);
    // Overscan is a viewport of distance each side, not 20 rows (chat-scroll-perf
    // PR g): measured 30 rows in this 1280x720 channel, 51 with the row count.
    expect(maxRows, "most rows ever rendered in the window").toBeLessThanOrEqual(36);
    // A scroll slide measures the rows that entered and nothing else
    // (chat-scroll-perf PR f): offsetHeight reads <= rows entered + rows departed + 2. A
    // history page landing is the one other slide, and it re-records the whole
    // window once (by design), so at most one over-budget slide per page.
    expect(done.slides, "window slides").toBeGreaterThan(done.pages);
    expect(
      done.overBudgetSlides - first.overBudgetSlides,
      "slides that read offsetHeight beyond rows entered + departed + 2, other than page landings",
    ).toBeLessThanOrEqual(pages);

    // Each distinct GIF is fetched through the broker at most once: a rebuilt
    // window would ask for the ones it had already drawn again.
    expect(brokerCalls.length, "broker image calls").toBeLessThanOrEqual(new Set(brokerCalls).size);
    // Every image box is reserved from its header before the pixels arrive, so
    // no load changes its row's height (chat-scroll-perf PR e). A first
    // sighting still moves from the 200px guess to the sniffed box when the
    // broker answers (reported above, not asserted).
    expect(done.imageLoads, "images that loaded").toBeGreaterThan(0);
    expect(done.imageLoadShifts, "image loads that changed their box's height").toBe(0);

    // Back down to the newest rows: every image box is remounted from the
    // cached size, so from mount to after load it must not move at all.
    await page.evaluate(() => {
      (window as unknown as { __scale: { phase: string } }).__scale.phase = "revisit";
    });
    for (let tick = 0; tick < 400; tick++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(25);
      if ((await scale(page)).revisitLoads >= 3) break;
    }
    await page.waitForTimeout(500);
    const revisited = await scale(page);
    expect(revisited.revisitLoads, "images remounted on the way back").toBeGreaterThan(0);
    expect(
      revisited.revisitMountShifts,
      "remounted images whose box moved between mount and load",
    ).toBe(0);
  });
});
