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
 * The call screen on a phone: 44 px controls with Chat and Leave, tap to focus a
 * tile, full screen with Back, and a full-screen ring for a DM call. In the
 * Android app a call also has a sound route button (speaker, earpiece, a
 * headset) and pauses while a phone call holds the phone's audio.
 *
 * The drawer on a phone: the server rail on its left, a search
 * button, the Back button (the Pixel 7 profile has an Android user agent and
 * the Tauri mock, which is the Android app; the iPhone profile is a phone
 * browser) and swipes made with touch pointer events.
 */
import { devices, type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { Q1, findUnnamedControls, focusIndicator, textContrast } from "./support/accessibility";
import {
  buildTauriMockScript,
  connectVoiceSession,
  dmChannel,
  emitWsMessage,
  mockTauriFullSessionWithSessions,
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
  parkLiveKitSocket,
  voiceJoinWithTokenHandlers,
  waitForWsReady,
  BASE_SESSION_ROUTES,
  navigateToMainPageReady,
} from "./helpers";
import { callLog, mountCallGrid } from "./support/callGrid";

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

/**
 * What the Android app's call audio reports from here on (the Tauri mock's
 * plugin): the phone's routes, the one in use, a phone call holding the audio.
 * A phone browser has no host that listens to it.
 */
async function reportCallAudio(page: Page, state: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as { __mobileAudioPush(s: unknown): void }).__mobileAudioPush(s),
    state,
  );
}

/** The call audio commands the page has sent its host, in order. */
function callAudioCommands(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __invokeLog: Array<{ cmd: string; args?: unknown }> }).__invokeLog
      .filter((e) => e.cmd === "mobile_audio_set_session" || e.cmd === "mobile_audio_set_route")
      .map((e) => `${e.cmd} ${JSON.stringify(e.args)}`),
  );
}

/** What the page has sent its host's call service, in order: the call states
 *  (`states`), or what its notification was told to say with each (`faces`). */
function callServiceCalls(page: Page, part: "states" | "faces"): Promise<unknown[]> {
  return page.evaluate(
    (wanted) =>
      (window as unknown as { __invokeLog: Array<{ cmd: string; args?: unknown }> }).__invokeLog
        .filter((e) => e.cmd === "set_call_service")
        .map((e) => {
          const { face, ...state } = e.args as Record<string, unknown>;
          return wanted === "faces" ? face : state;
        }),
    part,
  );
}

const callServiceStates = (page: Page): Promise<unknown[]> => callServiceCalls(page, "states");

/** How far apart the visible round controls of a call's control row sit
 *  vertically: under a pixel when they share one row. */
