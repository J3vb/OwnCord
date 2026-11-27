/**
 * Phone helpers the phone specs share: the device profiles, a held finger,
 * swipes made of touch pointer events, the drag cases for the panels that
 * follow the finger (the channel drawer and the member panel), and the start
 * of a phone Command Deck session with its restart.
 */
import { devices, type Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import {
  buildTauriMockScript,
  mockTauriFullSession,
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
} from "../helpers";
import { findUnnamedControls } from "./accessibility";

const { defaultBrowserType: _pixelBrowser, ...pixel7Device } = devices["Pixel 7"];
const { defaultBrowserType: _iphoneBrowser, ...iphone14Device } = devices["iPhone 14"];

/** Pixel 7 on Chromium. With the Tauri mock its Android user agent is the Android app. */
export const pixel7 = pixel7Device;
/** iPhone 14's size and user agent on Chromium: a phone browser. */
export const iphone14 = iphone14Device;

export const PROFILES = [
  { name: "Pixel 7", use: pixel7 },
  { name: "iPhone 14", use: iphone14 },
];

const { defaultBrowserType: _seBrowser, ...iphoneSeDevice } = devices["iPhone SE (3rd gen)"];
const { defaultBrowserType: _tabBrowser, ...tabS4Device } = devices["Galaxy Tab S4"];

export interface PhoneProfile {
  readonly name: string;
  readonly use: typeof pixel7;
}

/** Pixel 7, 412 x 839: with the Tauri mock and its Android user agent, the Android app. */
export const PIXEL_7: PhoneProfile = { name: "Pixel 7", use: pixel7 };
/** iPhone SE (3rd gen), 375 x 667, on Chromium: a phone browser. */
export const IPHONE_SE: PhoneProfile = { name: "iPhone SE", use: iphoneSeDevice };
/** The narrowest phone the layout is made for: Pixel 7 at 360 x 640. */
export const SMALL_PHONE: PhoneProfile = {
  name: "360 x 640",
  use: { ...pixel7, viewport: { width: 360, height: 640 } },
};
/** Pixel 7 on its side, 863 x 360. */
export const PIXEL_7_LANDSCAPE: PhoneProfile = {
  name: "Pixel 7 landscape",
  use: { ...pixel7, viewport: { width: 863, height: 360 } },
};
/** Galaxy Tab S4 upright, 712 x 1138, with an Android user agent. */
export const TAB_S4: PhoneProfile = { name: "Tab S4", use: tabS4Device };

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";
const THEME_KEY = "owncord:theme:active";
/** Marks a tab seeded once. `window.name` survives Clear all cache & restart,
 *  which clears both storages, so the seed is not written back after it. */
const SEEDED_MARK = "owncord-phone-deck-seeded";

export interface PhoneDeckOptions {
  /** Sign in with the voice routes, so a voice channel can be joined. */
  readonly voice?: boolean;
  /** Turn Developer mode on as well (the preview's gate). */
  readonly developerMode?: boolean;
  /** Write the keys on the first load only; any test that reloads needs it. */
  readonly seedOnce?: boolean;
  /** A session of the spec's own in place of the plain (or voice) one. */
  readonly mock?: Parameters<typeof buildTauriMockScript>[0];
  /** Store this theme too ("gunmetal"); the seeded layout makes the profile an
   *  existing install, which otherwise keeps the fallback theme. */
  readonly theme?: string;
}

/**
 * Signs in on phone Command Deck: stores "deck" (and Developer mode), installs
 * the Tauri mock, opens the main page and waits for `html.layout-deck`, or
 * for its absence with Developer mode off. The fixture seeds "classic" when
 * nothing is stored, so without `seedOnce` the keys are written on every load.
 */
export async function startPhoneDeck(page: Page, options: PhoneDeckOptions = {}): Promise<void> {
  const { voice = false, developerMode = true, seedOnce = false, mock, theme } = options;
  await page.addInitScript(
    ([dev, layout, mark, withDev, once, themeKey, themeName]) => {
      if (once === true) {
        if (window.name === mark) return;
        window.name = mark;
      }
      localStorage.setItem(layout, JSON.stringify("deck"));
      if (withDev === true) localStorage.setItem(dev, JSON.stringify(true));
      if (themeName !== "") localStorage.setItem(themeKey, themeName);
    },
    [DEV_KEY, LAYOUT_KEY, SEEDED_MARK, developerMode, seedOnce, THEME_KEY, theme ?? ""] as const,
  );
  if (mock !== undefined) await page.addInitScript(buildTauriMockScript(mock));
  else await (voice ? mockTauriFullSessionWithVoice(page) : mockTauriFullSession(page));
  await page.goto("/");
  await navigateToMainPage(page);
  const html = page.locator("html");
  await (developerMode
    ? expect(html).toHaveClass(/layout-deck/)
    : expect(html).not.toHaveClass(/layout-deck/));
  if (theme !== undefined)
    await expect(page.locator("body")).toHaveClass(new RegExp(`(^|\\s)theme-${theme}(\\s|$)`));
}

/** Seeds Command Deck once: a reload must not put "deck" back. */
export async function seedDeckOnce(page: Page): Promise<void> {
  await page.addInitScript(
    ([dev, layout]) => {
      if (sessionStorage.getItem("screen-layout-seeded") !== null) return;
      sessionStorage.setItem("screen-layout-seeded", "1");
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify("deck"));
    },
    [DEV_KEY, LAYOUT_KEY] as const,
  );
}

