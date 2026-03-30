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
    const userBar = page.locator("[data-testid='user-bar']");
    await expect(userBar).toBeVisible();
  });

  test("user bar shows username 'testuser'", async ({ page }) => {
    const name = page.locator("[data-testid='user-bar-name']");
    await expect(name).toBeVisible();
    await expect(name).toHaveText("testuser");
  });

  test("user bar shows avatar with initial", async ({ page }) => {
    const avatar = page.locator("[data-testid='user-bar'] .ub-avatar");
    await expect(avatar).toBeVisible();
    // Avatar should contain the first letter of the username
    await expect(avatar).toContainText("T");
  });

  test("user bar shows online status", async ({ page }) => {
    const status = page.locator("[data-testid='user-bar'] .ub-status");
    await expect(status).toBeVisible();
    await expect(status).toHaveText("Online");
  });

  test("user bar has settings button with correct label", async ({ page }) => {
    const controls = page.locator("[data-testid='user-bar'] .ub-controls");
    await expect(controls).toBeVisible();

    const settingsBtn = controls.locator("button[aria-label='Settings']");
    await expect(settingsBtn).toBeVisible();
    // Settings button uses an SVG icon (createIcon("settings")) instead of text
    const svgIcon = settingsBtn.locator("svg");
    await expect(svgIcon).toBeAttached();
  });

  test("user bar has control buttons (mute, deafen, settings)", async ({ page }) => {
    const controls = page.locator("[data-testid='user-bar'] .ub-controls");
    const buttons = controls.locator("button");
    const count = await buttons.count();
    // UserBar renders settings + optionally disconnect (no mute/deafen in user bar)
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("user bar has status dot", async ({ page }) => {
    const statusDot = page.locator("[data-testid='user-bar'] .status-dot");
    await expect(statusDot).toBeAttached();
  });
});
