/**
 * WP 1A-4: after a voice reconnect, a toast names the camera or screen share
 * the drop stopped and offers to turn it back on. A LiveKit drop cannot be
 * staged in the mocked suite, so the toast is shown through the dev server's
 * module graph (as stream-popout.spec.ts mounts the grid) with the same call
 * the session makes. The production preview serves only the bundle, so there
 * the test skips.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";
import {
  Q1,
  type AppearancePrefs,
  findUnnamedControls,
  focusIndicator,
  keyboardReachable,
  setAppearance,
  textContrast,
} from "./support/accessibility";
import { ZOOM_VIEWPORT, expectScreenReflows } from "./support/zoom-reflow";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await navigateToMainPage(page);
}

/** Show the camera-lost notice; false when the dev server's modules are not served. */
async function showNotice(page: Page): Promise<boolean> {
  return page.evaluate(async (url) => {
    let mod;
    try {
      mod = await import(/* @vite-ignore */ url);
    } catch {
      return false;
    }
    const w = window as unknown as { turnedOn: string[] };
    w.turnedOn = [];
    mod.showMediaLostNotice(
      { camera: true, screenshare: false },
      { camera: () => w.turnedOn.push("camera"), screenshare: () => w.turnedOn.push("share") },
    );
    return true;
  }, "/src/features/voice/mediaLostNotice.ts");
}

const notice = (page: Page) =>
  page.locator("[data-testid='toast']", { hasText: "Your camera stopped" });
const action = (page: Page) => notice(page).getByRole("button", { name: "Turn on again" });

test.describe("reconnect media notice", () => {
  test("is named, reachable by keyboard, and Enter turns the camera back on", async ({ page }) => {
    await mockTauriFullSession(page);
    await signIn(page);
    test.skip(!(await showNotice(page)), "needs the dev server's modules");

    await expect(notice(page)).toBeVisible();
    expect(await findUnnamedControls(page.locator("[data-testid='toast-container']"))).toEqual([]);
    expect(await keyboardReachable(page, action(page))).toBe(true);
    expect((await focusIndicator(page)).problems).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(notice(page)).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { turnedOn: string[] }).turnedOn),
    ).toEqual(["camera"]);
  });

  test("contrast holds in every theme and High Contrast", async ({ page }) => {
    await mockTauriFullSession(page);
    await signIn(page);
    const matrix: AppearancePrefs[] = [
      { theme: "dark" },
      { theme: "midnight" },
      { theme: "neon-glow" },
      { theme: "light" },
      { theme: "dark", highContrast: true },
    ];
    for (const prefs of matrix) {
      await setAppearance(page, prefs);
      await navigateToMainPage(page);
      test.skip(!(await showNotice(page)), "needs the dev server's modules");
      await expect(notice(page)).toBeVisible();
      const parts = { message: notice(page).locator(".toast-text"), action: action(page) };
      for (const [name, locator] of Object.entries(parts)) {
        const { ratio } = await textContrast(locator);
        expect(ratio, `${name} in ${JSON.stringify(prefs)}`).toBeGreaterThanOrEqual(Q1.text);
      }
      await action(page).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(action(page)).toBeFocused();
      expect((await focusIndicator(page)).problems, JSON.stringify(prefs)).toEqual([]);
    }
  });

  test("reflows at 200 % zoom with Large Font", async ({ page }, testInfo) => {
    await page.setViewportSize(ZOOM_VIEWPORT);
    await mockTauriFullSession(page);
    await signIn(page);
    await setAppearance(page, { fontSize: 20, largeFont: true });
    await navigateToMainPage(page);
    test.skip(!(await showNotice(page)), "needs the dev server's modules");
    await expect(notice(page)).toBeVisible();
    await expectScreenReflows(
      page,
      {
        name: "zoom-reconnect-media-notice-640x400.png",
        root: page.locator("[data-testid='toast-container']"),
        actions: [action(page)],
      },
      testInfo,
    );
  });
});
