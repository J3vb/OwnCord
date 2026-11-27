/**
 * Mocked E2E: the Screen layout setting (Command Deck preview, Phases 1-3).
 *
 * The setting moves the `layout-deck` class on <html> at load, and deck.css
 * styles the frame from it. A pick in Settings applies on the next reload.
 */

import { devices, type Locator, type Page } from "@playwright/test";
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
import { seedDeckOnce } from "./support/phone";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";
const NOTE = "Applies the next time OwnCord starts or reloads.";

async function seedDeveloperMode(page: Page): Promise<void> {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify(true)), DEV_KEY);
}

const hasDeckClass = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("layout-deck"));

const storedLayout = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown, LAYOUT_KEY);

test.describe("Screen layout", () => {
  test("runs Command Deck at load when it is stored", async ({ page }) => {
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

  test("runs Command Deck at load with Developer mode never set", async ({ page }) => {
    await page.addInitScript(
      (layout) => localStorage.setItem(layout, JSON.stringify("deck")),
      LAYOUT_KEY,
    );
    await startFullSession(page);
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
    expect(await page.evaluate((key) => localStorage.getItem(key), DEV_KEY)).toBeNull();
  });

  test("the row shows with Developer mode off", async ({ page }) => {
    await startFullSession(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await expect(page.locator("[data-testid='screen-layout']")).toBeVisible();
    await expect(page.locator("[data-testid='screen-layout-deck']")).toHaveText("Command Deck");
    await expect(page.locator("[data-testid='screen-layout-restart']")).toHaveCount(0);
  });

  test("Restart now relaunches and Command Deck runs after the reload", async ({ page }) => {
    await startFullSession(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await page.locator("[data-testid='screen-layout-deck']").click();

    const restart = page.locator("[data-testid='screen-layout-restart']");
    await expect(restart).toHaveText("Restart now");
    await restart.click();
    await page.waitForFunction(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.some(
        (e) => e.cmd === "plugin:process|restart",
      ),
    );

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
  });

  test("Clear all cache & restart keeps Command Deck", async ({ page }) => {
    await startFullSession(page);
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await page.locator("[data-testid='screen-layout-deck']").click();
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/layout-deck/);

    await openSettings(page);
    await switchSettingsTab(page, "Advanced");
    const btn = page
      .locator(".setting-row", { hasText: "Clear all cache & restart" })
      .locator("button.ac-btn");
    await btn.click();
    await btn.click();
    await page.waitForFunction(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.some(
        (e) => e.cmd === "plugin:process|restart",
      ),
    );
    expect(await storedLayout(page)).toBe("deck");

    await page.reload();
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
      // With the server tabs showing the user bar drops Switch server; at 640 px
      // the row is folded and the button stays.
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

// ---------------------------------------------------------------------------
// Phase 3c: the top bar
// ---------------------------------------------------------------------------

const TOP_MIN = 36;
const topBar = (page: Page) => page.locator("[data-testid='deck-top-bar']");

test.describe("Command Deck top bar", () => {
  test("at 1333x934 it shows the server name, search and the connection state", async ({
    page,
  }) => {
    await startDeck(page, DESKTOP);
    await expect(topBar(page)).toBeVisible();
    const name = topBar(page).locator("[data-testid='deck-top-name']");
    await expect(name).not.toHaveText("");
    await expect(topBar(page).locator("[data-testid='deck-search']")).toHaveAccessibleName(
      "Search messages",
    );
    await expect(topBar(page).locator("[data-testid='deck-connection']")).toHaveText("Connected");

    // Name left, search centred, state right; the bar is the page's first row.
    const [n, s, c] = await Promise.all([
      boxOf(page, "deck-top-name"),
      boxOf(page, "deck-search"),
      boxOf(page, "deck-connection"),
    ]);
    expect(n.x + n.width).toBeLessThanOrEqual(s.x + 0.5);
    expect(s.x + s.width).toBeLessThanOrEqual(c.x + 0.5);
    expect(Math.abs(s.x + s.width / 2 - DESKTOP.width / 2)).toBeLessThanOrEqual(40);
    const bar = await boxOf(page, "deck-top-bar");
    expect(bar.y).toBe(0);
    expect(bar.height).toBeGreaterThanOrEqual(TOP_MIN);
    const app = await boxOf(page, "app-layout");
    expect(app.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  });

  test("clicking search opens the chat search", async ({ page }) => {
    await startDeck(page, DESKTOP);
    await expect(page.locator("[data-testid='search-overlay']")).toHaveCount(0);
    await page.locator("[data-testid='deck-search']").click();
    await expect(page.locator("[data-testid='search-overlay']")).toBeVisible();
    await expect(page.locator("[data-testid='search-overlay-input']")).toBeVisible();
  });

  test("at 640x400 with Large Font the composer stays in view", async ({ page }) => {
    await startDeck(page, ZOOMED, { largeFont: true });
    await expect(topBar(page)).toBeVisible();
    expect((await boxOf(page, "deck-top-bar")).height).toBeGreaterThanOrEqual(TOP_MIN);
    await expect(page.locator("[data-testid='message-input']")).toBeInViewport();
    await expect(page.locator("[data-testid='user-bar']")).toBeInViewport();
  });
});

const THEME_KEY = "owncord:theme:active";
const LEVEL_KEY = "owncord:settings:notificationLevel";

/** The raw stored values the new-install settle decides on. */
const storedDefaults = (page: Page): Promise<Record<string, string | null>> =>
  page.evaluate(
    (keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])),
    [LAYOUT_KEY, THEME_KEY, LEVEL_KEY],
  );

test.describe("New-install defaults", () => {
  test.use({ screenLayout: "fresh" });

  test("an empty profile starts on Command Deck and Gunmetal", async ({ page }) => {
    await startFullSession(page);
    await expect(page.locator("html")).toHaveClass(/layout-deck/);
    await expect(page.locator("body")).toHaveClass(/theme-gunmetal/);
    expect(await storedDefaults(page)).toEqual({
      [LAYOUT_KEY]: JSON.stringify("deck"),
      [THEME_KEY]: "gunmetal",
      [LEVEL_KEY]: JSON.stringify("mentions"),
    });
  });

  test("a store from an older release keeps Classic and its theme, across a reload", async ({
    page,
  }) => {
    // Seeded once: a reload must find what the first load left, so a theme
    // the app lost is not written back by the seed.
    await page.addInitScript(
      ([level, theme]) => {
        if (sessionStorage.getItem("old-release-seeded") !== null) return;
        sessionStorage.setItem("old-release-seeded", "1");
        localStorage.setItem(level, JSON.stringify("all"));
        localStorage.setItem(theme, "light");
      },
      [LEVEL_KEY, THEME_KEY] as const,
    );
    await startFullSession(page);
    await expect(page.locator("body")).toHaveClass(/theme-light/);
    expect(await hasDeckClass(page)).toBe(false);
    const upgraded = {
      [LAYOUT_KEY]: JSON.stringify("classic"),
      [THEME_KEY]: "light",
      [LEVEL_KEY]: JSON.stringify("all"),
    };
    expect(await storedDefaults(page)).toEqual(upgraded);

    await page.reload();
    await expect(page.locator("body")).toHaveClass(/theme-light/);
    expect(await hasDeckClass(page)).toBe(false);
    expect(await storedDefaults(page)).toEqual(upgraded);
  });

  test.describe("on a phone-sized browser", () => {
    // The iPhone profile is a phone browser; an Android user agent with the
    // Tauri mock would be the Android app, which stores no layout.
    const { defaultBrowserType: _iphoneBrowser, ...iphone14 } = devices["iPhone 14"];
    test.use(iphone14);

    test("runs Classic on Gunmetal and stores Classic", async ({ page }) => {
      await startFullSession(page);
      await expect(page.locator("body")).toHaveClass(/theme-gunmetal/);
      expect(await hasDeckClass(page)).toBe(false);
      expect(await storedDefaults(page)).toEqual({
        [LAYOUT_KEY]: JSON.stringify("classic"),
        [THEME_KEY]: "gunmetal",
        [LEVEL_KEY]: JSON.stringify("mentions"),
      });
    });
  });
});
