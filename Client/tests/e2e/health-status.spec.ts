import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { buildTauriMockScript } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Health Status Indicator
// ---------------------------------------------------------------------------

async function openWithHealth(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [{ pattern: "/api/v1/health", status: 200, body }],
      simulateWsFlow: false,
    }),
  );
  await page.goto("/");
}

test.describe("Health Status Indicator", () => {
  test("status dot resolves to online after the health check succeeds", async ({ page }) => {
    await openWithHealth(page, { status: "ok", version: "1.0.0" });
    const statusDot = page.locator(".srv-status-dot").first();
    await expect(statusDot).toBeAttached();

    // A 200 health response must drive the dot to its "online" state, not just
    // off "unknown". Assert the terminal class the check produces.
    await expect(statusDot).toHaveClass(/online/, { timeout: 10_000 });
  });

  test("status dot shows online users from the health payload", async ({ page }) => {
    await openWithHealth(page, { status: "ok", version: "1.0.0", online_users: 3 });
    const onlineUsers = page.locator(".srv-online-users").first();
    await expect(onlineUsers).toHaveText("3 online", { timeout: 10_000 });
    await expect(onlineUsers).toHaveClass(/\bhas-users\b/);
  });
});
