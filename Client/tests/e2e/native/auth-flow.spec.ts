/**
 * Native E2E: Authentication flows against the real server.
 *
 * Tests real login, invalid credentials, the loading state, saved server
 * profiles and the connect page UI.
 *
 * The fixture server uses a self-signed certificate. The Rust proxy refuses
 * the first TLS contact until the fingerprint is trusted — the real first-use
 * ceremony. The connect page's mount-time health probe only touches the
 * default localhost profile, so the submit is the first contact with the
 * fixture host and `submitLogin` trusts the prompt that follows it. Without
 * this the submit never reaches the server.
 */

import { test, expect } from "../native-fixture";
import type { Page } from "@playwright/test";
import { SERVER_URL, TEST_USER, TEST_PASS, SKIP_SERVER, hasCredentials } from "./helpers";

/** Fill the login form. Does not submit. */
async function fillLogin(page: Page, username: string, password: string): Promise<void> {
  await page.locator("#host").fill(SERVER_URL);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
}

/**
 * Trust the fixture server's first-use certificate if the prompt is up within
 * `timeoutMs`. Returns whether it trusted. The fingerprint stays pinned for
 * the life of the page, so a second call after the first is a no-op.
 */
async function trustCertIfPrompted(page: Page, timeoutMs: number): Promise<boolean> {
  const dialog = page.getByRole("dialog", { name: "New Server Certificate" });
  const appeared = await dialog
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;
  await dialog.getByRole("button", { name: "Trust This Certificate", exact: true }).click();
  await expect(dialog).toBeHidden();
  return true;
}

/** Submit the filled form for real, trusting the certificate on first contact. */
async function submitLogin(page: Page): Promise<void> {
  const submit = page.locator("button.btn-primary[type='submit']");
  await submit.click();

  // First TLS contact with the fixture host: the proxy refuses and the UI asks
  // for confirmation (the mount-time probe only ever touches the default
  // localhost profile, so the prompt reliably appears here).
  if (await trustCertIfPrompted(page, 15_000)) {
    // Accepting the fingerprint writes it asynchronously in Rust; confirming
    // the pin landed before resubmitting avoids a second first_use refusal —
    // the same wait helpers.nativeLogin performs.
    await expect
      .poll(() =>
        page.evaluate(
          (host) => (window as any).__TAURI_INTERNALS__.invoke("get_cert_fingerprint", { host }),
          SERVER_URL,
        ),
      )
      .toMatch(/^[0-9A-Fa-f:]+$/);
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();
  }
}

