import { test, expect } from "@playwright/test";
import {
  mockTauriConnect,
  mockTauriConnectWith2FA,
  mockTauriLoginError,
  mockTauriFullSession,
  submitLogin,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Connect Page — core
// ---------------------------------------------------------------------------

test.describe("Connect Page", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriConnect(page);
    await page.goto("/");
  });

  test("page loads and shows the connect page", async ({ page }) => {
    const connectPage = page.locator(".connect-page");
    await expect(connectPage).toBeVisible();
  });

  test("server profile list is visible", async ({ page }) => {
    const serverList = page.locator(".server-list");
    await expect(serverList).toBeVisible();

    const serverItem = page.locator(".server-item").first();
    await expect(serverItem).toBeVisible();
    await expect(serverItem.locator(".srv-name")).toHaveText("Local Server");
    await expect(serverItem.locator(".srv-host")).toHaveText("localhost:8443");
  });

  test("login form has host, username, password fields", async ({ page }) => {
    const hostInput = page.locator("#host");
    const usernameInput = page.locator("#username");
    const passwordInput = page.locator("#password");

    await expect(hostInput).toBeVisible();
    await expect(usernameInput).toBeVisible();
    await expect(passwordInput).toBeVisible();

    await expect(hostInput).toHaveAttribute("placeholder", "localhost:8443");
    await expect(passwordInput).toHaveAttribute("type", "password");
  });

  test("form validation shows error for empty fields", async ({ page }) => {
    const hostInput = page.locator("#host");
    await hostInput.fill("");

    const submitBtn = page.locator("button.btn-primary[type='submit']");
    await submitBtn.click();

    const errorBanner = page.locator(".error-banner.visible");
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toHaveText(/required/i);
  });

  test("login/register toggle switches form mode", async ({ page }) => {
    const toggleLink = page.locator(".form-switch a");
    await expect(toggleLink).toHaveText(/Register/);

    await toggleLink.click();
    await expect(toggleLink).toHaveText(/Login/);

    const inviteInput = page.locator("#invite");
    await expect(inviteInput).toBeVisible();

    const submitBtnText = page.locator("button.btn-primary .btn-text");
    await expect(submitBtnText).toHaveText("Register");

    await toggleLink.click();
    await expect(toggleLink).toHaveText(/Register/);
    await expect(submitBtnText).toHaveText("Login");
  });

  test("clicking server profile auto-fills host field", async ({ page }) => {
    const serverItem = page.locator(".server-item").first();
    await serverItem.click();

    const hostInput = page.locator("#host");
    await expect(hostInput).toHaveValue("localhost:8443");
  });

  test("password toggle button shows/hides password", async ({ page }) => {
    const passwordInput = page.locator("#password");
    await passwordInput.fill("secret123");
    await expect(passwordInput).toHaveAttribute("type", "password");

    const toggleBtn = page.locator(".password-toggle");
    await toggleBtn.click();

    await expect(passwordInput).toHaveAttribute("type", "text");

    await toggleBtn.click();
    await expect(passwordInput).toHaveAttribute("type", "password");
  });

  test("form shows loading state on submit", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("password123");

    const submitBtn = page.locator("button.btn-primary[type='submit']");
    await submitBtn.click();

    // Button should show loading state (spinner visible or loading class)
    const spinner = page.locator("button.btn-primary .spinner");
    await expect(spinner).toBeAttached();
  });

  test("settings gear button is visible", async ({ page }) => {
    const settingsGear = page.locator(".settings-gear");
    await expect(settingsGear).toBeVisible();
  });

  test("server panel header displays Servers title", async ({ page }) => {
    const header = page.locator(".server-panel-header");
    await expect(header).toBeVisible();
  });

  test("form logo shows OwnCord branding", async ({ page }) => {
    const logo = page.locator(".form-logo");
    await expect(logo).toBeVisible();

    // The logo contains an SVG with the "OC" text and an h1 with "OwnCord"
    const logoSvg = logo.locator("svg.oc-logo");
    await expect(logoSvg).toBeVisible();

    const logoTitle = logo.locator("h1");
    await expect(logoTitle).toHaveText("OwnCord");
  });

  test("status bar exists at bottom of form", async ({ page }) => {
    const statusBar = page.locator(".status-bar");
    await expect(statusBar).toBeAttached();
  });
});

// ---------------------------------------------------------------------------
// Tests: Login Error
// ---------------------------------------------------------------------------

test.describe("Connect Page — Login Error", () => {
  test("shows error banner on failed login", async ({ page }) => {
    await mockTauriLoginError(page);
    await page.goto("/");

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("wrongpassword");
    await page.locator("button.btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner.visible");
    await expect(errorBanner).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Tests: TOTP Flow
// ---------------------------------------------------------------------------

test.describe("Connect Page — TOTP", () => {
  test("TOTP overlay appears when login requires 2FA", async ({ page }) => {
    await mockTauriConnectWith2FA(page);
    await page.goto("/");

    const totpOverlay = page.locator(".totp-overlay");
    await expect(totpOverlay).toHaveClass(/totp-overlay--hidden/);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("password123");
    await page.locator("button.btn-primary[type='submit']").click();

    await expect(totpOverlay).not.toHaveClass(/totp-overlay--hidden/, {
      timeout: 10_000,
    });

    const totpInput = totpOverlay.locator("input[inputmode='numeric']");
    await expect(totpInput).toBeVisible();

    const verifyBtn = totpOverlay.locator("button.btn-primary");
    await expect(verifyBtn).toHaveText("Verify");
  });

  test("TOTP back button cancels 2FA flow", async ({ page }) => {
    await mockTauriConnectWith2FA(page);
    await page.goto("/");

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("password123");
    await page.locator("button.btn-primary[type='submit']").click();

    const totpOverlay = page.locator(".totp-overlay");
    await expect(totpOverlay).not.toHaveClass(/totp-overlay--hidden/, {
      timeout: 10_000,
    });

    const backBtn = totpOverlay.locator(".totp-back");
    await backBtn.click();

    await expect(totpOverlay).toHaveClass(/totp-overlay--hidden/);
  });

  test("TOTP overlay shows title and subtitle", async ({ page }) => {
    await mockTauriConnectWith2FA(page);
    await page.goto("/");

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("password123");
    await page.locator("button.btn-primary[type='submit']").click();

    const totpOverlay = page.locator(".totp-overlay");
    await expect(totpOverlay).not.toHaveClass(/totp-overlay--hidden/, {
      timeout: 10_000,
    });

    const title = totpOverlay.locator(".totp-title");
    await expect(title).toBeVisible();

    const subtitle = totpOverlay.locator(".totp-subtitle");
    await expect(subtitle).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: Full Login → Connected Overlay
// ---------------------------------------------------------------------------

test.describe("Connect Page — Login Success", () => {
  test("after login, connected overlay appears then main page renders", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await submitLogin(page);

    const overlay = page.locator(".connected-overlay");
    await expect(overlay).toBeVisible({ timeout: 10_000 });

    const appLayout = page.locator(".app");
    await expect(appLayout).toBeVisible({ timeout: 15_000 });
  });
});
