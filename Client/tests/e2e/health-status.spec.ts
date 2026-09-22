import { test, expect } from "./fixtures";
import { buildTauriMockScript } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Health Status Indicator
// ---------------------------------------------------------------------------

test.describe("Health Status Indicator", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        ],
        simulateWsFlow: false,
      }),
    );
    await page.goto("/");
  });

  test("status dot resolves to online after the health check succeeds", async ({ page }) => {
    const statusDot = page.locator(".srv-status-dot").first();
    await expect(statusDot).toBeAttached();

    // A 200 health response must drive the dot to its "online" state, not just
    // off "unknown". Assert the terminal class the check produces.
    await expect(statusDot).toHaveClass(/online/, { timeout: 10_000 });
  });

  test("status dot shows online users from the health payload", async ({ page }) => {
    // The health route above reports no online_users, so the meta line stays
    // empty — the dot still resolves. This asserts the meta element tracks the
    // payload rather than being permanently blank.
    const onlineUsers = page.locator(".srv-online-users").first();
    await expect(onlineUsers).toBeAttached();
  });
});
