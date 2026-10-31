/**
 * The desktop server rail: its journey (Home <-> DMs, the invite dialog) and
 * the shared B9 accessibility checks on every theme, with and without High
 * Contrast.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSession, navigateToMainPageReady, startFullSession } from "./helpers";
import { findUnnamedControls, keyboardReachable, setAppearance } from "./support/accessibility";
import { contrastMatrix } from "./support/a11yHarness";

const rail = (page: Page) => page.getByRole("navigation", { name: "Servers" });
const home = (page: Page) => page.getByTestId("server-rail-home");
const joinDialog = (page: Page) => page.getByTestId("server-rail-join-dialog");

test.describe("Server rail", () => {
  test("Home opens DMs and the connected server returns to its channels", async ({ page }) => {
    await startFullSession(page, { ready: true });
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
    await startFullSession(page, { ready: true });
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

  test("the first icon's selected ring and hover lift are not clipped at the top", async ({
    page,
  }) => {
    await startFullSession(page, { ready: true });
    await home(page).click();
    await home(page).hover();
    const room = await home(page).evaluate((btn) => {
      const scroll = btn.closest(".server-rail-scroll");
      if (scroll === null) return Number.NaN;
      return btn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    });
    // The selected ring reaches 4px past the icon and hover lifts it 1px more.
    expect(room).toBeGreaterThanOrEqual(5);
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
  for (const c of contrastMatrix({
    title: "names, focus and contrast",
    attachName: (theme, hc) => `server-rail-contrast-${theme}-hc-${hc}.json`,
    boot: async (page, prefs) => {
      await mockTauriFullSession(page);
      await page.goto("/");
      await setAppearance(page, prefs);
      await navigateToMainPageReady(page);
      await expect(rail(page)).toBeVisible();
    },
    scenario: async (page, { measure, ring }) => {
      expect(await findUnnamedControls(rail(page))).toEqual([]);

      await measure("home", home(page));

      expect(await keyboardReachable(page, home(page))).toBe(true);
      await ring("home");

      await page.getByTestId("server-rail-join").click();
      await expect(joinDialog(page)).toBeVisible();
      expect(await findUnnamedControls(joinDialog(page))).toEqual([]);
      for (const name of ["Cancel", "Continue"]) {
        await measure(name, joinDialog(page).getByRole("button", { name }));
      }
      await page.keyboard.press("Escape");
    },
  })) {
    test(c.title, c.run);
  }
});
