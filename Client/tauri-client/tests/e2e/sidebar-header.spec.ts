import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Unified Sidebar Header
// The sidebar header carries the server identity, and the invite button is
// the header's primary action. (This spec began life as server-strip.spec.ts;
// the ServerStrip component was deleted in favor of this unified header with
// a quick-switch overlay, and the file now tests the replacement.)
// ---------------------------------------------------------------------------

test.describe("Unified Sidebar Header", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("header is visible with the server icon", async ({ page }) => {
    const header = page.locator(".unified-sidebar-header");
    await expect(header).toBeVisible();

    const icon = header.locator(".server-icon-sm");
    await expect(icon).toBeVisible();
  });

  test("server icon shows the server initials", async ({ page }) => {
    const icon = page.locator(".unified-sidebar-header .server-icon-sm");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText("OC");
  });

  test("invite button separates header from sidebar content", async ({ page }) => {
    const inviteBtn = page.locator("[data-testid='invite-btn']");
    await expect(inviteBtn).toBeAttached();
  });

  test("invite button is the header's primary action", async ({ page }) => {
    const inviteBtn = page.locator("[data-testid='invite-btn']");
    await expect(inviteBtn).toBeVisible();
    await expect(inviteBtn).toHaveText("Invite");
  });
});
