/**
 * B7-15b: account recovery works end to end from the client (decision 8's
 * one mocked scenario for the recovery flow). A user who lost password and
 * 2FA device recovers with a secret, lands signed in, issues a fresh recovery
 * kit and regenerates the emergency codes; a user with only the authenticator
 * gone signs in with an emergency recovery code.
 */
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_AUTH_OK,
  MOCK_LOGIN_2FA_RESPONSE,
  MOCK_LOGIN_RESPONSE,
  openSettings,
} from "./helpers";

const KIT_SECRET = "K7QF-3M2X-9PLA-ZB5A-QW2E-TT7Y-AAAA-BBBB";
const CODES = ["7KQ3M-RX2WN", "P4HT9-ZC6VB"];

const ROUTE_HEALTH = {
  pattern: "/api/v1/health",
  status: 200,
  body: { status: "ok", version: "1.0.0" },
};

test.describe("Account recovery", () => {
  test("recover with a secret, then issue a kit and regenerate codes", async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ROUTE_HEALTH,
          { pattern: "/api/v1/auth/recover", status: 200, body: MOCK_LOGIN_RESPONSE },
          {
            pattern: "/api/v1/auth/me",
            status: 200,
            body: { ...MOCK_AUTH_OK.payload.user, totp_enabled: true },
          },
          {
            pattern: "/api/v1/users/me/recovery-kit",
            method: "GET",
            status: 200,
            body: { enrolled: false, used_at: "2026-09-21T08:00:00Z" },
          },
          {
            pattern: "/api/v1/users/me/recovery-kit",
            method: "POST",
            status: 200,
            body: { kit_secret: KIT_SECRET, created_at: "2026-09-21T09:00:00Z" },
          },
          {
            pattern: "/api/v1/users/me/totp/recovery-codes",
            status: 200,
            body: { backup_codes: CODES },
          },
        ],
        simulateWsFlow: true,
      }),
    );
    await page.goto("/");

    await page.locator("#host").fill("localhost:8443");
    await page.locator("[data-testid='recover-account-link']").click();
    const overlay = page.locator("[data-testid='recover-overlay']");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(
      "Recovery kit secret or a recovery credential from your server owner",
    );
    await page.locator("#recover-username").fill("testuser");
    await page.locator("#recover-secret").fill(KIT_SECRET);
    await page.locator("#recover-password").fill("N3w-Str0ng!Pass");
    await page.locator("[data-testid='recover-submit']").click();

    // Signed in exactly as a login is.
    await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });

    await openSettings(page);
    // The spent kit reads as used; issue a fresh one, shown once.
    await expect(page.locator("[data-testid='recovery-kit-status']")).toHaveText("Used");
    const kit = page.locator("[data-testid='recovery-kit-section']");
    await kit.locator("[data-testid='recovery-kit-btn']").click();
    await kit.locator("[data-testid='recovery-kit-password']").fill("N3w-Str0ng!Pass");
    await kit.locator("[data-testid='recovery-kit-submit']").click();
    await expect(kit.locator("[data-testid='recovery-kit-secret']")).toHaveText(KIT_SECRET);
    await kit.locator("[data-testid='shown-once-done']").click();
    await expect(kit.locator("[data-testid='recovery-kit-secret']")).toHaveCount(0);

    // 2FA is still enrolled, so the old emergency codes need replacing.
    await page.locator("[data-testid='totp-regenerate-btn']").click();
    await page.locator("[data-testid='totp-regenerate-password']").fill("N3w-Str0ng!Pass");
    await page.locator("[data-testid='totp-regenerate-submit']").click();
    const codes = page.locator("[data-testid='totp-regenerated-codes']");
    await expect(codes).toContainText(CODES[0]!);

    // Leaving the section takes the codes out of the page.
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='settings-overlay']")).not.toHaveClass(/open/);
    await expect(page.locator("[data-testid='totp-regenerated-codes']")).toHaveCount(0);
    expect(await page.content()).not.toContain(CODES[1]!);
  });

  test("an emergency recovery code completes a 2FA sign-in", async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ROUTE_HEALTH,
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_2FA_RESPONSE },
          {
            pattern: "/api/v1/auth/verify-totp",
            status: 200,
            body: { ...MOCK_LOGIN_RESPONSE, recovery_codes_remaining: 9 },
          },
        ],
        simulateWsFlow: true,
      }),
    );
    await page.goto("/");
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("password123");
    await page.locator("button.btn-primary[type='submit']").click();

    const code = page.locator(".totp-overlay input[autocomplete='one-time-code']");
    await expect(code).toBeVisible({ timeout: 5000 });
    await code.fill("7kq3m-rx2wn");
    await page.locator(".totp-overlay button.btn-primary").click();

    await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  });
});