/**
 * Runs `trigger` (a press that restarts the app) and waits for the restart.
 * The Tauri mock only logs `plugin:process|restart`, so when that entry comes
 * before any new page load the helper reloads the page itself; a host that
 * reloads the page on its own is waited for instead.
 */
export async function restartApp(page: Page, trigger: () => Promise<void>): Promise<void> {
  const loaded = page.waitForEvent("load").then(() => "load" as const);
  const logged = page
    .waitForFunction(() =>
      (window as unknown as { __invokeLog?: Array<{ cmd: string }> }).__invokeLog?.some(
        (e) => e.cmd === "plugin:process|restart",
      ),
    )
    .then(() => "log" as const);
  await trigger();
  const first = await Promise.race([loaded, logged.catch(() => "load" as const)]);
  if (first === "log") await page.reload();
  else await loaded;
}

/** How many elements matching `selectors` a tap at their own centre reaches. */
export function reachableCount(page: Page, selectors: string): Promise<number> {
  return page.evaluate((sel) => {
    let count = 0;
    for (const el of document.querySelectorAll(sel)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit !== null && (hit === el || el.contains(hit))) count++;
    }
    return count;
  }, selectors);
}

/** A finger held on `selector`'s centre for `holdMs`, through CDP touch input. */
export async function holdFinger(page: Page, selector: string, holdMs: number): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(holdMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

export interface SwipeTiming {
  readonly steps: number;
  /** The real wait before each move; 0 sends every move in the same task. */
  readonly msPerStep: number;
  /** Where the finger goes down; the element's centre when absent. */
  readonly from?: { readonly x: number; readonly y: number } | null;
  /** Leave the finger down at the end (`liftFinger` lifts it). */
  readonly hold?: boolean;
}

/**
 * A one-finger swipe of touch pointer events dispatched on the element, the
 * way the app's own gesture code listens for them (no browser gesture or
 * hit-testing involved). Each move is sent in its own task after a real wait
 * of `msPerStep`, so the swipe has a speed.
 */
export async function swipeOnTimed(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  timing: SwipeTiming,
): Promise<void> {
  await page.evaluate(
    async ({ selector, dx, dy, steps, msPerStep, from, hold }) => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`no element for ${selector}`);
      const box = el.getBoundingClientRect();
      const x0 = from?.x ?? box.left + box.width / 2;
      const y0 = from?.y ?? box.top + box.height / 2;
      const fire = (target: Element, type: string, x: number, y: number): void => {
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
          }),
        );
      };
      fire(el, "pointerdown", x0, y0);
      for (let i = 1; i <= steps; i++) {
        if (msPerStep > 0) await new Promise((r) => setTimeout(r, msPerStep));
        fire(el, "pointermove", x0 + (dx * i) / steps, y0 + (dy * i) / steps);
      }
      const up = (): void => fire(el, "pointerup", x0 + dx, y0 + dy);
      if (hold) (window as unknown as { __liftFinger?: () => void }).__liftFinger = up;
      else up();
    },
    {
      selector,
      dx,
      dy,
      steps: timing.steps,
      msPerStep: timing.msPerStep,
      from: timing.from ?? null,
      hold: timing.hold === true,
    },
  );
}

