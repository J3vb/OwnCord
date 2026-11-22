/**
 * Mocked E2E: the Screen layout setting (Command Deck preview, Phases 1-3).
 *
 * The setting moves the `layout-deck` class on <html> at load, and deck.css
 * styles the frame from it. A pick in Settings applies on the next reload.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  BASE_SESSION_ROUTES,
  buildTauriMockScript,
  joinVoiceChannelByName,
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
  openSettings,
  startFullSession,
  switchSettingsTab,
} from "./helpers";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";
const NOTE = "Applies the next time OwnCord starts or reloads.";

async function seedDeveloperMode(page: Page): Promise<void> {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify(true)), DEV_KEY);
}

/** Seeds Command Deck once: a reload must not put "deck" back. */
async function seedDeckOnce(page: Page): Promise<void> {
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

const hasDeckClass = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("layout-deck"));

const storedLayout = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown, LAYOUT_KEY);

test.describe("Screen layout", () => {
  test("runs Command Deck at load when it is stored and Developer mode is on", async ({ page }) => {
    await page.addInitScript(
      ([dev, layout]) => {
        localStorage.setItem(dev, JSON.stringify(true));
        localStorage.setItem(layout, JSON.stringify("deck"));
      },
      [DEV_KEY, LAYOUT_KEY] as const,
    );
    await startFullSession(page);
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
  });

  test("Classic to Command Deck applies after a reload", async ({ page }) => {
    await seedDeveloperMode(page);
    await startFullSession(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");

    const note = page.getByText(NOTE);
    await expect(note).toBeHidden();
    await page.locator("[data-testid='screen-layout-deck']").click();

    await expect(note).toBeVisible();
    expect(await hasDeckClass(page)).toBe(false);
    expect(await storedLayout(page)).toBe("deck");

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await expect(page.locator("[data-testid='screen-layout-deck']")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(note).toBeHidden();
  });

  test("Command Deck to Classic applies after a reload", async ({ page }) => {
    await seedDeckOnce(page);
    await startFullSession(page);
    expect(await hasDeckClass(page)).toBe(true);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");

    await page.locator("[data-testid='screen-layout-classic']").click();
    await expect(page.getByText(NOTE)).toBeVisible();
    expect(await hasDeckClass(page)).toBe(true);
    expect(await storedLayout(page)).toBe("classic");

    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/layout-deck/);
    expect(await storedLayout(page)).toBe("classic");
  });
});

// ---------------------------------------------------------------------------
// Phase 3b: the Deck frame and its status bar
// ---------------------------------------------------------------------------

const LARGE_FONT_KEY = "owncord:settings:largeFont";
const DESKTOP = { width: 1333, height: 934 } as const;
const MIN_WINDOW = { width: 940, height: 500 } as const;
const ZOOMED = { width: 640, height: 400 } as const;
const STATUS_MIN = 46;

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function startDeck(
  page: Page,
  size: Size,
  options: { largeFont?: boolean; voice?: boolean; media?: boolean } = {},
): Promise<void> {
  await seedDeckOnce(page);
  if (options.largeFont === true) {
    await page.addInitScript(
      (key) => localStorage.setItem(key, JSON.stringify(true)),
      LARGE_FONT_KEY,
    );
  }
  await page.setViewportSize(size);
  if (options.voice === true) {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);
  } else if (options.media === true) {
    // The Media button shows only on a server that answers the gallery routes.
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: BASE_SESSION_ROUTES,
        simulateWsFlow: true,
        readyOverrides: { capabilities: { channel_media: true } },
      }),
    );
    await page.goto("/");
    await navigateToMainPage(page);
  } else {
    await startFullSession(page);
  }
  await expect(page.locator("html")).toHaveClass(/layout-deck/);
}

/** Joins Voice Chat at the desktop size (a narrow window's sidebar is a closed
 *  drawer), then marks the session connected, as the room's status writer would,
 *  through the `__owncord` seam the production build exposes. */
async function enterCall(page: Page, size: Size): Promise<void> {
  await joinVoiceChannelByName(page);
  await page.evaluate(() =>
    (
      window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
    ).__owncord.setVoiceStatus("connected"),
  );
  await page.setViewportSize(size);
}

/** Calls one of the voice store's existing setters through the dev server's
 *  module graph, as reconnect-media-notice.spec.ts does. False when the graph
 *  is not served (the production preview), so the case skips. */
async function setVoiceFlag(
  page: Page,
  setter: "setListenOnly" | "setEncryptionDegraded",
): Promise<boolean> {
  return page.evaluate(
    async ([url, name]) => {
      try {
        const mod = (await import(/* @vite-ignore */ url!)) as Record<
          string,
          (value: boolean) => void
        >;
        mod[name!]!(true);
        return true;
      } catch {
        return false;
      }
    },
    ["/src/stores/voice.store.ts", setter],
  );
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.locator(`[data-testid='${testId}']`).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  return box;
}

/** The overlay is shown, under the chat header and above the status bar. */
async function expectBetweenHeaderAndBar(page: Page, overlay: Locator): Promise<void> {
  await expect(overlay).toBeVisible();
  const header = await boxOf(page, "chat-header");
  const bar = await boxOf(page, "deck-status-bar");
  const box = (await overlay.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 0.5);
}

