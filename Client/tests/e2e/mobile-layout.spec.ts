/**
 * Touch input: long-press opens the message actions sheet and the channel menu,
 * and a tap on a message shows nothing (the hold is the only way to its
 * actions, as in Discord). The emoji/GIF picker and member profiles open as
 * bottom sheets too.
 *
 * Phone layout (WP 6.13f1): no horizontal scroll, a reachable drawer, a
 * full-width member overlay and 44 px touch targets in the user bar. Both
 * profiles run on Chromium (the iPhone profile's default WebKit is dropped).
 *
 * The drawer on a phone: the server rail on its left, a search
 * button, the Back button (the Pixel 7 profile has an Android user agent and
 * the Tauri mock, which is the Android app; the iPhone profile is a phone
 * browser) and swipes made with touch pointer events.
 */
import { devices, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { Q1, findUnnamedControls, focusIndicator, textContrast } from "./support/accessibility";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
  submitLogin,
  waitForWsReady,
} from "./helpers";

const { defaultBrowserType: _pixelBrowser, ...pixel7 } = devices["Pixel 7"];
const { defaultBrowserType: _iphoneBrowser, ...iphone14 } = devices["iPhone 14"];

const PROFILES = [
  { name: "Pixel 7", use: pixel7 },
  { name: "iPhone 14", use: iphone14 },
];

