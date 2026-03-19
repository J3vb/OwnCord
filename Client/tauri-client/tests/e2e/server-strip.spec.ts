import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Server Strip
// ---------------------------------------------------------------------------

test.describe("Server Strip", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("server strip is visible with server icons", async ({ page }) => {
    const strip = page.locator("[data-testid='server-strip']");
    await expect(strip).toBeVisible();

    const icons = strip.locator(".server-icon");
    await expect(icons.first()).toBeVisible();
  });

  test("active server icon shows home initial 'O'", async ({ page }) => {
    const activeIcon = page.locator("[data-testid='server-strip'] .server-icon.active");
    await expect(activeIcon).toBeVisible();
    await expect(activeIcon).toHaveText("O");
  });

  test("server separator exists between icons", async ({ page }) => {
    const separator = page.locator("[data-testid='server-strip'] .server-separator");
    await expect(separator).toBeAttached();
  });

  test("add server button shows '+' icon", async ({ page }) => {
    const addBtn = page.locator("[data-testid='server-strip'] .server-icon.add");
    await expect(addBtn).toBeVisible();
    await expect(addBtn).toHaveText("+");
  });
});
