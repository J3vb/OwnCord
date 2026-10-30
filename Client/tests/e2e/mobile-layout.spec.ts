/**
 * Touch input: long-press opens the message actions sheet and the channel menu,
 * and a tap on a message shows nothing (the hold is the only way to its
 * actions, as in Discord). The emoji/GIF picker and member profiles open as
 * bottom sheets too.
 *
 * Phone layout (WP 6.13f1): no horizontal scroll, a reachable drawer, a
 * full-width member overlay and 44 px touch targets in the user bar. Both
 * profiles run on Chromium (the iPhone profile's default WebKit is dropped).
 */
import { devices, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
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
      const targets = page.locator(
        "[data-testid='user-bar'] .ub-controls button, [data-testid='user-bar-profile']",
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