/** A finger held on `selector`'s centre for `holdMs`, through CDP touch input. */
async function holdFinger(page: Page, selector: string, holdMs: number): Promise<void> {
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

/**
 * A one-finger swipe made of touch pointer events dispatched on the element,
 * the way the app's own gesture code listens for them (no browser gesture or
 * hit-testing involved).
 */
async function swipeOn(
  page: Page,
  selector: string,
  dx: number,
  dy = 0,
  start: { x: number; y: number } | null = null,
): Promise<void> {
  await page.evaluate(
    ({ selector, dx, dy, start }) => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`no element for ${selector}`);
      const box = el.getBoundingClientRect();
      const x0 = start?.x ?? box.left + box.width / 2;
      const y0 = start?.y ?? box.top + box.height / 2;
      const fire = (type: string, x: number, y: number): void => {
        el.dispatchEvent(
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
      fire("pointerdown", x0, y0);
      for (let i = 1; i <= 6; i++) fire("pointermove", x0 + (dx * i) / 6, y0 + (dy * i) / 6);
      fire("pointerup", x0 + dx, y0 + dy);
    },
    { selector, dx, dy, start },
  );
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return Math.max(el.scrollWidth, document.body.scrollWidth) - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const profile of PROFILES) {
  test.describe(`mobile layout, ${profile.name}`, () => {
    test.use(profile.use);

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        buildTauriMockScript({
          httpRoutes: [
            { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
            { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
            { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
            { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
          ],
          simulateWsFlow: true,
        }),
      );
      await page.goto("/");
    });

    test("the connect page does not scroll sideways", async ({ page }) => {
      await expect(page.locator("#host")).toBeVisible();
      await noHorizontalScroll(page);
    });

    test("the saved servers fold away so the sign-in form is on screen", async ({ page }) => {
      const toggle = page.locator("[data-testid='server-panel-toggle']");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".btn-add-server")).toBeHidden();
      // Before any pick the first saved server stays in view.
      await expect(page.locator(".server-item").first()).toBeVisible();
      await expect(page.locator(".connect-form button[type='submit']")).toBeInViewport();

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".btn-add-server")).toBeVisible();
      await page.locator(".server-item").first().click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".server-item.active")).toBeVisible();
      await noHorizontalScroll(page);
    });

    async function signIn(page: Page): Promise<void> {
      await submitLogin(page);
      await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
      await waitForWsReady(page);
      await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
      await expect(page.locator("[data-testid='sidebar-drawer-backdrop']")).toBeAttached();
    }

    test("the main page does not scroll sideways and the drawer reaches the channels", async ({
      page,
    }) => {
      await signIn(page);
      await noHorizontalScroll(page);

      await page.locator("[data-testid='sidebar-toggle']").click();
      const sidebar = page.locator("[data-testid='unified-sidebar']");
      await expect(sidebar).toHaveClass(/drawer-open/);
      const item = sidebar.locator(".channel-list .channel-item").first();
      await expect(item).toBeInViewport();
      const box = await sidebar.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(320);
      await noHorizontalScroll(page);
    });

    test("the header keeps search reachable at 360 px without overflow", async ({ page }) => {
      await signIn(page);
      await page.setViewportSize({ width: 360, height: 740 });
      await expect(page.locator("[data-testid='search-input']")).toBeHidden();
      const search = page.locator("[data-testid='search-btn']");
      await expect(search).toBeVisible();
      const box = await search.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
      await noHorizontalScroll(page);
    });

    test("the search icon opens the search overlay, and typing lands in it", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='search-btn']").tap();
      const input = page.locator("[data-testid='search-overlay-input']");
      await expect(input).toBeFocused();
      await page.keyboard.type("hello");
      await expect(input).toHaveValue("hello");
      await expect(page.locator(".msg-textarea")).toHaveValue("");
    });

    test("the composer clears a gesture bar reported only as the max bottom inset", async ({
      page,
    }) => {
      // Chrome on Android with viewport-fit=cover: content runs under the
      // gesture bar while the dynamic inset can read 0.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 0, left: 0, right: 0, bottom: 0, bottomMax: 24 },
      });
      await signIn(page);
      const composer = await page.locator(".message-input-wrap").boundingBox();
      const viewport = page.viewportSize();
      expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(
        (viewport?.height ?? 0) - 24,
      );
      await cdp.detach();
    });

    test("the drawer's channel rows fill its width", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      const sidebar = await page.locator("[data-testid='unified-sidebar']").boundingBox();
      const row = await page.locator(".channel-list .channel-item").first().boundingBox();
      const gap = (sidebar?.x ?? 0) + (sidebar?.width ?? 0) - ((row?.x ?? 0) + (row?.width ?? 0));
      expect(gap).toBeLessThanOrEqual(16);
    });

    test("the member overlay opens full width", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='member-list-toggle']").click();
      const column = page.locator("#member-column");
      await expect(column).toBeVisible();
      const viewport = page.viewportSize();
      const box = await column.boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
      await noHorizontalScroll(page);
    });

    test("user bar touch targets measure at least 44 px", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      // The Switch server button is not shown on a phone: the rail replaces it.
      const targets = page.locator(
        "[data-testid='user-bar'] .ub-controls button:visible, [data-testid='user-bar-profile']",
      );
      const count = await targets.count();
      expect(count).toBeGreaterThan(1);
      for (let i = 0; i < count; i++) {
        const box = await targets.nth(i).boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    });

    test("settings does not scroll sideways", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await page.locator("button[aria-label='Settings']").click();
      await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
      await noHorizontalScroll(page);
    });

    test("settings shows the section list, then one section with a way back", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await page.locator("button[aria-label='Settings']").click();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await expect(overlay).toHaveClass(/open/);
      const appearance = overlay.locator(".settings-nav-item[role='tab']", {
        hasText: "Appearance",
      });
      await expect(appearance).toBeInViewport();
      await expect(overlay.locator(".settings-content")).toBeHidden();

      await appearance.click();
      await expect(overlay.locator(".settings-content h1")).toHaveText("Appearance");
      await expect(appearance).toBeHidden();
      await noHorizontalScroll(page);

      await overlay.locator("[data-testid='settings-back']").click();
      await expect(appearance).toBeInViewport();
      await expect(overlay).toHaveClass(/open/);
    });

    test("settings has a Keybinds tab only outside the Android app", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await page.locator("button[aria-label='Settings']").click();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await expect(overlay).toHaveClass(/open/);
      await expect(
        overlay.locator(".settings-nav-item[role='tab']", { hasText: "Appearance" }),
      ).toBeInViewport();
      const keybinds = overlay.locator(".settings-nav-item[role='tab']", { hasText: "Keybinds" });
      // The Pixel 7 profile has an Android user agent and the Tauri mock, which is the app.
      await expect(keybinds).toHaveCount(profile.name === "Pixel 7" ? 0 : 1);
    });

    test("My uploads opens its section", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await page.locator("button[aria-label='Settings']").click();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await expect(overlay).toHaveClass(/open/);
      await expect(overlay.locator(".settings-content")).toBeHidden();

      await overlay.locator(".settings-nav-item[role='tab']", { hasText: "My uploads" }).click();
      await expect(overlay.locator(".settings-content h1")).toHaveText("My uploads");
      await expect(overlay.locator("[data-testid='settings-back']")).toBeVisible();
    });

    const android = profile.name === "Pixel 7";
    const drawer = (page: Page) => page.locator("[data-testid='unified-sidebar']");
    const rail = (page: Page) => page.locator("[data-testid='server-rail']");

    test("the drawer shows the server rail on its left, and the rail is not there when it is closed", async ({
      page,
    }) => {
      await signIn(page);
      await expect(rail(page)).toBeHidden();
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      await expect(rail(page)).toBeVisible();

      const railBox = await page.locator(".server-rail-slot").boundingBox();
      const sidebarBox = await drawer(page).boundingBox();
      expect(Math.round(railBox?.x ?? -1)).toBe(0);
      expect(Math.round(railBox?.width ?? 0)).toBe(72);
      // The channel list starts where the rail ends, and the pair fits the screen.
      expect(Math.round(sidebarBox?.x ?? 0)).toBe(72);
      expect((sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0)).toBeLessThanOrEqual(
        page.viewportSize()?.width ?? 0,
      );

      // Direct Messages first, then the servers, then Add a server.
      const home = rail(page).locator("[data-testid='server-rail-home']");
      const server = rail(page).locator("[data-testid='server-rail-server']").first();
      const add = rail(page).locator("[data-testid='server-rail-add']");
      for (const button of [home, server, add]) {
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      const homeY = (await home.boundingBox())?.y ?? 0;
      const serverY = (await server.boundingBox())?.y ?? 0;
      const addY = (await add.boundingBox())?.y ?? 0;
      expect(homeY).toBeLessThan(serverY);
      expect(serverY).toBeLessThan(addY);
      await noHorizontalScroll(page);
    });

    test("the rail's Direct Messages button opens the DM list in the open drawer", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      const home = rail(page).locator("[data-testid='server-rail-home']");
      await home.tap();
      await expect(home).toHaveAttribute("aria-current", "true");
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      // Tapping the connected server's icon goes back to its channels.
      await rail(page).locator("[data-testid='server-rail-server']").first().tap();
      await expect(home).not.toHaveAttribute("aria-current", "true");
      await expect(drawer(page).locator(".channel-list .channel-item").first()).toBeVisible();
    });

    test("the user bar's Switch server button gives way to the rail", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(rail(page)).toBeVisible();
      await expect(page.locator("[data-testid='disconnect-btn']")).toBeHidden();
    });

    test("the search button sits under the server name and opens the quick switcher", async ({
      page,
    }) => {
      await signIn(page);
      const search = page.locator("[data-testid='sidebar-drawer-search']");
      await expect(search).toBeHidden();
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(search).toBeVisible();
      await expect(search).toHaveText("Find or start a conversation");

      const header = await page.locator(".unified-sidebar-header").boundingBox();
      const box = await search.boundingBox();
      const sidebar = await drawer(page).boundingBox();
      expect(box?.y ?? 0).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0) - 1);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      // Full width of the channel column, less its margins.
      expect(box?.width ?? 0).toBeGreaterThan((sidebar?.width ?? 0) - 32);

      await search.tap();
      await expect(page.locator(".quick-switcher-overlay")).toBeVisible();
      await expect(page.locator(".quick-switcher__input")).toBeFocused();
      // The drawer made way for it.
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await noHorizontalScroll(page);
    });

    test("Back closes the drawer opened with the menu button", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      await page.goBack();
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await expect(page.locator("[data-testid='app-layout']")).toBeVisible();
    });

    test("Back closes the member list", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='member-list-toggle']").tap();
      await expect(page.locator("#member-column")).toBeVisible();
      await page.goBack();
      await expect(page.locator("#member-column")).toBeHidden();
      await expect(page.locator("[data-testid='app-layout']")).toBeVisible();
    });

    test("Back closes the sheet before the member list behind it, one press each", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='member-list-toggle']").tap();
      await page.locator("#member-column .member-item").first().tap();
      const sheet = page.locator("[data-testid='profile-sheet']");
      await expect(sheet).toBeVisible();
      await page.goBack();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator("#member-column")).toBeVisible();
      await page.goBack();
      await expect(page.locator("#member-column")).toBeHidden();
      await expect(page.locator("[data-testid='app-layout']")).toBeVisible();
    });

    test("Back on a chat opens the channel list in the Android app only", async ({ page }) => {
      await signIn(page);
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await page.goBack();
      if (android) {
        await expect(drawer(page)).toHaveClass(/drawer-open/);
        await expect(rail(page)).toBeVisible();
        // A further Back with the drawer open leaves the app.
        await page.goBack();
        await expect(page).toHaveURL("about:blank");
      } else {
        // A phone browser has no guard: Back leaves the page at once.
        await expect(page).toHaveURL("about:blank");
      }
    });

    test("in the Android app, Back after reaching a channel from the drawer opens the drawer again", async ({
      page,
    }) => {
      test.skip(!android, "the Back guard is the Android app's");
      await signIn(page);
      await page.goBack();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      await drawer(page).locator(".channel-item", { hasText: "random" }).tap();
      await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("random");
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      // The guard is back: Back opens the drawer, it does not leave.
      await page.goBack();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
    });

    test("in the Android app, a menu-opened drawer closes on Back and leaves the guard intact", async ({
      page,
    }) => {
      test.skip(!android, "the Back guard is the Android app's");
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      await page.goBack();
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await expect(page).not.toHaveURL("about:blank");
      await page.goBack();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
    });

    test("in the Android app, Back closes Settings before anything else", async ({ page }) => {
      test.skip(!android, "the Back guard is the Android app's");
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await page.locator("button[aria-label='Settings']").tap();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await expect(overlay).toHaveClass(/open/);
      await page.goBack();
      await expect(overlay).not.toHaveClass(/open/);
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
    });

    test("swiping right on the chat opens the drawer, and swiping it left closes it", async ({
      page,
    }) => {
      await signIn(page);
      await swipeOn(page, ".chat-header", 120, 4);
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      await expect(rail(page)).toBeVisible();
      await swipeOn(page, "[data-testid='unified-sidebar'] .channel-list", -120, 4);
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
    });

    test("swiping left on the chat opens the member list, and swiping it right closes it", async ({
      page,
    }) => {
      await signIn(page);
      await swipeOn(page, ".chat-header", -120, 4);
      await expect(page.locator("#member-column")).toBeVisible();
      await swipeOn(page, "#member-column .member-item", 120, 4);
      await expect(page.locator("#member-column")).toBeHidden();
    });

    test("a short swipe, a mostly vertical one and one from the composer open nothing", async ({
      page,
    }) => {
      await signIn(page);
      await swipeOn(page, ".chat-header", 30, 2);
      await swipeOn(page, ".chat-header", 100, 100);
      await swipeOn(page, ".msg-textarea", 140, 0);
      await swipeOn(page, ".msg-textarea", -140, 0);
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await expect(page.locator("#member-column")).toBeHidden();
    });

    test("swiping a message left starts a reply once past the threshold", async ({ page }) => {
      await signIn(page);
      const replyBar = page.locator(".reply-bar");
      await expect(replyBar).not.toHaveClass(/visible/);

      // Short of the threshold: the message follows the finger, then springs back.
      await swipeOn(page, "[data-testid='message-101'] .msg-text", -30, 2);
      await expect(page.locator("[data-testid='message-101']")).toHaveCSS("transform", "none");
      await expect(replyBar).not.toHaveClass(/visible/);

      // Mid-swipe the row has moved and the icon is showing.
      await page.evaluate(() => {
        const el = document.querySelector("[data-testid='message-101'] .msg-text");
        if (el === null) throw new Error("no message");
        const box = el.getBoundingClientRect();
        const fire = (type: string, x: number): void => {
          el.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 8,
              pointerType: "touch",
              isPrimary: true,
              clientX: x,
              clientY: box.top + 4,
            }),
          );
        };
        fire("pointerdown", box.left + 200);
        fire("pointermove", box.left + 160);
        (window as unknown as { __swipeLeft: () => void }).__swipeLeft = () =>
          fire("pointerup", box.left + 160);
      });
      await expect(page.locator("[data-testid='msg-swipe-reply']")).toHaveCount(1);
      const moved = await page
        .locator("[data-testid='message-101']")
        .evaluate((el) => (el as HTMLElement).style.transform);
      expect(moved).toBe("translateX(-40px)");
      await page.evaluate(() => (window as unknown as { __swipeLeft: () => void }).__swipeLeft());
      await expect(page.locator("[data-testid='msg-swipe-reply']")).toHaveCount(0);
      await expect(replyBar).not.toHaveClass(/visible/);

      await swipeOn(page, "[data-testid='message-101'] .msg-text", -100, 3);
      await expect(replyBar).toHaveClass(/visible/);
      await expect(page.locator("[data-testid='msg-swipe-reply']")).toHaveCount(0);
    });

    test("a vertical scroll over the messages keeps working", async ({ page }) => {
      await signIn(page);
      await swipeOn(page, "[data-testid='message-101'] .msg-text", 4, -120);
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await expect(page.locator("#member-column")).toBeHidden();
      await expect(page.locator(".reply-bar")).not.toHaveClass(/visible/);
      await expect(page.locator(".messages-container")).toHaveCSS(
        "touch-action",
        "pan-y pinch-zoom",
      );
    });

    test("long-press on a message opens the actions sheet, and only one", async ({ page }) => {
      await signIn(page);
      await holdFinger(page, "[data-testid='message-101'] .msg-text", 800);
      const sheet = page.locator("[data-testid='message-sheet']");
      await expect(sheet).toHaveCount(1);
      await expect(sheet).toBeVisible();
      await expect(page.locator(".message-context-menu")).toHaveCount(0);
      const add = sheet.locator("[data-testid='msg-menu-add-reaction']");
      await expect(add).toBeVisible();
      const box = await add.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
      // The sheet runs edge to edge and sits on the bottom of the screen.
      const panel = await sheet.boundingBox();
      const viewport = page.viewportSize();
      expect(Math.round(panel?.width ?? 0)).toBe(viewport?.width);
      expect(Math.round((panel?.y ?? 0) + (panel?.height ?? 0))).toBe(viewport?.height);
    });

    test("the sheet closes on a backdrop tap and on Back", async ({ page }) => {
      await signIn(page);
      const sheet = page.locator("[data-testid='message-sheet']");
      await holdFinger(page, "[data-testid='message-101'] .msg-text", 800);
      await expect(sheet).toBeVisible();
      await page.locator(".bottom-sheet-overlay").tap({ position: { x: 20, y: 20 } });
      await expect(sheet).toHaveCount(0);

      await holdFinger(page, "[data-testid='message-101'] .msg-text", 800);
      await expect(sheet).toBeVisible();
      await page.evaluate(() => history.back());
      await expect(sheet).toHaveCount(0);
      await expect(page.locator("[data-testid='app-layout']")).toBeVisible();
    });

    test("Add Reaction in the sheet opens a full-width emoji sheet", async ({ page }) => {
      await signIn(page);
      await holdFinger(page, "[data-testid='message-101'] .msg-text", 800);
      await page
        .locator("[data-testid='message-sheet'] [data-testid='msg-menu-add-reaction']")
        .tap();
      await expect(page.locator("[data-testid='message-sheet']")).toHaveCount(0);
      const picker = page.locator("[data-testid='reaction-picker-sheet']");
      await expect(picker).toBeVisible();
      await expect(picker.locator(".ep-search")).toBeVisible();
      const box = await picker.boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(page.viewportSize()?.width);
    });

    test("a short press on a message opens no menu", async ({ page }) => {
      await signIn(page);
      await holdFinger(page, "[data-testid='message-101']", 150);
      await page.waitForTimeout(700);
      await expect(page.locator(".message-context-menu")).toHaveCount(0);
      await expect(page.locator("[data-testid='message-sheet']")).toHaveCount(0);
    });

    test("the composer's emoji button opens the picker as a full-width sheet", async ({ page }) => {
      await signIn(page);
      await page.locator(".emoji-btn").tap();
      const sheet = page.locator("[data-testid='expression-sheet']");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator("[data-testid='xp-tab-emoji']")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const box = await sheet.boundingBox();
      const viewport = page.viewportSize();
      expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
      expect(box?.height ?? 0).toBeGreaterThan((viewport?.height ?? 0) * 0.4);
      await noHorizontalScroll(page);
    });

    test("a tap on a member opens the profile sheet", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='member-list-toggle']").click();
      await page.locator("#member-column .member-item").first().tap();
      const sheet = page.locator("[data-testid='profile-sheet']");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(".upp-username")).toBeVisible();
      const box = await sheet.boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(page.viewportSize()?.width);
    });

    test("long-press on a channel row opens the channel menu", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await expect(page.locator("[data-testid='unified-sidebar']")).toHaveClass(/drawer-open/);
      await holdFinger(page, ".channel-list .channel-item", 800);
      await expect(page.locator("[data-testid='channel-context-menu']")).toBeVisible();
    });

    test("a tap on a message shows no action bar and opens no menu", async ({ page }) => {
      await signIn(page);
      const message = page.locator("[data-testid='message-101']");
      const bar = message.locator(".msg-actions-bar");
      await expect(bar).toHaveCSS("opacity", "0");
      await message.locator(".msg-text").first().tap();
      await page.waitForTimeout(700);
      await expect(bar).toHaveCSS("opacity", "0");
      await expect(page.locator(".message-context-menu")).toHaveCount(0);
      await expect(page.locator("[data-testid='message-sheet']")).toHaveCount(0);
    });
  });
}