/** Lift the finger a `swipeOnTimed` with `hold` left down, where it is. */
export async function liftFinger(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __liftFinger?: () => void };
    const lift = w.__liftFinger;
    delete w.__liftFinger;
    if (lift === undefined) throw new Error("no finger is down");
    lift();
  });
}

/** A swipe whose moves all arrive at once: it has no speed, so it is never a flick. */
export async function swipeOn(
  page: Page,
  selector: string,
  dx: number,
  dy = 0,
  start: { x: number; y: number } | null = null,
): Promise<void> {
  await swipeOnTimed(page, selector, dx, dy, { steps: 6, msPerStep: 0, from: start });
}

export type PhoneLayout = "classic" | "deck";

interface DragPanel {
  readonly name: string;
  /** Where the finger opens it: on the chat, from this side of the screen. */
  readonly side: "left" | "right";
  /** The panel itself. */
  readonly root: string;
  /** What a closing drag starts on. */
  readonly closeOn: string;
  isOpen(page: Page): Promise<boolean>;
  /** Open with its button; resolves to its travel. */
  openWithButton(page: Page): Promise<number>;
  /** The panel's inline transform ("" when no drag holds it). */
  transform(page: Page): Promise<string>;
}

const DRAWER = "[data-testid='unified-sidebar']";
const MEMBERS = "#member-column";

const inlineTransform = (page: Page, selector: string): Promise<string> =>
  page.locator(selector).evaluate((el) => (el as HTMLElement).style.transform);

const PANELS: readonly DragPanel[] = [
  {
    name: "the channel drawer",
    side: "left",
    root: DRAWER,
    closeOn: `${DRAWER} .channel-list`,
    isOpen: async (page) =>
      (await page.locator("[data-testid='sidebar-toggle']").getAttribute("aria-expanded")) ===
      "true",
    async openWithButton(page) {
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(page.locator(DRAWER)).toHaveClass(/drawer-open/);
      // From the screen's left edge to the drawer's far edge (the rail is beside it).
      const box = await page.locator(DRAWER).boundingBox();
      return box === null ? 0 : box.x + box.width;
    },
    transform: (page) => inlineTransform(page, DRAWER),
  },
  {
    name: "the member list",
    side: "right",
    root: MEMBERS,
    closeOn: `${MEMBERS} .member-item`,
    isOpen: async (page) =>
      (await page.locator("[data-testid='member-list-toggle']").getAttribute("aria-pressed")) ===
      "true",
    async openWithButton(page) {
      await page.locator("[data-testid='member-list-toggle']").tap();
      await expect(page.locator(MEMBERS)).toBeVisible();
      const box = await page.locator(MEMBERS).boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      return box === null ? 0 : width - box.x;
    },
    transform: (page) => inlineTransform(page, MEMBERS),
  },
];

/** A drag on the chat that opens `panel` by `distance` px, from near its edge. */
async function dragOpen(
  page: Page,
  panel: DragPanel,
  distance: number,
  timing: SwipeTiming,
): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const box = await page.locator(".chat-header").boundingBox();
  const y = box === null ? 0 : box.y + box.height / 2;
  const from = { x: panel.side === "left" ? 16 : width - 16, y };
  const dx = panel.side === "left" ? distance : -distance;
  await swipeOnTimed(page, ".chat-header", dx, 0, { ...timing, from });
}

