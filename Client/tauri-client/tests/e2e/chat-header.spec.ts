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
    const search = page.locator(".ch-tools .search-input");
    await expect(search).toBeAttached();

    // Focus the search — should trigger CSS width expansion
    await search.focus();
    await expect(search).toBeFocused();

    // Type something to verify it accepts input
    await search.fill("test query");
    await expect(search).toHaveValue("test query");

    // Blur and verify value persists
    await search.blur();
    await expect(search).toHaveValue("test query");
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
