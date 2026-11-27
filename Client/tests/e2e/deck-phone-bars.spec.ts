/**
 * Command Deck's top bar on a phone (the Developer-mode preview): the Servers
 * button shows the current server's name, every control is 44 x 44, and in
 * the Android app the button opens the Servers sheet, which replaces Switch
 * server in your row. A phone browser has no server tabs, so its name is plain
 * text (the web portal's spec covers it; this harness always draws the tabs).
 *
 * The Pixel 7 profiles run the Android app (the Tauri mock and an Android
 * user agent). All run on Chromium.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MEMBERS_MULTI_ROLE,
  MOCK_VOICE_STATE,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  ROUTE_MESSAGES,
  voiceWsHandlers,
} from "./helpers";
import { findUnnamedControls, focusIndicator } from "./support/accessibility";
import { attachScreenshot, expectControlFits, expectNoPageScroll } from "./support/a11yHarness";
import {
  PIXEL_7,
  PIXEL_7_LANDSCAPE,
  SMALL_PHONE,
  TAB_S4,
  startPhoneDeck,
  type PhoneDeckOptions,
  type PhoneProfile,
} from "./support/phone";
import { boxOf, enterCall, statusBar } from "./support/phoneCall";

const CURRENT = "localhost:8443";
/** Long enough to truncate at 360 px, so the width measured is the room it gets. */
const CURRENT_NAME = "Hangar 9 Community Lounge and Arcade";
const OTHER_NAME = "Night Owls";

const profile = (name: string, host: string) => ({
  id: host,
  name,
  host,
  username: "testuser",
  autoConnect: false,
  rememberPassword: false,
  color: "#5865f2",
  lastConnected: null,
});

/** A voice session with two saved servers, in Gunmetal. */
const SESSION: PhoneDeckOptions = {
  theme: "gunmetal",
  mock: {
    httpRoutes: [ROUTE_HEALTH, ROUTE_LOGIN, ROUTE_MESSAGES],
    simulateWsFlow: true,
    wsHandlers: voiceWsHandlers(),
    readyOverrides: {
      channels: MOCK_CHANNELS_WITH_CATEGORIES,
      members: MOCK_MEMBERS_MULTI_ROLE,
      voice_states: MOCK_VOICE_STATE,
    },
    storedSettings: {
      "owncord:profiles": {
        schemaVersion: 1,
        profiles: [profile(CURRENT_NAME, CURRENT), profile(OTHER_NAME, "night.example:8443")],
      },
    },
  },
};

const topBar = (page: Page): Locator => page.getByTestId("deck-top-bar");
const serversBtn = (page: Page): Locator => page.getByTestId("deck-servers-btn");
const sheet = (page: Page): Locator => page.getByTestId("deck-servers-sheet");
const sheetServer = (page: Page, name: string): Locator =>
  sheet(page).getByTestId("deck-servers-sheet-server").filter({ hasText: name });
const switchDialog = (page: Page): Locator => page.getByTestId("server-switch-dialog");
const chatBox = (page: Page): Locator => page.getByTestId("chat-area").getByTestId("msg-textarea");
const drawer = (page: Page): Locator => page.getByTestId("unified-sidebar");

/** Signs in and waits for the server tabs to fold into the Servers button. */
async function start(page: Page): Promise<void> {
  await startPhoneDeck(page, SESSION);
  await expect(topBar(page)).toHaveClass(/has-server-tabs/);
  await expect(serversBtn(page)).toBeVisible();
  await expect(serversBtn(page).locator(".deck-servers-name")).toHaveText(CURRENT_NAME);
}

/** Every drawn button of `root` that is smaller than 44 x 44, by name. */
async function under44(root: Locator): Promise<string[]> {
  const small: string[] = [];
  for (const button of await root.locator("button").all()) {
    if (!(await button.isVisible())) continue;
    const box = await boxOf(button);
    if (box.width < 43.5 || box.height < 43.5) {
      const name = (await button.getAttribute("aria-label")) ?? (await button.textContent());
      small.push(`${name}: ${box.width}x${box.height}`);
    }
  }
  return small;
}

