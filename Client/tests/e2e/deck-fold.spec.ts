/**
 * Command Deck's fold: at 1200 px wide or less the member column (Buddies and
 * Info) is an overlay under the chat header, opened by the member toggle at
 * the end of the top bar's connection cell, beside the ping.
 *
 * The scene's voice handlers send no voice_token, so a join stays at
 * `joining`; `enterCall` marks it connected through the `__owncord` seam every
 * build exposes. A sample (for the ping) and a dropped chat connection are
 * written through the dev server's module graph; only those steps skip on the
 * production preview.
 *
 * Screenshots for the hand check: fold-top-bar-1333x934.png (the top bar in a
 * call), fold-overlay-940x500.png and fold-overlay-1200x800.png (the overlay
 * open in a call) and fold-top-bar-640x400.png (the tab fold in a call).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoiceChannelByName } from "./helpers";
import { contrastMeter, findUnnamedControls, keyboardReachable } from "./support/accessibility";
import { attachShot } from "./support/deckHandCheck";
import { MIRA, startDirectScene } from "./support/deckDirectScene";
import { startDeckScene } from "./support/deckTreeScene";

type Size = { readonly width: number; readonly height: number };

const bar = (page: Page): Locator => page.getByTestId("deck-top-bar");
const group = (page: Page): Locator => page.getByTestId("deck-top-end");
const toggle = (page: Page): Locator => page.getByTestId("member-list-toggle");
const ping = (page: Page): Locator => page.getByTestId("deck-ping");
const connection = (page: Page): Locator => group(page).getByTestId("deck-connection");
const column = (page: Page): Locator => page.locator("#member-column");
const search = (page: Page): Locator => column(page).getByTestId("member-search");

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  if (b === null) throw new Error("no box");
  return b;
}

/** Imports a dev-graph module and calls one export. False on the preview build. */
function devGraph(page: Page, url: string, fn: string, args: readonly unknown[]): Promise<boolean> {
  return page.evaluate(
    async ({ url: moduleUrl, fn: exportName, args: callArgs }) => {
      const mod = (await import(/* @vite-ignore */ moduleUrl).catch(() => null)) as Record<
        string,
        (...a: unknown[]) => void
      > | null;
      if (mod === null) return false;
      mod[exportName]!(...callArgs);
      return true;
    },
    { url, fn, args },
  );
}

/** A connected 18 ms sample, written as the voice widget writes one. */
const writeSample = (page: Page): Promise<boolean> =>
  devGraph(page, "/src/lib/voice/liveStats.ts", "writeLiveStats", [
    {
      rtt: 18,
      quality: "excellent",
      outRate: 0,
      inRate: 0,
      outPackets: 0,
      inPackets: 0,
      totalUp: 0,
      totalDown: 0,
      loss: 0,
      jitter: 0,
      available: true,
    },
    true,
  ]);

/** Joins Lounge, then marks the call connected through the `__owncord` seam. */
async function enterCall(page: Page): Promise<void> {
  await joinVoiceChannelByName(page, "Lounge");
  await page.evaluate(() => {
    const seam = (window as unknown as { __owncord: { setVoiceStatus(s: string): void } })
      .__owncord;
    seam.setVoiceStatus("connected");
  });
}

/** Search's centre is the window's within 1 px. */
async function expectSearchCentred(page: Page): Promise<void> {
  const s = await box(page.getByTestId("deck-search"));
  const width = page.viewportSize()!.width;
  expect(Math.abs(s.x + s.width / 2 - width / 2)).toBeLessThanOrEqual(1);
}

/** No two visible items of the top bar overlap. The end group counts by its children, and
 *  the tab row by its tabs: the row spans row 2 and keeps Direct's place clear with padding. */
