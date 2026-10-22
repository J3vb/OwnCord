/**
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
      const search = page.locator("[data-testid='search-input']");
      await expect(search).toBeVisible();
      const box = await search.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(40);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
      await noHorizontalScroll(page);
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
  });
}
