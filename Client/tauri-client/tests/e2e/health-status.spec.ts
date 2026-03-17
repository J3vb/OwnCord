import { test, expect } from "@playwright/test";
import { buildTauriMockScript } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Health Status Indicator
// ---------------------------------------------------------------------------

test.describe("Health Status Indicator", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      ],
      simulateWsFlow: false,
    }));
    await page.goto("/");
  });

  test("status dot element exists on page load", async ({ page }) => {
    const statusDot = page.locator(".srv-status-dot").first();
    await expect(statusDot).toBeAttached();
  });

  test("status dot gets a non-unknown class after health check resolves", async ({ page }) => {
    const statusDot = page.locator(".srv-status-dot").first();

    // Wait for the health check to resolve and update the dot class
    // The dot starts as "srv-status-dot unknown", then transitions to
    // "srv-status-dot checking", and finally to "srv-status-dot online" (or "slow")
    await expect(statusDot).not.toHaveClass(/\bunknown\b/, { timeout: 10_000 });
  });
});
