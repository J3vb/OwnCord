import { devices, type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  BASE_SESSION_ROUTES,
  MOCK_LOGIN_2FA_RESPONSE,
  ROUTE_HEALTH,
  buildTauriMockScript,
  navigateToMainPageReady,
} from "./helpers";

// Panels that open over the phone layout fit the screen and look like the
// rest of the phone UI: the quick switcher, the theme tiles, the own profile
// card, the poll composer and the two-factor screen. With PHONE_SHOTS_DIR set,
// each state is also written there as a PNG for the PR.

const { defaultBrowserType: _pixelBrowser, ...pixel7 } = devices["Pixel 7"];
test.use(pixel7);

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["PHONE_SHOTS_DIR"];
  if (dir !== undefined) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function signIn(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
      ],
      simulateWsFlow: true,
      readyOverrides: { capabilities: { polls: true } },
    }),
  );
  await page.goto("/");
  await navigateToMainPageReady(page);
}

/** The element's box, which must lie inside the viewport. */
async function onScreen(page: Page, el: Locator) {
  const box = await el.boundingBox();
  const vp = page.viewportSize();
  if (box === null || vp === null) throw new Error("no box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(vp.width);
  expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(vp.height);
  return { ...box, vw: vp.width, vh: vp.height };
}

test("the quick switcher is pinned to the top edge, full width", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  const card = page.locator(".quick-switcher");
  await expect(card).toBeVisible();
  const box = await onScreen(page, card);
  expect(box.y).toBeLessThanOrEqual(1);
  expect(Math.round(box.width)).toBe(box.vw);
  // As tall as its rows, not down to the bottom edge.
  expect(box.height).toBeLessThan(box.vh * 0.7);
  await shot(page, "30-quick-switcher");
});

test("every theme tile is on screen at full size on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signIn(page);
  await page.getByTestId("sidebar-toggle").click();
  await page.locator("button[aria-label='Settings']").click();
  await page
    .locator("[data-testid='settings-overlay'] .settings-nav-item[role='tab']", {
      hasText: "Appearance",
    })
    .click();
  const tiles = page.locator(".theme-tiles [role='radio']");
  expect(await tiles.count()).toBeGreaterThan(4);
  const tops: number[] = [];
  for (const tile of await tiles.all()) {
    const box = await onScreen(page, tile);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(80);
    tops.push(Math.round(box.y));
  }
  // Two to a row: the first two share a row and the third starts the next.
  expect(tops[1]).toBe(tops[0]);
  expect(tops[2]).toBeGreaterThan(tops[1]!);
  await shot(page, "31-theme-tiles");
});

test("the own profile card opens as a bottom sheet", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("sidebar-toggle").click();
  await page.getByTestId("user-bar-name").click();
  const sheet = page.getByTestId("self-profile-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("self-profile-card")).toBeVisible();
  const box = await onScreen(page, sheet);
  expect(Math.round(box.y + box.height)).toBe(box.vh);
  expect(Math.round(box.width)).toBe(box.vw);
  await shot(page, "32-self-profile-sheet");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("self-profile-card")).toHaveCount(0);
});

test("the poll composer sits at the bottom edge like the other sheets", async ({ page }) => {
  await signIn(page);
  await page.locator(".attach-btn").tap();
  await page.getByTestId("attach-sheet-poll").tap();
  const dialog = page.locator(".modal.poll-composer");
  await expect(dialog).toBeVisible();
  const box = await onScreen(page, dialog);
  expect(Math.round(box.y + box.height)).toBe(box.vh);
  expect(Math.round(box.width)).toBe(box.vw);
  await shot(page, "33-poll-composer");
});

test("the two-factor screen keeps a side gutter", async ({ page }) => {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ROUTE_HEALTH,
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_2FA_RESPONSE },
      ],
      simulateWsFlow: false,
    }),
  );
  await page.goto("/");
  await page.locator("#host").fill("localhost:8443");
  await page.locator("#username").fill("testuser");
  await page.locator("#password").fill("password123");
  await page.locator(".btn-primary[type='submit']").click();
  const card = page.locator(".totp-overlay:not(.totp-overlay--hidden) .totp-card");
  await expect(card).toBeVisible();
  const box = await onScreen(page, card);
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(Math.round(box.vw - box.x - box.width)).toBeGreaterThanOrEqual(16);
  await shot(page, "34-two-factor");
});
