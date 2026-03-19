/**
 * E2E tests for the logout flow.
 * Covers: settings → Log Out → returns to connect page.
 */
import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

test.describe("Logout Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("clicking Log Out in settings returns to connect page", async ({
    page,
  }) => {
    // Open settings
    const settingsBtn = page.locator("button[aria-label='Settings']");
    await settingsBtn.click();
    await expect(
      page.locator(".settings-overlay.open"),
    ).toBeVisible({ timeout: 3000 });

    // Click Log Out button
    const logoutBtn = page.locator(".settings-nav-item.danger", {
      hasText: "Log Out",
    });
    await logoutBtn.click();

    // Should navigate back to connect page
    const connectForm = page.locator(".connect-form, .login-form");
    await expect(connectForm).toBeVisible({ timeout: 5000 });
  });

  test("after logout, main page is no longer visible", async ({ page }) => {
    // Open settings and log out
    const settingsBtn = page.locator("button[aria-label='Settings']");
    await settingsBtn.click();
    await expect(
      page.locator(".settings-overlay.open"),
    ).toBeVisible({ timeout: 3000 });

    const logoutBtn = page.locator(".settings-nav-item.danger", {
      hasText: "Log Out",
    });
    await logoutBtn.click();

    // Main app layout should not be visible
    await expect(page.locator(".app")).not.toBeVisible({ timeout: 5000 });
  });
});
