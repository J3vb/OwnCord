import { test, expect } from "./fixtures";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Unified Sidebar Header
// The sidebar header carries the server identity. (This spec began life as
// server-strip.spec.ts; the ServerStrip component was deleted in favor of this
// unified header with a quick-switch overlay, and the file now tests the
// replacement.)
//
// The invite button's open→manager journey (list, create, Escape, backdrop,
// close) is covered by overlays.spec.ts:190-236; the old attachment-only smoke
// rows here asserted nothing about it and were removed as redundant.
// ---------------------------------------------------------------------------

test.describe("Unified Sidebar Header", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("header is visible and the server icon shows the server initials", async ({ page }) => {
    const header = page.locator(".unified-sidebar-header");
    await expect(header).toBeVisible();

    const icon = header.locator(".server-icon-sm");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText("OC");
  });
});
