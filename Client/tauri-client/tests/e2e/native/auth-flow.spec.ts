/**
 * Native E2E: Authentication flows against the real server.
 *
 * Tests real login, invalid credentials, credential persistence,
 * and the connect page UI with actual server responses.
 */

import { test, expect } from "../native-fixture";
import { SERVER_URL, TEST_USER, TEST_PASS, SKIP_SERVER, hasCredentials } from "./helpers";

test.describe("Authentication Flow", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    await nativePage.waitForLoadState("networkidle");
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
    await nativePage.locator("#host").fill(SERVER_URL);
    await nativePage.locator("#username").fill("nonexistent_user_e2e_test");
    await nativePage.locator("#password").fill("wrong_password_e2e_test");
    await nativePage.locator("button.btn-primary[type='submit']").click();

    // The real server should return an error — error banner appears
    const errorBanner = nativePage.locator(".error-banner");
    await expect(errorBanner).toBeVisible({ timeout: 10_000 });
  });

  test("submit button shows loading spinner during request", async ({ nativePage }) => {
    await nativePage.locator("#host").fill(SERVER_URL);
    await nativePage.locator("#username").fill("spinner_test_user");
    await nativePage.locator("#password").fill("spinner_test_pass");
    await nativePage.locator("button.btn-primary[type='submit']").click();

    // The spinner should appear while the request is in flight
    const spinner = nativePage.locator("button.btn-primary .spinner");
    // It may be very brief, so check it was at least attached
    await expect(spinner).toBeAttached({ timeout: 5_000 });
  });

  test("successful login reaches main app layout", async ({ nativePage }) => {
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");

    await nativePage.locator("#host").fill(SERVER_URL);
    await nativePage.locator("#username").fill(TEST_USER);
    await nativePage.locator("#password").fill(TEST_PASS);
    await nativePage.locator("button.btn-primary[type='submit']").click();

    // Should reach main app layout
    const appLayout = nativePage.locator("[data-testid='app-layout']");
    await expect(appLayout).toBeVisible({ timeout: 20_000 });
  });

  test("successful login completes WS handshake", async ({ nativePage }) => {
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");

    await nativePage.locator("#host").fill(SERVER_URL);
    await nativePage.locator("#username").fill(TEST_USER);
    await nativePage.locator("#password").fill(TEST_PASS);
    await nativePage.locator("button.btn-primary[type='submit']").click();

    // Wait for app layout
    await expect(nativePage.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 20_000 });

    // Channels should populate from the real ready payload
    const channelItem = nativePage.locator(".channel-item").first();
    await expect(channelItem).toBeVisible({ timeout: 15_000 });
  });

  test("saved server profile shows in sidebar", async ({ nativePage }) => {
    // If a server has been connected before, it should appear in the sidebar
    const serverItem = nativePage.locator(".server-item").first();
    const hasSavedServer = await serverItem.isVisible().catch(() => false);

    if (hasSavedServer) {
      // Verify server item has name and host info
      await expect(serverItem.locator(".srv-name")).toBeVisible();
      // srv-meta may contain multiple spans (host + username), just check the container
      await expect(serverItem.locator(".srv-meta")).toBeVisible();
    }
    // If no saved server, that's fine — first-time launch
  });

  test("clicking saved server auto-fills host field", async ({ nativePage }) => {
    const serverItem = nativePage.locator(".server-item").first();
    const hasSavedServer = await serverItem.isVisible().catch(() => false);
    test.skip(!hasSavedServer, "No saved server profiles");

    // Click the server item to auto-fill
    await serverItem.click();

    // Host field should be filled with the server address
    const hostValue = await nativePage.locator("#host").inputValue();
    expect(hostValue).toBeTruthy();
    expect(hostValue.length).toBeGreaterThan(0);
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
