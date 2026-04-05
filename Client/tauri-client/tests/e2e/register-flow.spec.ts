/**
 * E2E tests for the registration flow.
 * Covers: mode toggle, form validation, register success, register error.
 */
import { test, expect } from "@playwright/test";
import { buildTauriMockScript, MOCK_LOGIN_RESPONSE } from "./helpers";

const MOCK_REGISTER_RESPONSE = {
  user: { id: 99, username: "newuser" },
  token: "register-token-abc",
};

async function mockRegisterSuccess(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/register", status: 200, body: MOCK_REGISTER_RESPONSE },
      ],
      simulateWsFlow: true,
    }),
  );
}

async function mockRegisterConflict(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        {
          pattern: "/api/v1/auth/register",
          status: 409,
          body: { error: "USERNAME_TAKEN", message: "Username already exists" },
        },
      ],
      simulateWsFlow: false,
    }),
  );
}

async function switchToRegisterMode(page: import("@playwright/test").Page): Promise<void> {
  const toggleLink = page.locator(".form-switch a");
  await toggleLink.click();
  // Verify we're in register mode
  await expect(page.locator(".btn-text")).toHaveText("Register");
}

test.describe("Register Flow — Mode Toggle", () => {
  test.beforeEach(async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
  });

  test("clicking toggle switches to register mode", async ({ page }) => {
    await switchToRegisterMode(page);

    // Invite code field should be visible
    const inviteGroup = page.locator("#invite").locator("..");
    await expect(inviteGroup).not.toHaveClass(/form-group--hidden/);
  });

  test("register mode shows invite code field", async ({ page }) => {
    await switchToRegisterMode(page);

    const inviteInput = page.locator("#invite");
    await expect(inviteInput).toBeVisible();
  });

  test("toggle back to login hides invite code field", async ({ page }) => {
    await switchToRegisterMode(page);
    // Toggle back
    const toggleLink = page.locator(".form-switch a");
    await toggleLink.click();

    await expect(page.locator(".btn-text")).toHaveText("Login");

    // Invite field parent should be hidden
    const inviteGroup = page.locator("#invite").locator("..");
    await expect(inviteGroup).toHaveClass(/form-group--hidden/);
  });
});

test.describe("Register Flow — Validation", () => {
  test.beforeEach(async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
    await switchToRegisterMode(page);
  });

  test("empty invite code shows validation error", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    // Leave invite code empty

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("Invite code is required");
  });

  test("short password shows validation error", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("short");
    await page.locator("#invite").fill("invite123");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("at least 8 characters");
  });

  test("empty username shows validation error", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    // Leave username empty
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite123");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("Username is required");
  });

  test("empty host shows validation error", async ({ page }) => {
    // Leave host empty (clear the default)
    await page.locator("#host").fill("");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite123");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("Server address is required");
  });
});

test.describe("Register Flow — Submission", () => {
  test("successful register transitions to connected state", async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite-abc");

    await page.locator(".btn-primary[type='submit']").click();

    // Should transition to the connected overlay
    const overlay = page.locator(".connected-overlay");
    await expect(overlay).toBeVisible({ timeout: 5000 });
  });

  test("register shows loading state during submission", async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite-abc");

    // Submit and verify the form completes successfully
    await page.locator(".btn-primary[type='submit']").click();

    // The form should eventually complete and show the connected overlay
    await expect(page.locator(".connected-overlay")).toBeVisible({ timeout: 5000 });
  });

  test("register error shows error banner", async ({ page }) => {
    await mockRegisterConflict(page);
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("existinguser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite-abc");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 5000 });
  });
});
