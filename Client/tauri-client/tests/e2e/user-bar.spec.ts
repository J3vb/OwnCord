import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: User Bar
// ---------------------------------------------------------------------------

test.describe("User Bar", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("user bar is visible", async ({ page }) => {
    const userBar = page.locator(".user-bar");
    await expect(userBar).toBeVisible();
  });

  test("user bar shows username", async ({ page }) => {
    const name = page.locator(".ub-name");
    await expect(name).toBeVisible();
    await expect(name).toHaveText("testuser");
  });

  test("user bar shows avatar", async ({ page }) => {
    const avatar = page.locator(".ub-avatar");
    await expect(avatar).toBeVisible();
  });

  test("user bar shows status", async ({ page }) => {
    const status = page.locator(".ub-status");
    await expect(status).toBeVisible();
  });

  test("user bar has control buttons", async ({ page }) => {
    const controls = page.locator(".ub-controls");
    await expect(controls).toBeVisible();

    const buttons = controls.locator("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("user bar has status dot", async ({ page }) => {
    const statusDot = page.locator(".user-bar .status-dot");
    await expect(statusDot).toBeAttached();
  });
});