/** Both bars fit and every control in them is 44 x 44; the name is at least 80 px wide. */
async function expectTopBarFits(page: Page): Promise<void> {
  await expectNoPageScroll(page);
  expect(await under44(topBar(page))).toEqual([]);
  expect(await under44(statusBar(page))).toEqual([]);
  await expectControlFits(serversBtn(page), 44);
  const name = await boxOf(serversBtn(page).locator(".deck-servers-name"));
  expect(name.width).toBeGreaterThanOrEqual(80);
  await expect(serversBtn(page)).toHaveAccessibleName(`Servers, ${CURRENT_NAME}`);
  await expect(serversBtn(page).locator(".deck-servers-text")).toBeHidden();
  await expect(page.getByTestId("deck-top-name")).toBeHidden();
  // The Servers sheet replaces Switch server in your row.
  await expect(statusBar(page).getByTestId("disconnect-btn")).toBeHidden();
  const size = page.viewportSize()!;
  const bar = await boxOf(topBar(page));
  expect(bar.x + bar.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(await findUnnamedControls(topBar(page))).toEqual([]);
  expect(await findUnnamedControls(statusBar(page))).toEqual([]);
}

async function openSheet(page: Page): Promise<void> {
  await serversBtn(page).tap();
  await expect(sheet(page)).toBeVisible();
  await expect(serversBtn(page)).toHaveAttribute("aria-expanded", "true");
}

test.describe("phone Command Deck top bar, 360 x 640", () => {
  test.use(SMALL_PHONE.use);

  test("the bars fit, the Servers button shows the server, and focus shows on it", async ({
    page,
  }, testInfo) => {
    await start(page);
    await expectTopBarFits(page);
    // A single row: the folded tabs leave no second one.
    expect((await boxOf(topBar(page))).height).toBeLessThanOrEqual(45);
    await expect(page.getByTestId("server-tabs")).toBeHidden();
    await serversBtn(page).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(serversBtn(page)).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await attachScreenshot(testInfo, "360 x 640 top bar", page);
  });

  test("the sheet lists the servers, is named, and a pick asks to switch", async ({
    page,
  }, testInfo) => {
    await start(page);
    await openSheet(page);
    await expect(sheet(page).getByTestId("deck-servers-sheet-server")).toHaveCount(2);
    await expect(sheet(page).getByTestId("server-tabs-add-server")).toBeVisible();
    await expect(sheet(page).getByTestId("server-tabs-join")).toBeVisible();
    await expect(sheetServer(page, CURRENT_NAME)).toHaveAttribute("aria-checked", "true");
    expect(await findUnnamedControls(sheet(page))).toEqual([]);
    await attachScreenshot(testInfo, "360 x 640 Servers sheet", page);

    await sheetServer(page, OTHER_NAME).tap();
    await expect(sheet(page)).toBeHidden();
    await expect(switchDialog(page)).toBeVisible();
    await expect(switchDialog(page)).toContainText(OTHER_NAME);
    await page.getByTestId("server-switch-cancel").tap();
    await expect(switchDialog(page)).toBeHidden();
    await expect(serversBtn(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("Back closes only the sheet", async ({ page }) => {
    await start(page);
    await openSheet(page);
    await page.evaluate(() => history.back());
    await expect(sheet(page)).toBeHidden();
    await expect(serversBtn(page)).toHaveAttribute("aria-expanded", "false");
    await expect(drawer(page)).not.toHaveClass(/drawer-open/);
    await expect(page.getByTestId("app-layout")).toBeVisible();
    await expect(serversBtn(page)).toBeFocused();
  });

  test("Server options opens a server's menu, Back closes it, and a move commits", async ({
    page,
  }) => {
    const options = page.getByTestId("deck-servers-options-sheet");
    const openOptions = async (): Promise<void> => {
      await openSheet(page);
      await sheet(page).getByTestId("deck-servers-sheet-server-options").tap();
      await sheet(page)
        .getByTestId("deck-servers-sheet-options-server")
        .filter({ hasText: OTHER_NAME })
        .tap();
      await expect(sheet(page)).toBeHidden();
      await expect(options).toBeVisible();
      await expect(serversBtn(page)).toHaveAttribute("aria-expanded", "true");
    };
    await start(page);
    await openOptions();
    expect(await findUnnamedControls(options)).toEqual([]);
    await page.evaluate(() => history.back());
    await expect(options).toBeHidden();
    await expect(serversBtn(page)).toHaveAttribute("aria-expanded", "false");
    await expect(drawer(page)).not.toHaveClass(/drawer-open/);
    await expect(serversBtn(page)).toBeFocused();

    await openOptions();
    await options.getByTestId("rail-move-up").tap();
    await expect(options).toBeHidden();
    await openSheet(page);
    await expect(sheet(page).getByTestId("deck-servers-sheet-server").first()).toHaveText(
      OTHER_NAME,
    );
  });

  test("opened from the focused message box, the sheet stays open as the keyboard closes", async ({
    page,
  }) => {
    await start(page);
    const size = page.viewportSize()!;
    await chatBox(page).focus();
    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains("composer-typing")))
      .toBe(true);
    // The keyboard is up.
    await page.setViewportSize({ width: size.width, height: size.height - 260 });
    await openSheet(page);
    await expect(chatBox(page)).not.toBeFocused();
    // The keyboard closes: the window grows back, and the sheet stays.
    await page.setViewportSize(size);
    await expect(sheet(page)).toBeVisible();
    await sheetServer(page, OTHER_NAME).tap();
    await expect(sheet(page)).toBeHidden();
    await expect(switchDialog(page)).toBeVisible();
  });

  test("in a call, the bars still fit", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      // As on a real phone: its WebView cannot share a screen.
      Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia");
    });
    await start(page);
    await enterCall(page);
    await expectTopBarFits(page);
    await attachScreenshot(testInfo, "360 x 640 in a call", page);
  });
});

for (const profile of [PIXEL_7, PIXEL_7_LANDSCAPE] as readonly PhoneProfile[]) {
  test.describe(`phone Command Deck top bar, ${profile.name}`, () => {
    test.use(profile.use);

    test("the bars fit and the top bar is one row", async ({ page }, testInfo) => {
      await start(page);
      await expectTopBarFits(page);
      expect((await boxOf(topBar(page))).height).toBeLessThanOrEqual(45);
      await attachScreenshot(testInfo, `${profile.name} top bar`, page);
      await openSheet(page);
      await attachScreenshot(testInfo, `${profile.name} Servers sheet`, page);
    });
  });
}

test.describe("phone Command Deck top bar, a tall tablet", () => {
  test.use(TAB_S4.use);

  test("the tabs fold into the Servers button at 712 x 1138", async ({ page }) => {
    await start(page);
    await expect(page.getByTestId("server-tabs")).toBeHidden();
    await expectTopBarFits(page);
  });
});
