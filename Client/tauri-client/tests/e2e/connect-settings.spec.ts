import { test, expect } from "@playwright/test";
import { buildTauriMockScript } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Settings Overlay from Connect Page
// ---------------------------------------------------------------------------

test.describe("Connect Page — Settings Overlay", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      ],
      simulateWsFlow: false,
    }));
    await page.goto("/");
  });

  test("gear button is visible on the connect page", async ({ page }) => {
    const gearBtn = page.locator(".settings-gear");
    await expect(gearBtn).toBeVisible();
  });

  test("clicking gear button opens settings overlay", async ({ page }) => {
    const gearBtn = page.locator(".settings-gear");
    await gearBtn.click();

    const overlay = page.locator(".settings-overlay.open");
    await expect(overlay).toBeVisible({ timeout: 5_000 });
  });

  test("closing settings overlay works via close button", async ({ page }) => {
    const gearBtn = page.locator(".settings-gear");
    await gearBtn.click();

    const overlay = page.locator(".settings-overlay.open");
    await expect(overlay).toBeVisible({ timeout: 5_000 });

    const closeBtn = page.locator(".settings-close-btn");
    await closeBtn.click();

    await expect(overlay).not.toBeVisible({ timeout: 5_000 });
  });
});