const statusBar = (page: Page) => page.locator("[data-testid='deck-status-bar']");

/** The bar's own children are its two slots, which are `display: contents`. */
async function barContents(page: Page): Promise<string[]> {
  return statusBar(page).evaluate((bar) =>
    Array.from(bar.children).flatMap((slot) =>
      Array.from(slot.children).map((el) => el.getAttribute("data-testid") ?? el.className),
    ),
  );
}

async function expectNoSideScroll(page: Page): Promise<void> {
  const sizes = await statusBar(page).evaluate((bar) => ({
    scroll: bar.scrollWidth,
    client: bar.clientWidth,
  }));
  expect(sizes.scroll).toBe(sizes.client);
}

test.describe("Command Deck status bar", () => {
  test("outside a call the bar is 46 px tall and holds the user bar", async ({ page }) => {
    await startDeck(page, DESKTOP);
    await expect(statusBar(page).locator("[data-testid='user-bar']")).toBeVisible();
    expect((await boxOf(page, "deck-status-bar")).height).toBe(STATUS_MIN);
    // The status bar is the last thing in the page's column, under the app row.
    const app = await boxOf(page, "app-layout");
    const bar = await boxOf(page, "deck-status-bar");
    expect(bar.y).toBeGreaterThanOrEqual(app.y + app.height);
    expect(bar.y + bar.height).toBeLessThanOrEqual(DESKTOP.height);
  });

  for (const size of [DESKTOP, ZOOMED]) {
    test(`in a call at ${size.width}x${size.height} the bar holds the user bar, then the voice widget`, async ({
      page,
    }) => {
      await startDeck(page, DESKTOP, { voice: true });
      await enterCall(page, size);
      await expect(statusBar(page).locator("[data-testid='voice-widget']")).toBeVisible();
      expect(await barContents(page)).toEqual(["user-bar", "voice-widget"]);
      await expectNoSideScroll(page);
      const user = await boxOf(page, "user-bar");
      const widget = await boxOf(page, "voice-widget");
      expect(user.x).toBeLessThan(widget.x);
      expect(user.width).toBeLessThanOrEqual(240);
      // With the rail showing the user bar drops Switch server; at 640 px the
      // rail is hidden and the button stays.
      const switchServer = statusBar(page).locator("[data-testid='disconnect-btn']");
      if (size === DESKTOP) await expect(switchServer).toBeHidden();
      else await expect(switchServer).toBeVisible();
    });
  }

  for (const size of [MIN_WINDOW, ZOOMED]) {
    test(`the media gallery at ${size.width}x${size.height} stays between the chat header and the status bar`, async ({
      page,
    }) => {
      await startDeck(page, size, { media: true });
      await page.locator("[data-testid='media-btn']").click();
      await expectBetweenHeaderAndBar(page, page.locator(".media-gallery.side-panel"));
    });
  }

  test("an overlay member list sits under the chat header and above the status bar", async ({
    page,
  }) => {
    await startDeck(page, ZOOMED);
    await page.locator("[data-testid='member-list-toggle']").click();
    await expectBetweenHeaderAndBar(page, page.locator("[data-testid='member-column']"));
  });

  test("listen-only with the stats open at 640x400 and Large Font keeps the composer and user bar in view", async ({
    page,
  }) => {
    await startDeck(page, DESKTOP, { largeFont: true, voice: true });
    await enterCall(page, ZOOMED);
    test.skip(!(await setVoiceFlag(page, "setListenOnly")), "needs the dev server's modules");
    await page.locator("[data-testid='vw-signal']").click();
    await expect(statusBar(page).locator(".vw-stats.visible")).toBeVisible();
    await expect(statusBar(page).locator(".vw-grant-mic")).toBeVisible();

    await expect(page.locator("[data-testid='message-input']")).toBeInViewport();
    await expect(page.locator("[data-testid='user-bar']")).toBeInViewport();
    const bar = await boxOf(page, "deck-status-bar");
    expect(bar.y + bar.height).toBeLessThanOrEqual(ZOOMED.height);
    // The bar stops at its 35vh cap and scrolls.
    expect(bar.height).toBeLessThanOrEqual(ZOOMED.height * 0.35 + 1);
  });

  test("a degraded call at 800 px still shows Unsecured, and a normal one hides Secured", async ({
    page,
  }) => {
    await startDeck(page, DESKTOP, { voice: true });
    await enterCall(page, { width: 800, height: 700 });
    const chip = statusBar(page).locator("[data-testid='vw-secured']");
    // The normal chip is visually hidden at this width but still in the page.
    const hidden = (await chip.boundingBox())!;
    expect(hidden.width).toBeLessThanOrEqual(1);
    await expect(chip).toHaveText("Secured");

    test.skip(
      !(await setVoiceFlag(page, "setEncryptionDegraded")),
      "needs the dev server's modules",
    );
    await expect(chip).toHaveText("Unsecured");
    await expect(chip).toBeVisible();
    expect((await chip.boundingBox())!.width).toBeGreaterThan(8);
  });
});