function controlRowSpread(bar: Locator): Promise<number> {
  return bar.evaluate((el) => {
    const centres = [...el.querySelectorAll<HTMLElement>("[data-call-control]")]
      .map((control) => control.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .map((box) => box.top + box.height / 2);
    return Math.max(...centres) - Math.min(...centres);
  });
}

/** Join the voice channel on a phone and open its call view. */
async function joinAndOpenCallView(page: Page): Promise<void> {
  await mockTauriFullSessionWithVoice(page);
  await page.goto("/");
  await navigateToMainPage(page);
  await page.locator("[data-testid='sidebar-toggle']").tap();
  await page.locator(".channel-item.voice", { hasText: "Voice Chat" }).tap();
  await page.getByRole("button", { name: "Join Voice" }).tap();
  await page.evaluate(() =>
    (
      window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
    ).__owncord.setVoiceStatus("connected"),
  );
  await page.locator("[data-testid='phone-call-bar'] [data-testid='pcb-open']").tap();
  await expect(page.locator("[data-testid='video-grid']")).toBeVisible();
}

for (const profile of PROFILES) {
  test.describe(`mobile layout, ${profile.name}`, () => {
    test.use(profile.use);

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        buildTauriMockScript({
          httpRoutes: [
            ...BASE_SESSION_ROUTES,
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
      await navigateToMainPageReady(page);
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

    test("an open settings section keeps its title, Back and Close on an opaque bar", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await page.locator("button[aria-label='Settings']").click();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await overlay.locator(".settings-nav-item[role='tab']", { hasText: "Appearance" }).click();
      const title = overlay.locator(".settings-content h1");
      await expect(title).toHaveText("Appearance");
      await overlay.locator(".settings-content").evaluate((el) => {
        el.scrollTop = 400;
      });
      await expect(title).toBeInViewport();
      const bar = await page.evaluate(() => {
        const h1 = document.querySelector<HTMLElement>(".settings-content h1")!;
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const back = box("[data-testid='settings-back']");
        const close = box(".settings-close-btn");
        const text = document.createRange();
        text.selectNodeContents(h1);
        const words = text.getBoundingClientRect();
        // Under the bar beside its buttons, the scrolled content stays hidden.
        const middle = window.innerWidth / 2;
        const hit = [back.top + 2, back.bottom - 2].map((y) => {
          const el = document.elementFromPoint(middle, y);
          return el !== null && (el === h1 || h1.contains(el));
        });
        return {
          bar: h1.getBoundingClientRect().toJSON() as DOMRect,
          back: back.toJSON() as DOMRect,
          close: close.toJSON() as DOMRect,
          words: words.toJSON() as DOMRect,
          hit,
          opaque: getComputedStyle(h1).backgroundColor !== "rgba(0, 0, 0, 0)",
        };
      });
      expect(bar.opaque).toBe(true);
      expect(bar.hit).toEqual([true, true]);
      expect(bar.bar.top).toBeLessThanOrEqual(0);
      for (const button of [bar.back, bar.close]) {
        expect(button.width).toBeGreaterThanOrEqual(44);
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.top).toBeGreaterThanOrEqual(bar.bar.top);
        expect(button.bottom).toBeLessThanOrEqual(bar.bar.bottom);
      }
      expect(bar.words.left).toBeGreaterThanOrEqual(bar.back.right);
      expect(bar.words.right).toBeLessThanOrEqual(bar.close.left);
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
      // As on the desktop, DMs live behind Home, not above the channel list.
      await expect(drawer(page).locator(".channel-list .channel-item").first()).toBeVisible();
      const dmSection = drawer(page).locator(".sidebar-dm-section");
      await expect(dmSection).toHaveCount(1);
      await expect(dmSection).toBeHidden();
      await expect(drawer(page).locator(".unified-sidebar-header .server-icon-sm")).toBeHidden();
      const home = rail(page).locator("[data-testid='server-rail-home']");
      await home.tap();
      await expect(home).toHaveAttribute("aria-current", "true");
      await expect(drawer(page)).toHaveClass(/drawer-open/);
      await expect(drawer(page).getByTestId("dm-phone-head")).toBeVisible();
      // Tapping the connected server's icon goes back to its channels.
      await rail(page).locator("[data-testid='server-rail-server']").first().tap();
      await expect(home).not.toHaveAttribute("aria-current", "true");
      await expect(drawer(page).locator(".channel-list .channel-item").first()).toBeVisible();
    });

    test("Direct Messages puts People behind the drawer, and its menu button reopens it", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await rail(page).locator("[data-testid='server-rail-home']").tap();
      await expect(drawer(page).getByTestId("dm-phone-head")).toBeVisible();
      await page
        .locator("[data-testid='sidebar-drawer-backdrop']")
        .tap({ position: { x: 380, y: 300 } });
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);

      await expect(page.getByTestId("people-home")).toBeVisible();
      await expect(page.getByTestId("chat-area")).toBeHidden();
      // Active now needs the room a phone does not have.
      await expect(page.getByTestId("people-active")).toBeHidden();
      await noHorizontalScroll(page);
      await page.getByTestId("feature-view-menu").tap();
      await expect(drawer(page)).toHaveClass(/drawer-open/);
    });

    test("Home turns the drawer into Messages, with search, People and New message", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await rail(page).locator("[data-testid='server-rail-home']").tap();
      const head = drawer(page).getByTestId("dm-phone-head");
      await expect(head.getByRole("heading", { name: "Messages" })).toBeVisible();
      await expect(drawer(page).locator(".unified-sidebar-header")).toBeHidden();
      await expect(page.getByTestId("sidebar-drawer-search")).toBeHidden();
      await expect(page.getByTestId("dm-back-header")).toBeHidden();
      await expect(page.getByTestId("dm-people-entry")).toBeHidden();
      await noHorizontalScroll(page);

      const find = drawer(page).locator(".dm-search");
      await expect(find).toBeHidden();
      await head.getByTestId("dm-phone-search").tap();
      await expect(find).toBeFocused();
      await expect(head.getByTestId("dm-phone-search")).toHaveAttribute("aria-expanded", "true");

      await head.getByTestId("dm-phone-people").tap();
      await expect(drawer(page)).not.toHaveClass(/drawer-open/);
      await expect(page.getByTestId("people-home")).toBeVisible();

      // Back on a server, the server header returns.
      await page.getByTestId("feature-view-menu").tap();
      await rail(page).locator("[data-testid='server-rail-server']").first().tap();
      await expect(drawer(page).locator(".unified-sidebar-header")).toBeVisible();
      await expect(page.getByTestId("dm-phone-head")).toHaveCount(0);
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
      // An open section goes back to the list first, as Escape does.
      await page.locator("#settings-tab-appearance").tap();
      await expect(overlay.locator(".settings-panel")).toHaveClass(/settings-panel--section/);
      await page.goBack();
      await expect(overlay).toHaveClass(/open/);
      await expect(overlay.locator(".settings-panel")).not.toHaveClass(/settings-panel--section/);
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

    test("the composer's + opens the attach sheet, and Take photo asks for the camera", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator(".attach-btn").tap();
      const sheet = page.locator("[data-testid='attach-sheet']");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(".attach-sheet-tile")).toHaveText([
        "Take photo",
        "Gallery",
        "Files",
      ]);
      await noHorizontalScroll(page);

      const chooser = page.waitForEvent("filechooser");
      await sheet.locator("[data-testid='attach-sheet-camera']").tap();
      const input = (await chooser).element();
      expect(await input.getAttribute("accept")).toBe("image/*");
      expect(await input.getAttribute("capture")).toBe("environment");
      await expect(sheet).toHaveCount(0);
    });

    test("the composer row is +, the text, GIF, emoji and send, with room to type", async ({
      page,
    }) => {
      await signIn(page);
      const row = page.locator(".message-input-box");
      for (const hidden of [".sticker-btn", ".poll-btn"]) {
        await expect(row.locator(hidden)).toBeHidden();
      }
      for (const shown of [".attach-btn", ".gif-btn", ".emoji-btn", ".send-btn"]) {
        await expect(row.locator(shown)).toBeVisible();
      }
      const text = await row.locator(".msg-textarea").boundingBox();
      const viewport = page.viewportSize();
      // Four controls share the row with the text (the mic and send take
      // turns), so the text keeps at least two fifths of the screen.
      expect(text?.width ?? 0).toBeGreaterThan((viewport?.width ?? 0) * 0.4);
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

    test("long-press on a channel row opens the channel menu as a sheet", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await expect(page.locator("[data-testid='unified-sidebar']")).toHaveClass(/drawer-open/);
      await holdFinger(page, ".channel-list .channel-item", 800);
      const sheet = page.locator("[data-testid='channel-sheet']");
      await expect(sheet).toBeVisible();
      await expect(page.locator("[data-testid='channel-context-menu']")).toHaveCount(0);
      // The sheet runs edge to edge and sits on the bottom of the screen.
      const box = await sheet.boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(page.viewportSize()?.width);
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(page.viewportSize()?.height);
      // Rows are 44 px or more to hit.
      for (const id of ["ctx-mute-channel", "ctx-notify-settings"]) {
        const row = await sheet.locator(`[data-testid='${id}']`).boundingBox();
        expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    });

    test("Mute Channel in the channel sheet opens a second page, and the back arrow returns", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await holdFinger(page, ".channel-list .channel-item", 800);
      const sheet = page.locator("[data-testid='channel-sheet']");
      await expect(sheet).toBeVisible();

      await sheet.locator("[data-testid='ctx-mute-channel']").tap();
      await expect(sheet.locator("[data-testid='menu-sheet-back']")).toBeVisible();
      await expect(sheet.locator("[data-testid='ctx-mute-for-3600000']")).toBeVisible();
      await expect(sheet.locator("[data-testid='ctx-mute-channel']")).toHaveCount(0);

      await sheet.locator("[data-testid='menu-sheet-back']").tap();
      await expect(sheet.locator("[data-testid='ctx-mute-channel']")).toBeVisible();
      await expect(sheet.locator("[data-testid='menu-sheet-back']")).toHaveCount(0);

      await sheet.locator("[data-testid='ctx-notify-settings']").tap();
      await expect(sheet.locator("[role='radio']")).toHaveCount(4);
      await sheet.locator("[data-testid='ctx-notify-nothing']").tap();
      await expect(sheet).toHaveCount(0);
    });

    test("the server name opens the server menu as a sheet", async ({ page }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      await page.locator("button[data-testid='server-name']").tap();
      const sheet = page.locator("[data-testid='server-sheet']");
      await expect(sheet).toBeVisible();
      await expect(page.locator(".server-menu")).toHaveCount(0);
      await expect(sheet.locator("[data-testid='server-menu-notifications']")).toBeVisible();
      await page.locator(".bottom-sheet-overlay").tap({ position: { x: 20, y: 20 } });
      await expect(sheet).toHaveCount(0);
    });

    test("the status dot opens the profile card as a sheet, the one status menu", async ({
      page,
    }) => {
      await signIn(page);
      await page.locator("[data-testid='sidebar-toggle']").click();
      // The dot is part of the profile button: a tap on it lands on the button.
      const dot = page.locator("[data-testid='user-bar-status-dot']");
      const box = await dot.boundingBox();
      expect(box).not.toBeNull();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      const sheet = page.locator("[data-testid='self-profile-sheet']");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator("[role='menuitemradio']")).toHaveCount(4);
      await expect(sheet.locator("[data-testid='spc-status-online']")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(sheet.locator("[data-testid='spc-clear-after']")).toBeVisible();
      await sheet.locator("[data-testid='spc-status-idle']").tap();
      await expect(sheet).toHaveCount(0);
      await expect(dot).toHaveCSS("background-color", /rgb\(/);
    });

    test("a message's header shows the time alone, with the full date on hover", async ({
      page,
    }) => {
      await signIn(page);
      const time = page.locator("[data-testid='message-101'] .msg-time");
      await expect(time).toBeVisible();
      // "10:00 AM" or "10:00": no day word and no date.
      await expect(time).toHaveText(/^\d{1,2}:\d{2}( [AP]M)?$/);
      await expect(time).toHaveAttribute("title", /March 15, 2026|15 March 2026/);
    });

    test("reaction chips and the menu rows are 44 px to hit", async ({ page }) => {
      await signIn(page);
      await page.evaluate(() => {
        const chip = document.createElement("button");
        chip.className = "reaction-chip add-reaction";
        chip.dataset["testid"] = "probe-chip";
        chip.textContent = "+";
        document.body.appendChild(chip);
        const menu = document.createElement("div");
        menu.className = "context-menu";
        menu.style.cssText = "top:0;left:0";
        menu.innerHTML = '<button class="context-menu-item" data-testid="probe-row">Row</button>';
        document.body.appendChild(menu);
      });
      for (const id of ["probe-chip", "probe-row"]) {
        const box = await page.locator(`[data-testid='${id}']`).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      expect(
        (await page.locator("[data-testid='probe-chip']").boundingBox())?.width ?? 0,
      ).toBeGreaterThanOrEqual(44);
    });

    // A phone on its side: wider than 800 px, but short. Not the desktop layout.
    const landscape =
      profile.name === "Pixel 7" ? { width: 915, height: 412 } : { width: 844, height: 390 };

    test("a phone turned sideways keeps the drawer, not the desktop sidebar", async ({ page }) => {
      await signIn(page);
      await page.setViewportSize(landscape);
      const toggle = page.locator("[data-testid='sidebar-toggle']");
      await expect(toggle).toBeVisible();
      const sidebar = page.locator("[data-testid='unified-sidebar']");
      await expect(sidebar).toHaveCSS("width", "0px");
      await expect(page.locator("[data-testid='server-rail']")).toBeHidden();
      await noHorizontalScroll(page);

      await toggle.tap();
      await expect(sidebar).toHaveClass(/drawer-open/);
      const box = await sidebar.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(150);
      expect(box?.width ?? 0).toBeLessThanOrEqual(350);
      await expect(page.locator("[data-testid='server-rail']")).toBeVisible();
      await expect(sidebar.locator(".channel-list .channel-item").first()).toBeInViewport();
      await noHorizontalScroll(page);

      await page
        .locator("[data-testid='sidebar-drawer-backdrop']")
        .tap({ position: { x: 600, y: 200 } });
      await expect(sidebar).not.toHaveClass(/drawer-open/);
    });

    test("a phone turned sideways gets the member list as an overlay", async ({ page }) => {
      await signIn(page);
      await page.setViewportSize(landscape);
      await page.locator("[data-testid='member-list-toggle']").tap();
      const column = page.locator("#member-column");
      await expect(column).toBeVisible();
      await expect(column).toHaveCSS("position", "fixed");
      // Over the chat, not squeezing it: the chat keeps nearly its whole width.
      const chat = await page.getByTestId("chat-area").boundingBox();
      expect(chat?.width ?? 0).toBeGreaterThan(landscape.width - 40);
      await noHorizontalScroll(page);
    });

    test("a phone turned sideways keeps Settings as a list and a section", async ({ page }) => {
      await signIn(page);
      await page.setViewportSize(landscape);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await page.locator("button[aria-label='Settings']").tap();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await expect(overlay).toHaveClass(/open/);
      const appearance = overlay.locator(".settings-nav-item[role='tab']", {
        hasText: "Appearance",
      });
      await expect(overlay.locator(".settings-content")).toBeHidden();
      await appearance.tap();
      await expect(overlay.locator(".settings-content h1")).toHaveText("Appearance");
      await overlay.locator("[data-testid='settings-back']").tap();
      await expect(appearance).toBeVisible();
      await noHorizontalScroll(page);
    });

    test("turning the phone sideways and back swaps the layout both ways", async ({ page }) => {
      await signIn(page);
      const portrait = page.viewportSize()!;
      await page.setViewportSize(landscape);
      await expect(page.locator("[data-testid='unified-sidebar']")).toHaveCSS("width", "0px");
      await page.setViewportSize(portrait);
      await expect(page.locator("[data-testid='sidebar-toggle']")).toBeVisible();
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(page.locator("[data-testid='unified-sidebar']")).toHaveClass(/drawer-open/);
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

      // The Android app's "in a call" notification follows the mute: its
      // words, and the button that lifts it. A phone browser has none.
      const faces = (): Promise<unknown[]> => callServiceCalls(page, "faces");
      if (profile.name !== "Pixel 7") {
        expect(await faces()).toEqual([]);
        return;
      }
      const live = { mic: "live", text: "In a call", micLabel: "Mute", leaveLabel: "Leave" };
      const muted = { ...live, mic: "muted", text: "In a call, muted", micLabel: "Unmute" };
      await expect.poll(faces).toEqual([live, live, muted]);
    });

    test("the call bar shows on a phone turned sideways", async ({ page }) => {
      await page.setViewportSize(
        profile.name === "Pixel 7" ? { width: 915, height: 412 } : { width: 844, height: 390 },
      );
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await expect(page.locator("[data-testid='unified-sidebar']")).toHaveClass(/drawer-open/);
      await page.locator(".channel-item.voice", { hasText: "Voice Chat" }).tap();
      await page.getByRole("button", { name: "Join Voice" }).tap();
      await markConnected(page);
      const bar = page.locator("[data-testid='phone-call-bar']");
      await expect(bar).toBeVisible();
      await expect(bar.locator("[data-testid='pcb-name']")).toHaveText("Voice Chat");
      await noHorizontalScroll(page);
    });

    test("Leave on the call bar ends the call and hides the bar", async ({ page }) => {
      await openDrawerAndTapVoice(page);
      await page.getByRole("button", { name: "Join Voice" }).tap();
      await markConnected(page);
      const bar = page.locator("[data-testid='phone-call-bar']");
      await expect(bar).toBeVisible();

      await bar.locator("[data-testid='pcb-leave']").tap();
      await expect(bar).toBeHidden();

      // The Android app keeps the call alive in the background with a host
      // service from join to leave, and says "no call" as the page starts; a
      // phone browser has no host to ask.
      const noCall = { active: false, camera: false, videoOnScreen: false };
      const expected =
        profile.name === "Pixel 7"
          ? [noCall, { active: true, camera: false, videoOnScreen: false }, noCall]
          : [];
      await expect.poll(() => callServiceStates(page)).toEqual(expected);
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

    test("a phone call pauses the call in the Android app, and it comes back by itself", async ({
      page,
    }) => {
      await openDrawerAndTapVoice(page);
      await page.getByRole("button", { name: "Join Voice" }).tap();
      await markConnected(page);
      const bar = page.locator("[data-testid='phone-call-bar']");
      const detail = bar.locator("[data-testid='pcb-detail']");
      const hint = bar.locator("[data-testid='pcb-hint']");
      const mute = bar.locator("[data-testid='pcb-mute']");
      const running = /^\d+ (person|people) · \d\d:\d\d$/;
      await expect(bar).toBeVisible();
      await expect(detail).toHaveText(running);
      await expect(hint).toBeHidden();

      // A phone call is answered.
      await reportCallAudio(page, { supported: true, interrupted: true });
      if (profile.name !== "Pixel 7") {
        // A phone browser has no host to tell it: nothing pauses.
        await expect(detail).toHaveText(running);
        await expect(bar).not.toHaveClass(/phone-call-bar--paused/);
        await expect(hint).toBeHidden();
        await expect(mute).toBeEnabled();
        expect(await callAudioCommands(page)).toEqual([]);
        return;
      }
      await expect(bar).toHaveClass(/phone-call-bar--paused/);
      await expect(detail).toHaveText(/^Paused for a phone call · \d\d:\d\d$/);
      await expect(hint).toHaveText("Your mic and sound come back when the phone call ends.");
      // The mic is closed and not the user's to open; Leave still is.
      await expect(mute).toBeDisabled();
      await expect(mute).toHaveAttribute("aria-label", "Muted while paused");
      await expect(bar.locator("[data-testid='pcb-leave']")).toBeEnabled();
      // The hint has its own line under the row, inside the bar.
      const barBox = (await bar.boundingBox())!;
      const hintBox = (await hint.boundingBox())!;
      const muteBox = (await mute.boundingBox())!;
      expect(hintBox.y).toBeGreaterThanOrEqual(muteBox.y + muteBox.height);
      expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(barBox.y + barBox.height);
      expect(muteBox.width).toBeGreaterThanOrEqual(44);
      expect(muteBox.height).toBeGreaterThanOrEqual(44);
      for (const text of [bar.locator("[data-testid='pcb-name']"), detail, hint]) {
        expect((await textContrast(text)).ratio).toBeGreaterThanOrEqual(Q1.text);
      }
      expect(await findUnnamedControls(bar)).toEqual([]);
      await noHorizontalScroll(page);

      // The phone call ends: the call is as it was before, with the mic the
      // user's own again and not muted.
      await reportCallAudio(page, { interrupted: false });
      await expect(bar).not.toHaveClass(/phone-call-bar--paused/);
      await expect(detail).toHaveText(running);
      await expect(hint).toBeHidden();
      await expect(mute).toBeEnabled();
      await expect(mute).toHaveAttribute("aria-pressed", "false");
      await expect(mute).toHaveAttribute("aria-label", "Mute");

      // The host is told that no call runs when the app starts (it outlives a
      // reload of the page), then follows the phone's audio from join to leave.
      await bar.locator("[data-testid='pcb-leave']").tap();
      await expect(bar).toBeHidden();
      await expect
        .poll(() => callAudioCommands(page))
        .toEqual([
          'mobile_audio_set_session {"active":false}',
          'mobile_audio_set_session {"active":true}',
          'mobile_audio_set_session {"active":false}',
        ]);
    });
  });
}

for (const profile of PROFILES) {
  test.describe(`mobile call screen, ${profile.name}`, () => {
    test.use(profile.use);

    const STREAMS = [
      { id: 3, name: "member1" },
      { id: 4, name: "member2" },
      { id: 1002, name: "moderator1", screenshare: true },
    ] as const;
    const tile = (page: Page, id: number) =>
      page.locator(`#call-grid-host .video-cell[data-user-id='${id}']`);

    test("the call view has 44 px controls in one row, and Chat and Leave work", async ({
      page,
    }) => {
      await joinAndOpenCallView(page);
      const bar = page.locator("[data-testid='video-grid'] .video-grid__controls");
      await expect(bar).toBeVisible();
      for (const id of ["mute", "deafen", "camera", "chat", "leave"]) {
        const box = await bar.locator(`[data-call-control='${id}']`).boundingBox();
        expect(box?.width ?? 0, id).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44);
      }
      // The camera menu is the desktop's way to pick a device: flip is the phone's.
      await expect(bar.locator("[data-call-control='camera-device']")).toBeHidden();
      expect(await controlRowSpread(bar)).toBeLessThan(1);
      const barBox = (await bar.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(barBox.x).toBeGreaterThanOrEqual(0);
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewport.width);
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(viewport.height);
      await noHorizontalScroll(page);
      expect(await findUnnamedControls(bar)).toEqual([]);

      // Chat goes back to the text channel with the call still up.
      await bar.locator("[data-call-control='chat']").tap();
      await expect(page.locator("[data-testid='video-grid']")).toBeHidden();
      await expect(page.locator("[data-testid='phone-call-bar']")).toBeVisible();

      await page.locator("[data-testid='pcb-open']").tap();
      await expect(bar).toBeVisible();
      await bar.locator("[data-call-control='leave']").tap();
      await expect(page.locator("[data-testid='phone-call-bar']")).toBeHidden();
    });

    test("Push to talk in the Android app: a hold-to-talk button opens the mic while held", async ({
      page,
    }) => {
      await page.addInitScript(() =>
        localStorage.setItem("owncord:settings:inputMode", JSON.stringify("ptt")),
      );
      await joinAndOpenCallView(page);
      const call = page.locator("[data-testid='talk-button-call']");
      if (profile.name !== "Pixel 7") {
        // A phone browser has no talk button: Push to talk is the app's.
        await expect(call).toHaveCount(0);
        return;
      }
      await expect(call).toBeVisible();
      const box = (await call.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(56);
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      await expect(call).toHaveAttribute("aria-pressed", "false");
      const label = call.locator(".talk-btn__label");
      expect((await textContrast(label)).ratio).toBeGreaterThanOrEqual(Q1.text);
      expect(
        await findUnnamedControls(page.locator("[data-testid='video-grid'] .video-grid__controls")),
      ).toEqual([]);

      await call.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
      await expect(call).toHaveAttribute("aria-pressed", "true");
      await expect(call).toHaveClass(/talking/);
      expect((await textContrast(label)).ratio).toBeGreaterThanOrEqual(Q1.text);
      await call.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", button: 0 });
      await expect(call).toHaveAttribute("aria-pressed", "false");
      await expect(call).not.toHaveClass(/talking/);

      // The call bar has one too, beside Mute.
      await page.locator("[data-call-control='chat']").tap();
      await expect(page.locator("[data-testid='talk-button-bar']")).toBeVisible();
    });

    test("a stream on screen in a call keeps the Android app's screen on, until the picture goes", async ({
      page,
    }) => {
      await joinAndOpenCallView(page);
      test.skip(!(await mountCallGrid(page, STREAMS)), "needs the dev server's modules");
      await expect(tile(page, 3).locator("video")).toBeVisible();
      if (profile.name !== "Pixel 7") {
        // A phone browser has no host to ask: its screen is the browser's.
        expect(await callServiceStates(page)).toEqual([]);
        return;
      }
      const noCall = { active: false, camera: false, videoOnScreen: false };
      const joined = { active: true, camera: false, videoOnScreen: false };
      const watching = { active: true, camera: false, videoOnScreen: true };
      await expect.poll(() => callServiceStates(page)).toEqual([noCall, joined, watching]);

      await page.evaluate(() =>
        (window as unknown as { __callGrid: { clearStreams(): void } }).__callGrid.clearStreams(),
      );
      await expect.poll(() => callServiceStates(page)).toEqual([noCall, joined, watching, joined]);
    });

    test("tapping a tile focuses it, and tapping it again unfocuses it", async ({ page }) => {
      await mockTauriFullSessionWithVoice(page);
      await page.goto("/");
      await navigateToMainPage(page);
      test.skip(!(await mountCallGrid(page, STREAMS)), "needs the dev server's modules");

      await tile(page, 1002).locator(".video-cell-select").tap();
      await expect(tile(page, 1002)).toHaveClass(/focused/);
      await expect(tile(page, 3)).not.toHaveClass(/focused/);

      await tile(page, 1002).tap({ position: { x: 60, y: 60 } });
      await expect(tile(page, 1002)).not.toHaveClass(/focused/);
      await expect(page.locator("#call-grid-host .video-cell.focused")).toHaveCount(0);

      // Another tile takes the focus when tapped.
      await tile(page, 3).locator(".video-cell-select").tap();
      await tile(page, 4).tap();
      await expect(tile(page, 4)).toHaveClass(/focused/);
    });

    test("a focused tile's full screen button fills the screen, and Back leaves it", async ({
      page,
    }) => {
      await mockTauriFullSessionWithVoice(page);
      await page.goto("/");
      await navigateToMainPage(page);
      test.skip(!(await mountCallGrid(page, STREAMS)), "needs the dev server's modules");

      await tile(page, 1002).locator(".video-cell-select").tap();
      const button = tile(page, 1002).locator("[data-tile-control='fullscreen']");
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

      await button.tap();
      await expect(button).toHaveAttribute("aria-label", "Exit full screen");
      // Back leaves full screen and leaves the focus as it was.
      await page.goBack();
      await expect(button).toHaveAttribute("aria-label", "Full screen");
      await expect(tile(page, 1002)).toHaveClass(/focused/);

      // The button leaves it too.
      await button.tap();
      await expect(button).toHaveAttribute("aria-label", "Exit full screen");
      await button.tap();
      await expect(button).toHaveAttribute("aria-label", "Full screen");
      expect(await callLog(page)).toEqual([]);
    });
  });
}

const SPEAKER_AND_EARPIECE = {
  supported: true,
  routes: [
    { kind: "speaker", name: "" },
    { kind: "earpiece", name: "" },
  ],
  active: "speaker",
};
/** A Bluetooth headset connected, and the phone moved the call to it. */
const WITH_HEADSET = {
  supported: true,
  routes: [...SPEAKER_AND_EARPIECE.routes, { kind: "bluetooth", name: "WH-1000XM5" }],
  active: "bluetooth",
};
const callControls = (page: Page): Locator =>
  page.locator("[data-testid='video-grid'] .video-grid__controls");
const routeButton = (page: Page): Locator =>
  callControls(page).locator("[data-call-control='route']");
const routeSheet = (page: Page): Locator => page.locator("[data-testid='route-sheet']");
const ROUTE_LOST = "Couldn't keep that sound route. Back to automatic.";

for (const profile of PROFILES) {
  test.describe(`phone settings opened on a part, ${profile.name}`, () => {
    // Short enough that the Devices row can reach the top of the section.
    test.use({ ...profile.use, viewport: { width: profile.use.viewport.width, height: 480 } });

    test("Review devices brings the Devices row out from under the title bar", async ({ page }) => {
      await mockTauriFullSessionWithSessions(page);
      await page.goto("/");
      await navigateToMainPage(page);
      const toast = page.locator("[data-testid='toast']", { hasText: "Unreviewed sign-in" });
      await toast.getByRole("button", { name: "Review devices" }).click();
      const overlay = page.locator("[data-testid='settings-overlay']");
      await expect(overlay.locator(".settings-content h1")).toHaveText("Account");
      const row = overlay.locator("li", { has: page.getByTestId("sessions-manage") });
      await expect(page.getByTestId("sessions-manage")).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("sessions-manage")).toBeFocused();
      const scrolled = await overlay
        .locator(".settings-content")
        .evaluate((el) => el.scrollTop > 0 && el.scrollTop < el.scrollHeight - el.clientHeight);
      const bar = await overlay.locator(".settings-content h1").boundingBox();
      const top = await row.boundingBox();
      // The row was scrolled to the top of the section, not just anywhere into view.
      expect(scrolled).toBe(true);
      expect(top!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 0.5);
    });
  });
}

test.describe("call audio in the Android app", () => {
  test.use(pixel7);

  /** The names of the round controls that show, in the row's order. */
  const shownControls = (page: Page): Promise<string[]> =>
    callControls(page).evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>("[data-call-control]")]
        .filter((control) => control.getBoundingClientRect().width > 0)
        .map((control) => control.dataset.callControl ?? ""),
    );

  async function controlsStayOnScreen(page: Page): Promise<void> {
    const bar = (await callControls(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(viewport.width);
    expect(bar.y + bar.height).toBeLessThanOrEqual(viewport.height);
    await noHorizontalScroll(page);
  }

  test("a route button says where the call plays, once there is a choice", async ({ page }) => {
    await joinAndOpenCallView(page);
    const route = routeButton(page);
    // In the row from the start, hidden until the phone reports a choice.
    await expect(route).toHaveCount(1);
    await expect(route).toBeHidden();
    await reportCallAudio(page, {
      ...SPEAKER_AND_EARPIECE,
      routes: [{ kind: "speaker", name: "" }],
    });
    await expect(route).toBeHidden();

    await reportCallAudio(page, SPEAKER_AND_EARPIECE);
    await expect(route).toBeVisible();
    await expect(route).toHaveAttribute("aria-label", "Sound output: Speaker");
    const box = (await route.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const shown = await shownControls(page);
    expect(shown.indexOf("route")).toBe(shown.indexOf("views") - 1);
    expect(await controlRowSpread(callControls(page))).toBeLessThan(1);
    await controlsStayOnScreen(page);
    expect(await findUnnamedControls(callControls(page))).toEqual([]);
    await page.keyboard.press("Shift");
    await route.focus();
    expect((await focusIndicator(page)).problems).toEqual([]);

    // A headset connects and the phone moves the call to it.
    await reportCallAudio(page, WITH_HEADSET);
    await expect(route).toHaveAttribute("aria-label", "Sound output: Bluetooth headset");
  });

  test("the route sheet lists the phone's routes, and a pick reaches the phone", async ({
    page,
  }) => {
    // A picked route holds one microphone capture open; the test browser has
    // no microphone to give.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.resolve(new AudioContext().createMediaStreamDestination().stream);
    });
    await joinAndOpenCallView(page);
    await reportCallAudio(page, WITH_HEADSET);
    const route = routeButton(page);
    await route.tap();
    const sheet = routeSheet(page);
    await expect(sheet).toBeVisible();
    await expect(route).toHaveAttribute("aria-expanded", "true");

    const rows = sheet.getByRole("radio");
    await expect(rows).toHaveCount(3);
    await expect(sheet.getByRole("radio", { checked: true })).toHaveCount(1);
    const headset = sheet.locator("[data-testid='route-bluetooth']");
    await expect(headset).toHaveAttribute("aria-checked", "true");
    await expect(headset).toBeFocused();
    // A headset goes by its own name, with what it is underneath.
    await expect(headset.locator(".route-row-label")).toHaveText("WH-1000XM5");
    await expect(headset.locator(".route-row-detail")).toHaveText("Bluetooth headset");
    await expect(sheet.locator("[data-testid='route-speaker']")).toHaveText("Speaker");
    const earpiece = sheet.locator("[data-testid='route-earpiece']");
    await expect(earpiece).toHaveText("Earpiece");
    for (const row of await rows.all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    for (const text of [
      headset.locator(".route-row-label"),
      headset.locator(".route-row-detail"),
      earpiece.locator(".route-row-label"),
      sheet.locator(".route-sheet-title"),
      sheet.locator(".route-sheet-note"),
    ]) {
      expect((await textContrast(text)).ratio).toBeGreaterThanOrEqual(Q1.text);
    }
    expect(await findUnnamedControls(sheet)).toEqual([]);
    await noHorizontalScroll(page);

    await earpiece.tap();
    await expect(sheet).toHaveCount(0);
    await expect(route).toHaveAttribute("aria-expanded", "false");
    await expect(route).toHaveAttribute("aria-label", "Sound output: Earpiece");
    expect(await callAudioCommands(page)).toEqual([
      'mobile_audio_set_session {"active":false}',
      'mobile_audio_set_session {"active":true}',
      'mobile_audio_set_route {"kind":"earpiece"}',
    ]);

    // The pick held: the sheet shows it as the route in use, and Back closes
    // the sheet with the call view still up.
    await route.tap();
    await expect(routeSheet(page).locator("[data-testid='route-earpiece']")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.goBack();
    await expect(routeSheet(page)).toHaveCount(0);
    await expect(callControls(page)).toBeVisible();
    await expect(page.locator("[data-testid='toast']")).toHaveCount(0);

    // Android will not keep the earpiece and the phone gives the pick up: the
    // app says so, and shows the phone's own choice again.
    await reportCallAudio(page, { ...WITH_HEADSET, manual: null, lost: 1 });
    await expect(page.locator("[data-testid='toast']", { hasText: ROUTE_LOST })).toBeVisible();
    await expect(route).toHaveAttribute("aria-label", "Sound output: Bluetooth headset");
  });

  test("a pick the phone cannot keep goes back to automatic and says so", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("no microphone", "NotFoundError"));
    });
    await joinAndOpenCallView(page);
    await reportCallAudio(page, SPEAKER_AND_EARPIECE);
    const route = routeButton(page);
    await route.tap();
    await routeSheet(page).locator("[data-testid='route-earpiece']").tap();

    await expect(page.locator("[data-testid='toast']", { hasText: ROUTE_LOST })).toBeVisible();
    await expect(route).toHaveAttribute("aria-label", "Sound output: Speaker");
    await expect
      .poll(() => callAudioCommands(page))
      .toEqual([
        'mobile_audio_set_session {"active":false}',
        'mobile_audio_set_session {"active":true}',
        'mobile_audio_set_route {"kind":"earpiece"}',
        'mobile_audio_set_route {"kind":""}',
      ]);
  });

  test("eight controls keep one row on a 360 px wide phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    // The Android WebView, unlike this browser, has no screen capture to offer.
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: undefined });
    });
    await joinAndOpenCallView(page);
    await reportCallAudio(page, SPEAKER_AND_EARPIECE);
    await expect(routeButton(page)).toBeVisible();
    // A camera that is on brings the flip button. The mocked call has no
    // camera to turn on, so the button is shown the way the app would show it.
    await page.addStyleTag({
      content: "[data-call-control='camera-flip'][hidden] { display: inline-flex !important; }",
    });
    expect(await shownControls(page)).toEqual([
      "mute",
      "deafen",
      "camera",
      "camera-flip",
      "route",
      "views",
      "chat",
      "leave",
    ]);

    expect(await controlRowSpread(callControls(page))).toBeLessThan(1);
    await controlsStayOnScreen(page);
    const boxes = await callControls(page).evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>("[data-call-control]")]
        .map((control) => control.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => ({ left: box.left, right: box.right, height: box.height })),
    );
    for (const [i, box] of boxes.entries()) {
      // Smaller than on a wider phone, and still a thumb's target apart.
      expect(box.right - box.left, `control ${i}`).toBeGreaterThanOrEqual(36);
      expect(box.height, `control ${i}`).toBeGreaterThanOrEqual(36);
      if (i > 0) expect(box.left, `control ${i}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
    }
  });

  test("a phone call pauses the call view and closes the route sheet", async ({ page }) => {
    await joinAndOpenCallView(page);
    await reportCallAudio(page, SPEAKER_AND_EARPIECE);
    const bar = callControls(page);
    const route = routeButton(page);
    const note = bar.locator(".video-fs-paused");
    const mute = bar.locator("[data-call-control='mute']");
    await expect(note).toBeHidden();
    await route.tap();
    await expect(routeSheet(page)).toBeVisible();

    // A phone call is answered.
    await reportCallAudio(page, { interrupted: true });
    await expect(routeSheet(page)).toHaveCount(0);
    await expect(route).toBeHidden();
    await expect(note).toBeVisible();
    await expect(note).toHaveText("Paused for a phone call");
    expect((await textContrast(note)).ratio).toBeGreaterThanOrEqual(Q1.text);
    await expect(mute).toBeDisabled();
    await expect(mute).toHaveAttribute("title", "Muted while paused");
    await expect(bar.locator("[data-call-control='leave']")).toBeEnabled();
    // The note has its own line above the controls, which keep their row.
    const noteBox = (await note.boundingBox())!;
    const muteBox = (await mute.boundingBox())!;
    expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(muteBox.y);
    expect(await controlRowSpread(bar)).toBeLessThan(1);
    await controlsStayOnScreen(page);

    // The phone call ends.
    await reportCallAudio(page, { interrupted: false });
    await expect(note).toBeHidden();
    await expect(mute).toBeEnabled();
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await expect(route).toBeVisible();
  });
});

test.describe("call audio in a phone browser", () => {
  test.use(iphone14);

  test("there is no route button and no pause: a browser has no host to ask", async ({ page }) => {
    await joinAndOpenCallView(page);
    await reportCallAudio(page, { ...WITH_HEADSET, interrupted: true });
    await expect(callControls(page).locator("[data-call-control='leave']")).toBeVisible();
    await expect(routeButton(page)).toHaveCount(0);
    await expect(callControls(page).locator(".video-fs-paused")).toBeHidden();
    await expect(callControls(page).locator("[data-call-control='mute']")).toBeEnabled();
    expect(await callAudioCommands(page)).toEqual([]);
  });
});

const RING_DM = 100;
const RING_MEMBERS = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  {
    id: 2,
    username: "otheruser",
    display_name: "Otto",
    avatar: "",
    status: "online",
    role: "member",
  },
];
const RING_DM_CHANNELS = [
  {
    channel_id: RING_DM,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
];

/** Signed in with one DM (Otto), and a voice join that gets its token. */
async function signInWithDm(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
        { pattern: "GET /api/v1/dms", status: 200, body: { dm_channels: RING_DM_CHANNELS } },
      ],
      simulateWsFlow: true,
      wsHandlers: voiceJoinWithTokenHandlers(),
      readyOverrides: { members: RING_MEMBERS, dm_channels: RING_DM_CHANNELS },
    }),
  );
  await parkLiveKitSocket(page);
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

for (const profile of PROFILES) {
  test.describe(`mobile ring screen, ${profile.name}`, () => {
    test.use(profile.use);

    const screen = (page: Page) => page.locator("[data-testid='incoming-call-screen']");
    const banner = (page: Page) => page.locator("[data-testid='incoming-call-banner']");
    const landscape =
      profile.name === "Pixel 7" ? { width: 915, height: 412 } : { width: 844, height: 390 };

    async function boot(page: Page): Promise<void> {
      await signInWithDm(page);
      await expect(banner(page)).toBeAttached();
    }

    const ring = {
      type: "call_incoming",
      payload: { channel_id: RING_DM, from_user: 2, username: "otheruser" },
    };

    test("a ring takes the whole screen with big Decline and Accept buttons", async ({ page }) => {
      await boot(page);
      await emitWsMessage(page, ring);

      await expect(screen(page)).toBeVisible();
      await expect(page.locator("[data-testid='incoming-call-screen-title']")).toHaveText(
        "Otto is calling",
      );
      await expect(screen(page)).toContainText("Incoming call");
      await expect(banner(page)).toBeHidden();
      const view = page.viewportSize()!;
      const full = (await screen(page).boundingBox())!;
      expect(full.width).toBeGreaterThanOrEqual(view.width - 1);
      expect(full.height).toBeGreaterThanOrEqual(view.height - 1);
      for (const id of ["accept", "decline"]) {
        const box = await page.locator(`[data-testid='incoming-call-screen-${id}']`).boundingBox();
        expect(box?.width ?? 0, id).toBeGreaterThanOrEqual(64);
        expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(64);
      }
      const video = await page
        .locator("[data-testid='incoming-call-screen-accept-video']")
        .boundingBox();
      expect(video?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(await findUnnamedControls(screen(page))).toEqual([]);
      await noHorizontalScroll(page);
    });

    test("on a phone turned sideways the caller and the buttons stay apart and on screen", async ({
      page,
    }) => {
      await boot(page);
      await page.setViewportSize(landscape);
      await emitWsMessage(page, ring);
      await expect(screen(page)).toBeVisible();

      const view = page.viewportSize()!;
      const inView = (b: { x: number; y: number; width: number; height: number }) =>
        b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height;
      const boxOf = async (id: string) =>
        (await page.locator(`[data-testid='incoming-call-screen-${id}']`).boundingBox())!;
      const avatar = await boxOf("avatar");
      const title = await boxOf("title");
      const accept = await boxOf("accept");
      const decline = await boxOf("decline");
      const video = await boxOf("accept-video");
      for (const [name, b] of Object.entries({ avatar, title, accept, decline, video }))
        expect(inView(b), name).toBe(true);
      const callerRight = Math.max(avatar.x + avatar.width, title.x + title.width);
      expect(callerRight).toBeLessThanOrEqual(Math.min(accept.x, decline.x, video.x));
    });

    test("Back hides it down to the banner and the ring goes on", async ({ page }) => {
      await boot(page);
      await emitWsMessage(page, ring);
      await expect(screen(page)).toBeVisible();

      await page.goBack();
      await expect(screen(page)).toHaveCount(0);
      await expect(banner(page)).toBeVisible();
      await expect(page.locator("[data-testid='incoming-call-title']")).toHaveText(
        "Otto is calling",
      );

      // The banner still answers.
      await page.locator("[data-testid='incoming-call-decline']").tap();
      await expect(banner(page)).toBeHidden();
    });

    test("Decline on the full screen ends the ring", async ({ page }) => {
      await boot(page);
      await emitWsMessage(page, ring);
      await expect(screen(page)).toBeVisible();

      await page.locator("[data-testid='incoming-call-screen-decline']").tap();
      await expect(screen(page)).toHaveCount(0);
      await expect(banner(page)).toBeHidden();
    });

    test("Accept on the full screen joins the call and closes it", async ({ page }) => {
      await boot(page);
      await emitWsMessage(page, ring);
      await expect(screen(page)).toBeVisible();

      await page.locator("[data-testid='incoming-call-screen-accept']").tap();
      await expect(screen(page)).toHaveCount(0);
      await expect(banner(page)).toBeHidden();
    });
  });
}

const HEADER_DM = 120;
const HEADER_DM_CHANNELS = [
  dmChannel(HEADER_DM, {
    id: 2,
    username: "otheruser",
    display_name: "Maximiliaan Vandenberghe-Wouters",
  }),
];

for (const profile of PROFILES) {
  test.describe(`mobile DM header, ${profile.name}`, () => {
    test.use(profile.use);

    const header = (page: Page) => page.locator("[data-testid='chat-header']");

    async function openDm(page: Page): Promise<void> {
      await page.addInitScript(
        buildTauriMockScript({
          httpRoutes: [
            ...BASE_SESSION_ROUTES,
            { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
            { pattern: "GET /api/v1/dms", status: 200, body: { dm_channels: HEADER_DM_CHANNELS } },
          ],
          simulateWsFlow: true,
          readyOverrides: { dm_channels: HEADER_DM_CHANNELS },
        }),
      );
      await page.goto("/");
      await navigateToMainPageReady(page);
      await page.locator("[data-testid='sidebar-toggle']").tap();
      await page.locator("[data-testid='server-rail-home']").tap();
      await page.locator(`.dm-item[data-channel-id='${HEADER_DM}']`).tap();
      await expect(page.locator("[data-testid='call-btn']")).toBeVisible();
    }

    /** Every visible header control ends inside the viewport. */
    async function headerFits(page: Page, width: number): Promise<void> {
      await page.setViewportSize({ width, height: 740 });
      await noHorizontalScroll(page);
      const controls = header(page).locator("button:visible");
      const count = await controls.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const box = await controls.nth(i).boundingBox();
        expect(box, `header control ${i}`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
    }

    test("a DM header has no horizontal overflow at 360 px and 412 px", async ({ page }) => {
      await openDm(page);
      await headerFits(page, 360);
      await headerFits(page, 412);
      // The long name gives way with an ellipsis rather than pushing the tools out.
      const name = page.locator("[data-testid='chat-header-name']");
      const cut = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(cut).toBe(true);
    });

    test("pins and the profile toggle sit behind the header's More button", async ({ page }) => {
      await openDm(page);
      await page.setViewportSize({ width: 360, height: 740 });
      await expect(page.locator("[data-testid='pin-btn']")).toBeHidden();
      await expect(page.locator("[data-testid='dm-profile-btn']")).toBeHidden();
      const more = page.locator("[data-testid='chat-header-more']");
      await more.tap();
      const sheet = page.locator("[data-testid='chat-header-more-sheet']");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator("[data-testid='chat-header-more-dm-profile-btn']")).toBeVisible();
      await sheet.locator("[data-testid='chat-header-more-pin-btn']").tap();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator(".pinned-panel")).toBeVisible();
    });
  });
}

test.describe("a DM call's audio in the Android app", () => {
  // The narrowest phone the layout is made for.
  test.use({ ...pixel7, viewport: { width: 360, height: 780 } });

  test("the call panel has the route button on its one row, and a phone call pauses it", async ({
    page,
  }) => {
    await signInWithDm(page);
    await page.locator("[data-testid='sidebar-toggle']").tap();
    await page.locator("[data-testid='server-rail-home']").tap();
    await page.locator(".dm-conversation-list .dm-item").first().tap();
    await page.locator("[data-testid='call-btn']").tap();
    await connectVoiceSession(page);
    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 2,
        channel_id: RING_DM,
        username: "otheruser",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });
    const panel = page.locator("[data-testid='dm-call-panel']");
    await expect(panel).toHaveAttribute("data-state", "connected");
    const route = panel.locator("[data-testid='route-button-dm']");
    const mute = panel.locator("[data-testid='dcp-mute']");
    const collapse = panel.locator("[data-testid='dcp-collapse']");
    const status = panel.locator(".dcp-status");
    await expect(route).toHaveCount(1);
    await expect(route).toBeHidden();

    await reportCallAudio(page, SPEAKER_AND_EARPIECE);
    await expect(route).toBeVisible();
    await expect(route).toHaveAttribute("aria-label", "Sound output: Speaker");
    // One row with Leave on it, every control a full touch target.
    const boxes = await panel.locator(".dcp-controls").evaluate((el) =>
      [...el.querySelectorAll("button")]
        .map((button) => button.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => ({ centre: box.top + box.height / 2, width: box.width, right: box.right })),
    );
    const centres = boxes.map((box) => box.centre);
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(1);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(360);
    }
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await findUnnamedControls(panel)).toEqual([]);

    // Collapsed, the panel keeps Mute and Leave; the route is one tap away.
    await collapse.tap();
    await expect(mute).toBeVisible();
    await expect(route).toBeHidden();
    await collapse.tap();
    await expect(route).toBeVisible();

    // A phone call is answered, then ends.
    await reportCallAudio(page, { interrupted: true });
    await expect(status).toHaveText("Call paused");
    await expect(status).toHaveClass(/dcp-status--warn/);
    expect((await textContrast(status)).ratio).toBeGreaterThanOrEqual(Q1.text);
    await expect(mute).toBeDisabled();
    await expect(mute).toHaveAttribute("title", "Muted while paused");
    await expect(route).toBeHidden();
    await reportCallAudio(page, { interrupted: false });
    await expect(status).not.toHaveClass(/dcp-status--warn/);
    await expect(mute).toBeEnabled();
    await expect(route).toBeVisible();
  });
});
