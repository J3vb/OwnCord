import { test, expect } from "./fixtures";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

test.describe("Chat Header", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("renders channel info with hash, name, tools, and search", async ({ page }) => {
    const header = page.locator("[data-testid='chat-header']");
    await expect(header).toBeVisible();
    await expect(header.locator(".ch-hash")).toBeVisible();
    const name = page.locator("[data-testid='chat-header-name']");
    await expect(name).toBeVisible();
    await expect(name).not.toBeEmpty();
    await expect(header.locator(".ch-topic")).toBeAttached();
    await expect(header.locator(".ch-tools")).toBeVisible();
    await expect(header.locator(".ch-tools .search-input")).toBeAttached();
  });

  test("member list is always visible in sidebar", async ({ page }) => {
    const memberList = page.locator("[data-testid='sidebar-members']");
    await expect(memberList).toBeVisible({ timeout: 3000 });

    // "Always visible" means the member roster rendered, not merely that an
    // empty container exists: assert the seeded member names are in it.
    await expect(memberList).toContainText("testuser");
    await expect(memberList).toContainText("otheruser");
  });

  test("focusing the search input opens the SearchOverlay", async ({ page }) => {
    // The search input is a trigger: focusing it opens the full SearchOverlay
    // and blurs itself, delegating to the overlay's own search field. Assert
    // the rendered overlay, not just that the trigger exists.
    const search = page.locator(".ch-tools .search-input");
    await expect(search).toHaveAttribute("placeholder", "Search...");

    await search.focus();

    const overlay = page.locator("[data-testid='search-overlay']");
    await expect(overlay).toHaveClass(/open/, { timeout: 3_000 });
    await expect(page.locator("[data-testid='search-overlay-input']")).toBeFocused();
    await expect(search).not.toBeFocused();
  });

  test("pin button opens pinned messages panel", async ({ page }) => {
    const pinBtn = page.locator("[data-testid='pin-btn']");
    await expect(pinBtn).toBeVisible();

    await pinBtn.click();

    const pinnedPanel = page.locator(".pinned-panel");
    await expect(pinnedPanel).toBeVisible({ timeout: 3000 });

    // Close it
    const closeBtn = pinnedPanel.locator(".pinned-panel__close");
    await closeBtn.click();
    await expect(pinnedPanel).not.toBeAttached({ timeout: 3000 });
  });
});
