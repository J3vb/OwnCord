/**
 * E2E tests for the logout flow.
 * Covers: settings → Log Out → returns to connect page.
 */
import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  mockTauriFullSessionWithAutoConnect,
  navigateToMainPage,
} from "./helpers";

test.describe("Logout Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("clicking Log Out in settings returns to connect page", async ({ page }) => {
    // Open settings
    const settingsBtn = page.locator("button[aria-label='Settings']");
    await settingsBtn.click();
    await expect(page.locator(".settings-overlay.open")).toBeVisible({ timeout: 3000 });

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
    await expect(page.locator(".settings-overlay.open")).toBeVisible({ timeout: 3000 });

    const logoutBtn = page.locator(".settings-nav-item.danger", {
      hasText: "Log Out",
    });
    await logoutBtn.click();

    // Main app layout should not be visible
    await expect(page.locator(".app")).not.toBeVisible({ timeout: 5000 });
  });
});

// Logging out deletes the host's credential fire-and-forget, then navigates to
// the connect page — whose auto-login would read that same credential back.
// The credential commands run off the IPC thread, so a read that wins the race
// signs the user straight back into the server they just left. This fixture
// keeps load_credential returning a usable credential (delete_credential is a
// no-op) so the assertion holds on the client's own refusal to auto-login,
// not on the delete having already landed.
test.describe("Logout Flow — auto-connect profile", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithAutoConnect(page);
    await page.goto("/");
    // No submitLogin here: with a seeded auto-connect profile the client signs
    // itself in, which is exactly the path under test. Reaching the app layout
    // without touching the form also proves the fixture really does auto-login,
    // so the assertion below cannot pass merely because the seeds were inert.
    await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  });

  test("logging out does not immediately auto-login back in", async ({ page }) => {
    const settingsBtn = page.locator("button[aria-label='Settings']");
    await settingsBtn.click();
    await expect(page.locator(".settings-overlay.open")).toBeVisible({ timeout: 3000 });

    await page.locator(".settings-nav-item.danger", { hasText: "Log Out" }).click();

    await expect(page.locator(".connect-form, .login-form")).toBeVisible({ timeout: 5000 });
    // Give the auto-login path (and its connecting overlay) time to fire.
    await page.waitForTimeout(1500);
    await expect(page.locator("[data-testid='app-layout']")).not.toBeVisible();
    await expect(page.locator(".connect-form, .login-form")).toBeVisible();
  });
});
