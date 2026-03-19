import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage, emitWsEvent, emitWsMessage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Server Banner (reconnection)
// ---------------------------------------------------------------------------

test.describe("Server Banner", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("reconnecting banner is hidden by default", async ({ page }) => {
    const banner = page.locator(".reconnecting-banner");
    await expect(banner).toBeAttached();
    await expect(banner).not.toHaveClass(/visible/);
  });

  test("banner appears on WS disconnect", async ({ page }) => {
    // Simulate WebSocket disconnection
    await emitWsEvent(page, "ws-state", "closed");

    const banner = page.locator(".reconnecting-banner.visible");
    await expect(banner).toBeVisible({ timeout: 5_000 });
  });

  test("banner shows reconnecting text", async ({ page }) => {
    await emitWsEvent(page, "ws-state", "closed");

    const banner = page.locator(".reconnecting-banner.visible");
    await expect(banner).toBeVisible({ timeout: 5_000 });

    const text = await banner.textContent();
    expect(text).toMatch(/reconnect/i);
  });

  test("banner disappears on WS reconnect", async ({ page }) => {
    // Disconnect
    await emitWsEvent(page, "ws-state", "closed");
    const banner = page.locator(".reconnecting-banner.visible");
    await expect(banner).toBeVisible({ timeout: 5_000 });

    // Reconnect
    await emitWsEvent(page, "ws-state", "open");

    // Banner should hide after reconnection
    const hiddenBanner = page.locator(".reconnecting-banner");
    await expect(hiddenBanner).not.toHaveClass(/visible/, { timeout: 5_000 });
  });

  test("server_restart event shows restart countdown banner", async ({ page }) => {
    await emitWsMessage(page, {
      type: "server_restart",
      payload: { reason: "update", delay_seconds: 30 },
    });

    const banner = page.locator(".reconnecting-banner.visible");
    await expect(banner).toBeVisible({ timeout: 5_000 });

    const text = await banner.textContent();
    expect(text).toMatch(/restart/i);
  });
});
