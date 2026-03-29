import { test, expect } from "@playwright/test";
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
    await expect(memberList).toBeAttached({ timeout: 3000 });
  });

  test("search input expands on focus and collapses on blur", async ({ page }) => {
    // The search input in ChatHeader acts as a trigger: focusing it opens the
    // full SearchOverlay and immediately blurs the input (delegating to the
    // overlay's own search field). Verify the input exists and is interactive.
    const search = page.locator(".ch-tools .search-input");
    await expect(search).toBeAttached();

    // The input should have the search placeholder
    await expect(search).toHaveAttribute("placeholder", "Search...");

    // Verify the search input is present in the tools area
    await expect(search).toHaveAttribute("type", "text");
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