for (const profile of PROFILES) {
  test.describe(`mobile calls, ${profile.name}`, () => {
    test.use(profile.use);

    test.beforeEach(async ({ page }) => {
      await mockTauriFullSessionWithVoice(page);
      await page.goto("/");
      await navigateToMainPage(page);
    });

    /** Stand in for the room connecting; the mocked join never reaches it. */
    async function markConnected(page: Page): Promise<void> {
      await page.evaluate(() =>
        (
          window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
        ).__owncord.setVoiceStatus("connected"),
      );
    }

    async function openDrawerAndTapVoice(page: Page): Promise<void> {
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(page.locator("[data-testid='unified-sidebar']")).toHaveClass(/drawer-open/);
      await page.locator(".channel-item.voice", { hasText: "Voice Chat" }).tap();
    }

    test("tapping a voice channel asks first, and joining shows the call bar", async ({ page }) => {
      const bar = page.locator("[data-testid='phone-call-bar']");
      await expect(bar).toBeHidden();

      await openDrawerAndTapVoice(page);
      const sheet = page.locator("[data-testid='voice-join-sheet']");
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("Voice Chat");
      await expect(sheet.locator("[data-testid='join-sheet-count']")).toHaveText(
        "2 people in here",
      );
      // Nothing joined yet.
      await expect(bar).toBeHidden();

      await sheet.getByRole("button", { name: "Join Voice" }).tap();
      await expect(sheet).toHaveCount(0);
      await markConnected(page);

      await expect(page.locator("[data-testid='unified-sidebar']")).not.toHaveClass(/drawer-open/);
      await expect(bar).toBeVisible();
      await expect(bar.locator("[data-testid='pcb-name']")).toHaveText("Voice Chat");
      await expect(bar.locator("[data-testid='pcb-detail']")).toHaveText(
        /^\d+ (person|people) · \d\d:\d\d$/,
      );
      for (const id of ["pcb-mute", "pcb-leave"]) {
        const box = await bar.locator(`[data-testid='${id}']`).boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      await noHorizontalScroll(page);

      await bar.locator("[data-testid='pcb-mute']").tap();
      await expect(bar.locator("[data-testid='pcb-mute']")).toHaveAttribute("aria-pressed", "true");
    });

    test("Leave on the call bar ends the call and hides the bar", async ({ page }) => {
      await openDrawerAndTapVoice(page);
      await page.getByRole("button", { name: "Join Voice" }).tap();
      await markConnected(page);
      const bar = page.locator("[data-testid='phone-call-bar']");
      await expect(bar).toBeVisible();

      await bar.locator("[data-testid='pcb-leave']").tap();
      await expect(bar).toBeHidden();
    });

    test("the join sheet and the call bar meet the shared accessibility checks", async ({
      page,
    }) => {
      await openDrawerAndTapVoice(page);
      const sheet = page.locator("[data-testid='voice-join-sheet']");
      await expect(sheet).toBeVisible();
      expect(await findUnnamedControls(sheet)).toEqual([]);
      expect(
        (await textContrast(sheet.locator("[data-testid='join-sheet-count']"))).ratio,
      ).toBeGreaterThanOrEqual(Q1.text);
      // A keystroke first, so the browser treats the focus as keyboard focus.
      await page.keyboard.press("Shift");
      const join = sheet.getByRole("button", { name: "Join Voice" });
      await join.focus();
      expect((await focusIndicator(page)).problems).toEqual([]);

      await join.tap();
      await markConnected(page);
      const bar = page.locator("[data-testid='phone-call-bar']");
      await expect(bar).toBeVisible();
      expect(await findUnnamedControls(bar)).toEqual([]);
      for (const id of ["pcb-name", "pcb-detail"]) {
        expect(
          (await textContrast(bar.locator(`[data-testid='${id}']`))).ratio,
        ).toBeGreaterThanOrEqual(Q1.text);
      }
      await page.keyboard.press("Shift");
      for (const id of ["pcb-open", "pcb-mute", "pcb-leave"]) {
        await bar.locator(`[data-testid='${id}']`).focus();
        expect((await focusIndicator(page)).problems, id).toEqual([]);
      }
    });

    test("Cancel on the join sheet joins nothing", async ({ page }) => {
      await openDrawerAndTapVoice(page);
      await page.locator("[data-testid='join-sheet-cancel']").tap();
      await expect(page.locator("[data-testid='voice-join-sheet']")).toHaveCount(0);
      await expect(page.locator("[data-testid='phone-call-bar']")).toBeHidden();
      await expect(page.locator("[data-testid='voice-widget']")).not.toBeVisible();
    });
  });
}