/** Wait for the panel to settle where it ends up: open or not, and no drag left on it. */
async function expectSettled(page: Page, panel: DragPanel, open: boolean): Promise<void> {
  await expect.poll(() => panel.isOpen(page)).toBe(open);
  await expect.poll(() => panel.transform(page)).toBe("");
  if (panel.side === "left") {
    const drawer = page.locator(DRAWER);
    await (open
      ? expect(drawer).toHaveClass(/drawer-open/)
      : expect(drawer).not.toHaveClass(/drawer-open/));
  } else {
    await (open
      ? expect(page.locator(MEMBERS)).toBeVisible()
      : expect(page.locator(MEMBERS)).toBeHidden());
  }
}

/** A panel opened by a drag: every control named, and the keyboard reaches its first one. */
async function expectPanelAccessible(page: Page, panel: DragPanel): Promise<void> {
  const root = page.locator(panel.root);
  expect(await findUnnamedControls(root)).toEqual([]);
  const first = root.locator("button:visible, a[href]:visible, [tabindex='0']:visible").first();
  await first.focus();
  await expect(first).toBeFocused();
}

/** A panel shut by a drag keeps no focus inside it. */
async function expectFocusOutside(page: Page, panel: DragPanel): Promise<void> {
  const inside = await page
    .locator(panel.root)
    .evaluate((el) => el.contains(document.activeElement));
  expect(inside).toBe(false);
}

/** Slow: well under the flick speed (0.4 px/ms), so only the distance counts. */
const slowly = (distance: number, steps: number): SwipeTiming => ({
  steps,
  msPerStep: Math.max(40, Math.ceil((distance / steps) * 5)),
});

/**
 * The harness reduces motion (playwright.config.ts), which turns the follow
 * off, so each drag case asks for motion and checks the app took it.
 */
async function startWithMotion(page: Page, start: (page: Page) => Promise<void>): Promise<void> {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await start(page);
  await expect(page.locator("html")).not.toHaveClass(/reduced-motion/);
}

/**
 * The drag cases, distance only (the flick is a unit case): for each panel, a
 * slow drag of 30 % of its travel follows the finger and snaps back, one of
 * 90 % opens, and one of 90 % back shuts it; at 360 x 640 a slow 100 px drag
 * snaps back. Register inside a describe whose `beforeEach` has the page ready
 * for `start`, which signs in.
 */
export function dragCases(layout: PhoneLayout, start: (page: Page) => Promise<void>): void {
  test.describe(`${layout}: panels that follow the finger`, () => {
    for (const panel of PANELS) {
      test(`${panel.name} follows a slow drag, opens past 40 % and snaps back short of it`, async ({
        page,
      }) => {
        await startWithMotion(page, start);
        const travel = await panel.openWithButton(page);
        expect(travel).toBeGreaterThan(200);
        await page.keyboard.press("Escape");
        await expectSettled(page, panel, false);

        // Half way (30 % of the travel), slowly: it follows, then snaps back.
        const half = Math.round(travel * 0.3);
        await dragOpen(page, panel, half, { ...slowly(half, 10), hold: true });
        const shift = Math.abs(Number(/-?[\d.]+/.exec(await panel.transform(page))?.[0]));
        expect(shift).toBeGreaterThan(travel - half - 2);
        expect(shift).toBeLessThan(travel - half + 2);
        await liftFinger(page);
        await expectSettled(page, panel, false);

        const full = Math.round(travel * 0.9);
        await dragOpen(page, panel, full, slowly(full, 18));
        await expectSettled(page, panel, true);
        await expectPanelAccessible(page, panel);

        const shutBy = panel.side === "left" ? -full : full;
        await swipeOnTimed(page, panel.closeOn, shutBy, 0, slowly(full, 18));
        await expectSettled(page, panel, false);
        await expectFocusOutside(page, panel);
      });
    }

    test("at 360 x 640 a slow 100 px drag snaps back", async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 640 });
      await startWithMotion(page, start);
      for (const panel of PANELS) {
        await dragOpen(page, panel, 100, slowly(100, 10));
        await expectSettled(page, panel, false);
      }
    });
  });
}
