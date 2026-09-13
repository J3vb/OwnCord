/**
 * E2E tests for the saved-password login path (OCV-001).
 *
 * The plaintext password no longer crosses IPC. When one is stored, the login
 * form shows a placeholder and submitting calls `login_with_saved_password`,
 * which performs the login inside the Rust backend and relays the server's raw
 * status and body. The unit tests cover the two halves separately — the Rust
 * relay and `parseRelayedLogin` — so what these cover is the join between them,
 * including the 2FA union, which is the part nothing else exercises.
 */
import { test, expect } from "./fixtures";
import { buildTauriMockScript, MOCK_LOGIN_2FA_RESPONSE, MOCK_TOKEN } from "./helpers";

const PROFILE = {
  id: "p1",
  name: "Local",
  host: "localhost:8443",
  username: "saveduser",
  autoConnect: false,
  rememberPassword: true,
  color: "#5865f2",
  lastConnected: null,
};

async function mockWithSavedPassword(
  page: import("@playwright/test").Page,
  savedPasswordLogin: { status: number; body: unknown },
  simulateWsFlow = true,
): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        // A typed-password login would go here. These tests assert it is NOT
        // used, so it returns a token that would be visibly wrong if it were.
        {
          pattern: "/api/v1/auth/login",
          status: 200,
          body: { token: "typed-password-token", requires_2fa: false },
        },
        {
          pattern: "/api/v1/auth/verify-totp",
          status: 200,
          body: { token: MOCK_TOKEN, requires_2fa: false },
        },
      ],
      simulateWsFlow,
      storedCredential: { username: "saveduser", token: "stored-token", has_password: true },
      savedPasswordLogin,
      storedSettings: {
        "owncord:profiles": { schemaVersion: 1, profiles: [PROFILE] },
      },
    }),
  );
}

/** Click the saved server and wait for the password box to show its placeholder. */
async function selectSavedServer(page: import("@playwright/test").Page): Promise<void> {
  await page.locator(".server-item").first().click();
  const password = page.locator("#password");
  await expect(password).not.toHaveValue("", { timeout: 5000 });
}

test.describe("Saved-password login", () => {
  test("fills the password box without exposing any plaintext", async ({ page }) => {
    await mockWithSavedPassword(page, {
      status: 200,
      body: { token: MOCK_TOKEN, requires_2fa: false },
    });
    await page.goto("/");
    await selectSavedServer(page);

    // The box reads as filled — that is what "Remember password" promises —
    // but the value is a placeholder, and load_credential carried no password.
    const value = await page.locator("#password").inputValue();
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toContain("password");
    await expect(page.locator("#remember-password")).toBeChecked();
  });

  test("submits through the backend rather than as form text", async ({ page }) => {
    await mockWithSavedPassword(page, {
      status: 200,
      body: { token: MOCK_TOKEN, requires_2fa: false },
    });
    await page.goto("/");
    await selectSavedServer(page);
    await page.locator(".btn-primary[type='submit']").click();

    await expect
      .poll(async () => page.evaluate(() => window.__mockSavedPasswordLogins ?? []), {
        timeout: 10000,
      })
      .toEqual([{ host: "localhost:8443", username: "saveduser" }]);
  });

  test("carries a 2FA challenge into the TOTP overlay and completes", async ({ page }) => {
    // The union Rust relays verbatim: the saved-password path must reach the
    // same TOTP overlay a typed-password login does.
    await mockWithSavedPassword(page, { status: 200, body: MOCK_LOGIN_2FA_RESPONSE });
    await page.goto("/");
    await selectSavedServer(page);
    await page.locator(".btn-primary[type='submit']").click();

    const totpOverlay = page.locator(".totp-overlay");
    await expect(totpOverlay).not.toHaveClass(/totp-overlay--hidden/, { timeout: 10000 });

    await page.locator(".totp-overlay input[inputmode='numeric']").fill("123456");
    await page.locator(".totp-overlay button.btn-primary").click();

    // Verifying completes the session and the client moves on to connecting,
    // proving the saved-password path reaches the same end state as a typed one.
    await expect(page.locator(".connected-overlay")).toBeVisible({ timeout: 10000 });
  });

  test("shows the server's message when the saved password is rejected", async ({ page }) => {
    await mockWithSavedPassword(
      page,
      {
        status: 401,
        body: { error: "INVALID_CREDENTIALS", message: "Invalid username or password" },
      },
      false,
    );
    await page.goto("/");
    await selectSavedServer(page);
    await page.locator(".btn-primary[type='submit']").click();

    // A relayed error must surface, not strand the form loading.
    await expect(page.locator(".login-message, .error-banner").first()).toContainText(/invalid/i, {
      timeout: 10000,
    });
  });

  test("falls back to a typed password once the user edits the box", async ({ page }) => {
    await mockWithSavedPassword(page, {
      status: 200,
      body: { token: MOCK_TOKEN, requires_2fa: false },
    });
    await page.goto("/");
    await selectSavedServer(page);

    const password = page.locator("#password");
    await password.click();
    await password.press("a");
    // The placeholder is replaced outright rather than appended to.
    await expect(password).toHaveValue("a");
    await password.fill("typed-password-123");
    await page.locator(".btn-primary[type='submit']").click();

    // The backend relay must NOT have been used for a typed password.
    await expect
      .poll(async () => page.evaluate(() => window.__mockSavedPasswordLogins ?? []), {
        timeout: 10000,
      })
      .toEqual([]);
  });

  test("declining to be remembered deletes the stored credential", async ({ page }) => {
    // OCV-022: the opt-out is an instruction, not just an absence of one.
    await mockWithSavedPassword(page, {
      status: 200,
      body: { token: MOCK_TOKEN, requires_2fa: false },
    });
    await page.goto("/");
    await selectSavedServer(page);

    const password = page.locator("#password");
    await password.click();
    await password.press("a");
    await password.fill("typed-password-123");
    await page.locator("#remember-password").uncheck();
    await page.locator(".btn-primary[type='submit']").click();

    await expect
      .poll(async () => page.evaluate(() => window.__mockDeletedCredentials ?? []), {
        timeout: 10000,
      })
      .toContain("localhost:8443");
  });
});
