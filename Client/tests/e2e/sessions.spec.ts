/**
 * BPR-035 (B7-14): a user sees every device signed in to their account, is
 * told about a sign-in not yet reviewed, and can sign out one device or all
 * of them.
 */
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithSessions, navigateToMainPage, openSettings } from "./helpers";

test.describe("Signed-in devices", () => {
  test("notice, device list, sign out one device, then sign out everywhere", async ({ page }) => {
    await mockTauriFullSessionWithSessions(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // The other desktop's sign-in is announced; this device's own row is not.
    const toast = page.locator("[data-testid='toast']", { hasText: "not reviewed" });
    await expect(toast).toContainText("OwnCord desktop from 198.51.100.2");
    await expect(toast).toContainText("Settings > Account");

    await openSettings(page);
    const rows = page.locator("[data-testid='session-row']");
    await expect(rows).toHaveCount(2);
    const current = rows.filter({ hasText: "This device" });
    await expect(current).toContainText("203.0.113.5");
    await expect(current.locator("[data-testid='session-revoke']")).toHaveCount(0);

    // Sign out the other device.
    await rows
      .filter({ hasText: "198.51.100.2" })
      .locator("[data-testid='session-revoke']")
      .click();
    await expect(rows).toHaveCount(1);
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Device signed out" }),
    ).toBeVisible();

    // Sign out everywhere: confirmation first, and it names this device.
    await page.locator("[data-testid='sessions-revoke-all']").click();
    await expect(page.locator("[data-testid='sessions-revoke-all-confirm-area']")).toContainText(
      "including this one",
    );
    await page.locator("[data-testid='sessions-revoke-all-confirm']").click();

    // This device's session was revoked too, so the app is back at sign-in.
    await expect(page.locator(".connect-form, .login-form")).toBeVisible({ timeout: 5000 });
  });
});
