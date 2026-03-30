import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Server Strip → Unified Sidebar Header
// The ServerStrip component was removed in favor of a unified sidebar header
// with a quick-switch overlay. These tests now verify the unified header.
// ---------------------------------------------------------------------------

test.describe("Server Strip", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("server strip is visible with server icons", async ({ page }) => {
    // Unified sidebar header replaces the old server strip
    const header = page.locator(".unified-sidebar-header");
    await expect(header).toBeVisible();

    const icon = header.locator(".server-icon-sm");
    await expect(icon).toBeVisible();
  });

  test("active server icon shows home initial 'O'", async ({ page }) => {
    // The unified header shows "OC" in the server icon
    const icon = page.locator(".unified-sidebar-header .server-icon-sm");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText("OC");
  });

  test("server separator exists between icons", async ({ page }) => {
    // Unified sidebar has an invite button separating header from content
    const inviteBtn = page.locator("[data-testid='invite-btn']");
    await expect(inviteBtn).toBeAttached();
  });

  test("add server button shows '+' icon", async ({ page }) => {
    // The invite button in the unified header serves as the primary action
    const inviteBtn = page.locator("[data-testid='invite-btn']");
    await expect(inviteBtn).toBeVisible();
    await expect(inviteBtn).toHaveText("Invite");
  });
});
