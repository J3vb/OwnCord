/**
 * The desktop server rail: its journey (Home <-> DMs, the invite dialog) and
 * the shared B9 accessibility checks on every theme, with and without High
 * Contrast.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSession, navigateToMainPageReady } from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  keyboardReachable,
  setAppearance,
  textContrast,
} from "./support/b9-accessibility";

const rail = (page: Page) => page.getByRole("navigation", { name: "Servers" });
const home = (page: Page) => page.getByTestId("server-rail-home");
const joinDialog = (page: Page) => page.getByTestId("server-rail-join-dialog");

test.describe("Server rail", () => {
  test("Home opens DMs and the connected server returns to its channels", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await expect(rail(page)).toBeVisible();
    // The rail replaces the sidebar's DM section and the user bar's switch button.
    await expect(page.locator(".sidebar-dm-section")).toBeHidden();
    await expect(page.getByTestId("disconnect-btn")).toBeHidden();

    await home(page).click();
    await expect(home(page)).toHaveAttribute("aria-current", "true");
    const current = rail(page).getByTestId("server-rail-server").first();
    await current.click();
    await expect(current).toHaveAttribute("aria-current", "true");
    await expect(home(page)).not.toHaveAttribute("aria-current", "true");
  });

  test("the invite dialog is reachable by keyboard and explains a bad link", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    const join = page.getByTestId("server-rail-join");
    expect(await keyboardReachable(page, join)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(joinDialog(page)).toBeVisible();
    const input = page.getByTestId("server-rail-join-input");
    await expect(input).toBeFocused();
    await input.fill("not a link");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("server-rail-join-error")).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(joinDialog(page)).toBeHidden();
  });

  test("the rail steps aside at narrow widths", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.setViewportSize({ width: 760, height: 760 });
    await page.goto("/");
    await navigateToMainPageReady(page);
    await expect(page.getByTestId("server-rail")).toBeHidden();
  });
});

test.describe("Server rail — Q1 accessibility", () => {
  for (const theme of ["dark", "neon-glow", "midnight", "light"] as const) {
    for (const highContrast of [false, true]) {
      test(`${theme}${highContrast ? " + High Contrast" : ""}: names, focus and contrast`, async ({
        page,
      }, testInfo) => {
        await mockTauriFullSession(page);
        await page.goto("/");
        await setAppearance(page, { theme, highContrast, accent: null });
        await navigateToMainPageReady(page);
        await expect(rail(page)).toBeVisible();

        const measured: Record<string, number> = {};
        const failures: string[] = [];
        expect(await findUnnamedControls(rail(page))).toEqual([]);

        const homeText = (await textContrast(home(page))).ratio;
        measured["home"] = Number(homeText.toFixed(2));
        if (homeText < Q1.text) failures.push(`home ${homeText.toFixed(2)} < ${Q1.text}`);

        expect(await keyboardReachable(page, home(page))).toBe(true);
        const ring = await focusIndicator(page);
        measured["focus home"] = Number(ring.ratio.toFixed(2));
        for (const p of ring.problems) failures.push(`focus home: ${p}`);

        await page.getByTestId("server-rail-join").click();
        await expect(joinDialog(page)).toBeVisible();
        expect(await findUnnamedControls(joinDialog(page))).toEqual([]);
        for (const name of ["Cancel", "Continue"]) {
          const button = joinDialog(page).getByRole("button", { name });
          const ratio = (await textContrast(button)).ratio;
          measured[name] = Number(ratio.toFixed(2));
          if (ratio < Q1.text) failures.push(`${name} ${ratio.toFixed(2)} < ${Q1.text}`);
        }
        await page.keyboard.press("Escape");

        await testInfo.attach(`server-rail-contrast-${theme}-hc-${highContrast}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        expect(failures).toEqual([]);
      });
    }
  }
});
