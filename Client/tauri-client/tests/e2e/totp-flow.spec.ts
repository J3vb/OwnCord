/**
 * E2E tests for TOTP (2FA) submission flow.
 * Covers: valid code submits, invalid code shows error, cancel returns to login.
 */
import { test, expect } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_LOGIN_2FA_RESPONSE,
  MOCK_TOKEN,
} from "./helpers";

async function mockTotpSuccess(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_2FA_RESPONSE },
      { pattern: "/api/v1/auth/verify-totp", status: 200, body: { token: MOCK_TOKEN, requires_2fa: false } },
    ],
    simulateWsFlow: true,
  }));
}

async function mockTotpFailure(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_2FA_RESPONSE },
      { pattern: "/api/v1/auth/verify-totp", status: 401, body: { error: "INVALID_CODE", message: "Invalid verification code" } },
    ],
  }));
}

async function loginToTotp(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#host").fill("localhost:8443");
  await page.locator("#username").fill("testuser");
  await page.locator("#password").fill("password123");
  await page.locator(".btn-primary[type='submit']").click();

  const totpOverlay = page.locator(".totp-overlay");
  await expect(totpOverlay).not.toHaveClass(/totp-overlay--hidden/, { timeout: 5000 });
}

test.describe("TOTP Submission Flow", () => {
  test("entering non-numeric code shows error class on input", async ({ page }) => {
    await mockTotpSuccess(page);
    await page.goto("/");
    await loginToTotp(page);

    const totpInput = page.locator(".totp-overlay input[inputmode='numeric']");
    await totpInput.fill("abc");

    const verifyBtn = page.locator(".totp-overlay button.btn-primary");
    await verifyBtn.click();

    // Input should briefly get error class
    await expect(totpInput).toHaveClass(/error/, { timeout: 1000 });
  });

  test("entering fewer than 6 digits shows error class", async ({ page }) => {
    await mockTotpSuccess(page);
    await page.goto("/");
    await loginToTotp(page);

    const totpInput = page.locator(".totp-overlay input[inputmode='numeric']");
    await totpInput.fill("123");

    const verifyBtn = page.locator(".totp-overlay button.btn-primary");
    await verifyBtn.click();

    await expect(totpInput).toHaveClass(/error/, { timeout: 1000 });
  });

  test("submitting valid 6-digit code completes login", async ({ page }) => {
    await mockTotpSuccess(page);
    await page.goto("/");
    await loginToTotp(page);

    const totpInput = page.locator(".totp-overlay input[inputmode='numeric']");
    await totpInput.fill("123456");

    const verifyBtn = page.locator(".totp-overlay button.btn-primary");
    await verifyBtn.click();

    // Should transition to connected overlay
    const overlay = page.locator(".connected-overlay");
    await expect(overlay).toBeVisible({ timeout: 5000 });
  });

  test("submitting invalid code shows error banner", async ({ page }) => {
    await mockTotpFailure(page);
    await page.goto("/");
    await loginToTotp(page);

    const totpInput = page.locator(".totp-overlay input[inputmode='numeric']");
    await totpInput.fill("999999");

    const verifyBtn = page.locator(".totp-overlay button.btn-primary");
    await verifyBtn.click();

    // Error banner should appear
    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 5000 });
  });

  test("cancel button returns to login form", async ({ page }) => {
    await mockTotpSuccess(page);
    await page.goto("/");
    await loginToTotp(page);

    const backBtn = page.locator(".totp-back");
    await backBtn.click();

    const totpOverlay = page.locator(".totp-overlay");
    await expect(totpOverlay).toHaveClass(/totp-overlay--hidden/);
  });
});