test.describe("Authentication Flow", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    // Wait for the connect form to be fully rendered
    await expect(nativePage.locator("#host")).toBeVisible({ timeout: 15_000 });
  });

  test("connect page renders all form fields", async ({ nativePage }) => {
    // Verify the connect page structure is complete in production
    await expect(nativePage.locator("#host")).toBeVisible();
    await expect(nativePage.locator("#username")).toBeVisible();
    await expect(nativePage.locator("#password")).toBeVisible();
    await expect(nativePage.locator("button.btn-primary[type='submit']")).toBeVisible();

    // Branding
    await expect(nativePage.locator(".form-logo")).toBeVisible();

    // Mode switch link (Login/Register toggle)
    await expect(nativePage.locator(".form-switch a")).toBeVisible();
  });

  test("password visibility toggle works", async ({ nativePage }) => {
    const passwordInput = nativePage.locator("#password");
    await passwordInput.fill("testpassword");

    // Should start as password type
    await expect(passwordInput).toHaveAttribute("type", "password");

    // Toggle visibility
    await nativePage.locator(".password-toggle").click();
    await expect(passwordInput).toHaveAttribute("type", "text");

    // Toggle back
    await nativePage.locator(".password-toggle").click();
    await expect(passwordInput).toHaveAttribute("type", "password");
  });

  test("login with invalid credentials shows server error", async ({ nativePage }) => {
    await fillLogin(nativePage, "nonexistent_user_e2e_test", "wrong_password_e2e_test");
    await submitLogin(nativePage);

    // The real server returns 400 INVALID_CREDENTIALS — the error banner
    // appears with the server's message, and the app layout is NOT reached.
    const errorBanner = nativePage.locator(".error-banner.visible");
    await expect(errorBanner).toBeVisible({ timeout: 10_000 });
    await expect(errorBanner).toContainText(/invalid/i);
    await expect(nativePage.locator("[data-testid='app-layout']")).not.toBeVisible();
  });

  test("submit button enters a loading state during the request", async ({ nativePage }) => {
    // Use a wrong password so this real request is refused by the server: it
    // still proves the loading state, without spending a successful login
    // against the 5/min per-IP login budget the whole no-auth project shares.
    await fillLogin(nativePage, "nonexistent_user_e2e_test", "wrong_password_e2e_test");

    const submit = nativePage.locator("button.btn-primary[type='submit']");
    await submit.click();

    // First TLS contact: trust the certificate, then resubmit for real.
    if (await trustCertIfPrompted(nativePage, 15_000)) {
      await expect(submit).toBeEnabled({ timeout: 10_000 });
    }

    // `transitionTo("loading")` runs synchronously in the submit handler,
    // before its first await, so clicking and reading the class in one
    // evaluate captures the real state without racing a fast response.
    const sawLoading = await nativePage.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("button.btn-primary[type='submit']");
      btn!.click();
      return { loading: btn!.classList.contains("loading"), disabled: btn!.disabled };
    });
    expect(sawLoading.loading).toBe(true);
    expect(sawLoading.disabled).toBe(true);

    // The server's refusal settles and the button leaves the loading state.
    await expect(submit).not.toHaveClass(/loading/, { timeout: 30_000 });
  });

  test("successful login reaches main app layout and completes the WS handshake", async ({
    nativePage,
  }) => {
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");

    await fillLogin(nativePage, TEST_USER, TEST_PASS);
    await submitLogin(nativePage);

    // HTTP login succeeded...
    await expect(nativePage.locator("[data-testid='app-layout']")).toBeVisible({
      timeout: 20_000,
    });
    // ...and the WS ready payload populated channels from the real server.
    await expect(nativePage.locator(".channel-item").first()).toBeVisible({ timeout: 15_000 });
  });

  test("saved server profile renders with name and host", async ({ nativePage }) => {
    // The fresh-profile fixture guarantees no saved servers on launch, so
    // create one through the real Add Server modal instead of skipping: a
    // conditional skip here meant this surface was never exercised in CI.
    const host = "saved-profile.example:8443";
    await nativePage.locator(".btn-add-server").click();

    const modal = nativePage.locator(".modal-overlay.visible .modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator(".modal-body .form-input").nth(0).fill("Saved Profile");
    await modal.locator(".modal-body .form-input").nth(1).fill(host);
    await modal.locator(".modal-footer .btn-primary").click();

    const serverItem = nativePage.locator(`.server-item[data-host='${host}']`);
    await expect(serverItem).toBeVisible({ timeout: 5_000 });
    await expect(serverItem.locator(".srv-name")).toHaveText("Saved Profile");
    await expect(serverItem.locator(".srv-meta .srv-host").first()).toHaveText(host);
  });

  test("clicking a saved server auto-fills the host field", async ({ nativePage }) => {
    const host = "auto-fill.example:8443";
    await nativePage.locator(".btn-add-server").click();

    const modal = nativePage.locator(".modal-overlay.visible .modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator(".modal-body .form-input").nth(0).fill("Auto Fill");
    await modal.locator(".modal-body .form-input").nth(1).fill(host);
    await modal.locator(".modal-footer .btn-primary").click();

    const serverItem = nativePage.locator(`.server-item[data-host='${host}']`);
    await expect(serverItem).toBeVisible({ timeout: 5_000 });

    // Click the row (not the action buttons) and assert the form's host input
    // picks up exactly this profile's host.
    await serverItem.locator(".srv-info").click();
    await expect(nativePage.locator("#host")).toHaveValue(host, { timeout: 5_000 });
  });

  test("can switch between login and register modes", async ({ nativePage }) => {
    const switchLink = nativePage.locator(".form-switch a");
    await expect(switchLink).toBeVisible();

    // Click to switch to register mode
    await switchLink.click();

    // Invite code field should appear in register mode
    const inviteField = nativePage.locator("#invite");
    await expect(inviteField).toBeVisible({ timeout: 3_000 });

    // Switch back
    await nativePage.locator(".form-switch a").click();

    // Invite field should be gone
    await expect(inviteField).not.toBeVisible({ timeout: 3_000 });
  });
});