async function expectNoOverlap(page: Page, label: string): Promise<void> {
  const boxes = await bar(page).evaluate((root) => {
    const items = [...root.children].flatMap((el) =>
      el.matches(".deck-top-end, .server-tabs") ? [...el.children] : [el],
    );
    return items
      .map((el) => ({
        name: el.getAttribute("data-testid") ?? el.className,
        r: el.getBoundingClientRect(),
      }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .map(({ name, r }) => ({ name, left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
  });
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const apart =
        a.right <= b.left + 0.5 ||
        b.right <= a.left + 0.5 ||
        a.bottom <= b.top + 0.5 ||
        b.bottom <= a.top + 0.5;
      if (!apart) overlaps.push(`${a.name} / ${b.name}`);
    }
  }
  expect(overlaps, label).toEqual([]);
}

/** The element's text fits its box. */
async function expectNotClipped(el: Locator): Promise<void> {
  const fits = await el.evaluate((n) => n.scrollWidth <= n.clientWidth);
  expect(fits).toBe(true);
}

const setTextSize = (page: Page, px: string | null): Promise<void> =>
  page.evaluate((size) => {
    const root = document.documentElement.style;
    if (size === null) root.removeProperty("--font-size");
    else root.setProperty("--font-size", size);
  }, px);

/** The overlay is shown, under the chat header and above the status bar. */
async function expectBetweenHeaderAndBar(page: Page, overlay: Locator): Promise<void> {
  await expect(overlay).toBeVisible();
  const header = await box(page.getByTestId("chat-header"));
  const status = await box(page.getByTestId("deck-status-bar"));
  const b = await box(overlay);
  expect(b.y).toBeGreaterThanOrEqual(header.y + header.height - 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(status.y + 0.5);
}

const position = (el: Locator): Promise<string> => el.evaluate((n) => getComputedStyle(n).position);

/** Where focus is, by test id, class or tag. */
const focusedName = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return "none";
    return el.getAttribute("data-testid") ?? (el.className || el.tagName.toLowerCase());
  });

async function resize(page: Page, size: Size): Promise<void> {
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
}

test.describe("Command Deck fold and top bar toggle", () => {
  test("at 1333x934 the toggle and the ping sit in the top bar, and no state overlaps", async ({
    page,
  }, testInfo) => {
    await startDeckScene(page, { theme: "gunmetal" });
    // The toggle is in the top bar's first row, right of the connection state.
    await expect(group(page).locator("[data-testid='member-list-toggle']")).toBeVisible();
    await expect(page.getByTestId("chat-header").getByTestId("member-list-toggle")).toHaveCount(0);
    await expect(toggle(page)).toHaveAccessibleName("Buddies");
    await expect(ping(page)).toBeHidden();
    const c = await box(connection(page));
    const t = await box(toggle(page));
    expect(t.x).toBeGreaterThanOrEqual(c.x + c.width - 0.5);
    expect(Math.abs(t.y + t.height / 2 - (c.y + c.height / 2))).toBeLessThanOrEqual(1);
    expect(t.y + t.height).toBeLessThanOrEqual(
      (await box(page.getByTestId("server-tabs"))).y + 0.5,
    );
    await expectSearchCentred(page);

    await enterCall(page);
    test.skip(!(await writeSample(page)), "needs the dev server's module graph");
    await expect(ping(page)).toBeVisible();
    await expect(ping(page).locator(".deck-ping-text")).toHaveText("18 ms");
    await expect(ping(page).locator(".sr-only")).toHaveText("Ping 18 ms. Quality: Good");
    const p = await box(ping(page));
    expect(p.x + p.width).toBeLessThanOrEqual((await box(connection(page))).x + 0.5);
    await expectSearchCentred(page);
    await attachShot(page, testInfo, "fold-top-bar-1333x934.png");

    // Above 1200 px the toggle shows or hides the column in flow.
    await expect(column(page)).toBeVisible();
    await toggle(page).click();
    await expect(column(page)).toBeHidden();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await toggle(page).click();
    await expect(column(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

    // The toggle: named, controls the column, a 24 px target, a visible ring.
    await expect(toggle(page)).toHaveAttribute("aria-controls", "member-column");
    expect((await box(toggle(page))).width).toBeGreaterThanOrEqual(24);
    expect((await box(toggle(page))).height).toBeGreaterThanOrEqual(24);
    expect(await keyboardReachable(page, toggle(page))).toBe(true);
    const meter = contrastMeter(page);
    await meter.ring("member toggle");
    expect(meter.failures).toEqual([]);
    expect(await findUnnamedControls(bar(page))).toEqual([]);
    // The ping is not a control.
    expect(await ping(page).evaluate((el) => el.tabIndex)).toBe(-1);
    expect(await ping(page).locator("button, a, input, [tabindex]").count()).toBe(0);
    expect(await keyboardReachable(page, ping(page))).toBe(false);

    // Risk 1's seven states.
    await expectNoOverlap(page, "1333x934");
    await resize(page, { width: 940, height: 500 });
    await expect(ping(page)).toBeVisible();
    await expectNoOverlap(page, "940x500");

    await resize(page, { width: 900, height: 600 });
    await setTextSize(page, "20px");
    await expect(ping(page)).toBeVisible();
    await expectNotClipped(connection(page).locator(".deck-connection-text"));
    await expectNoOverlap(page, "900x600 at 20 px");

    expect(
      await devGraph(page, "/src/stores/ui.store.ts", "setConnectionStatus", ["disconnected"]),
    ).toBe(true);
    await expect(connection(page)).toHaveText("Server unreachable");
    await expect(ping(page)).toBeHidden();
    await expectNotClipped(connection(page).locator(".deck-connection-text"));
    await expectNoOverlap(page, "900x600 at 20 px, unreachable");
    await devGraph(page, "/src/stores/ui.store.ts", "setConnectionStatus", ["connected"]);
    await expect(connection(page)).toHaveText("Connected");
    await expect(ping(page)).toBeVisible();

    // The tab fold at 499 px tall: the group in column 4, the ping hidden.
    await resize(page, { width: 940, height: 499 });
    await expect(page.getByTestId("deck-servers-btn")).toBeVisible();
    await expect(ping(page)).toBeHidden();
    await expectNotClipped(connection(page).locator(".deck-connection-text"));
    expect(await group(page).evaluate((el) => getComputedStyle(el).gridColumnStart)).toBe("4");
    await expectNoOverlap(page, "940x499 at 20 px");
    await setTextSize(page, null);

    await resize(page, { width: 899, height: 600 });
    await expect(ping(page)).toBeHidden();
    await expectNoOverlap(page, "899x600");

    await resize(page, { width: 640, height: 400 });
    await expect(page.getByTestId("deck-servers-btn")).toBeVisible();
    await expect(ping(page)).toBeHidden();
    await expectNoOverlap(page, "640x400");
    await attachShot(page, testInfo, "fold-top-bar-640x400.png");
  });

  test("at 940x500 the toggle opens the overlay under the chat header", async ({
    page,
  }, testInfo) => {
    await startDeckScene(page, { theme: "gunmetal", viewport: { width: 940, height: 500 } });
    await expect(column(page)).toBeHidden();
    await expect(group(page).locator("[data-testid='member-list-toggle']")).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

    await enterCall(page);
    await toggle(page).click();
    await expectBetweenHeaderAndBar(page, column(page));
    expect(await position(column(page))).toBe("fixed");
    expect((await box(column(page))).width).toBe(280);
    await expect(search(page)).toBeFocused();
    // Info rides in the overlay, in its compact form at 500 px tall.
    await expect(column(page).getByTestId("room-info")).toBeVisible();
    await expect(column(page).getByTestId("room-info-summary")).toBeVisible();
    await writeSample(page);
    await attachShot(page, testInfo, "fold-overlay-940x500.png");

    await page.keyboard.press("Escape");
    await expect(column(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

    // 1200 px is the overlay; 1201 px the column in flow.
    await resize(page, { width: 1200, height: 800 });
    await expect(column(page)).toBeHidden();
    await toggle(page).click();
    await expectBetweenHeaderAndBar(page, column(page));
    expect(await position(column(page))).toBe("fixed");
    await expect(column(page).locator(".room-info-rows")).toBeVisible();
    await attachShot(page, testInfo, "fold-overlay-1200x800.png");
    await resize(page, { width: 1201, height: 800 });
    await expect(column(page)).toBeVisible();
    expect(await position(column(page))).not.toBe("fixed");
    const chat = await box(page.getByTestId("chat-area"));
    expect((await box(column(page))).x).toBeGreaterThanOrEqual(chat.x + chat.width - 0.5);

    // A maximise with focus in the overlay's search: the column stays, in flow,
    // and focus stays where it was.
    await resize(page, { width: 1000, height: 800 });
    await expect(column(page)).toBeHidden();
    await toggle(page).click();
    await expect(search(page)).toBeFocused();
    await resize(page, { width: 1333, height: 800 });
    await expect(column(page)).toBeVisible();
    expect(await position(column(page))).not.toBe("fixed");
    await expect(search(page)).toBeFocused();

    // Over the composer from 900 to 1200 px: Shift+Tab is recorded, the send
    // button stays reachable by Tab.
    await resize(page, { width: 1000, height: 700 });
    await toggle(page).click();
    await expect(search(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    testInfo.annotations.push({
      type: "shift-tab from the Buddies search at 1000x700",
      description: await focusedName(page),
    });
    await expect(column(page)).toBeVisible();
    expect(await keyboardReachable(page, page.getByTestId("send-btn"))).toBe(true);

    // At 800 px the sidebar is a drawer: opening it closes the overlay.
    await resize(page, { width: 800, height: 600 });
    if (!(await column(page).isVisible())) await toggle(page).click();
    await expect(column(page)).toBeVisible();
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("unified-sidebar")).toBeVisible();
    await expect(column(page)).toBeHidden();
    const pressed = await toggle(page).getAttribute("aria-pressed");
    // A press on the backdrop over the top bar closes the drawer, and toggles nothing.
    const t = await box(toggle(page));
    await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
    await expect(page.getByTestId("sidebar-drawer-backdrop")).toBeHidden();
    await expect(column(page)).toBeHidden();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", pressed ?? "false");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("unified-sidebar")).toBeVisible();
    const items = page.locator(
      "[data-testid='unified-sidebar'] :is(button, a, input, [tabindex='0']):visible",
    );
    await items.last().focus();
    await page.keyboard.press("Tab");
    testInfo.annotations.push({
      type: "tab from the drawer's last item at 800x600",
      description: await focusedName(page),
    });
  });

  test("in a DM the toggle is hidden and takes no space", async ({ page }) => {
    await startDirectScene(page);
    await expect(toggle(page)).toBeVisible();
    await page.locator(`[data-testid=dm-entry][data-channel-id="${MIRA}"]`).click();
    await expect(page.locator(`[data-testid=dm-entry][data-channel-id="${MIRA}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(toggle(page)).toBeHidden();
    const c = await box(connection(page));
    const g = await box(group(page));
    expect(Math.abs(c.x + c.width - (g.x + g.width))).toBeLessThanOrEqual(0.5);

    await page.getByTestId("channel-3").click();
    await expect(toggle(page)).toBeVisible();
  });
});
