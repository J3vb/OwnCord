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
    const strip = page.locator(".server-strip");
    await expect(strip).toBeVisible();

    const icons = page.locator(".server-strip .server-icon");
    await expect(icons.first()).toBeVisible();
  });

  test("active server icon has active class", async ({ page }) => {
    const activeIcon = page.locator(".server-strip .server-icon.active");
    await expect(activeIcon).toBeVisible();
  });

  test("server separator exists between icons", async ({ page }) => {
    const separator = page.locator(".server-strip .server-separator");
    await expect(separator).toBeAttached();
  });

  test("add server button exists", async ({ page }) => {
    const addBtn = page.locator(".server-strip .server-icon.add");
    await expect(addBtn).toBeVisible();
  });
});
