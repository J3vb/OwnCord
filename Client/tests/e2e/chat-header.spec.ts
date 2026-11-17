import { test, expect } from "./fixtures";
import { startFullSession, useLeftMemberList } from "./helpers";

test.describe("Chat Header", () => {
  test.beforeEach(async ({ page }) => {
    await startFullSession(page);
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

  test("member list is visible in the right column by default", async ({ page }) => {
    // No stored layout: the default is the right-hand column (3C-6c).
    const column = page.locator("[data-testid='member-column']");
    await expect(column).toBeVisible({ timeout: 3000 });
    await expect(column).toContainText("testuser");
    await expect(column).toContainText("otheruser");
    await expect(page.locator("[data-testid='sidebar-members']")).toHaveCount(0);
  });

  test("the search box opens on click, not on focus, and keeps what is typed", async ({ page }) => {
    // The search box is a trigger: Tab passes over it, and a click opens the
    // SearchOverlay. Keys typed right after the click, while the overlay is
    // still loading, reach the overlay's field and not the message box.
    const search = page.locator(".ch-tools .search-input");
    await expect(search).toHaveAttribute("placeholder", "Search...");
    const overlay = page.locator("[data-testid='search-overlay']");

    await search.focus();
    await expect(search).toBeFocused();
    await expect(overlay).toHaveCount(0);

    await search.click();
    await page.keyboard.type("hello");

    await expect(overlay).toHaveClass(/open/, { timeout: 3_000 });
    const field = page.locator("[data-testid='search-overlay-input']");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("hello");
    await expect(page.locator("[data-testid='msg-textarea']")).toHaveValue("");
  });

  test("pin button opens pinned messages panel", async ({ page }) => {
    const pinBtn = page.locator("[data-testid='pin-btn']");
    await expect(pinBtn).toBeVisible();

    await pinBtn.click();

    const pinnedPanel = page.locator(".pinned-panel");
    await expect(pinnedPanel).toBeVisible({ timeout: 3000 });

    // Close it
    const closeBtn = pinnedPanel.locator(".side-panel__close");
    await closeBtn.click();
    await expect(pinnedPanel).not.toBeAttached({ timeout: 3000 });
  });
});

test.describe("Chat Header — member list under the channels", () => {
  test.beforeEach(async ({ page }) => {
    // The default moved to the right column in 3C-6c; this is the left layout.
    await useLeftMemberList(page);
    await startFullSession(page);
  });

  test("member list is always visible in sidebar", async ({ page }) => {
    const memberList = page.locator("[data-testid='sidebar-members']");
    await expect(memberList).toBeVisible({ timeout: 3000 });

    // "Always visible" means the member roster rendered, not merely that an
    // empty container exists: assert the seeded member names are in it.
    await expect(memberList).toContainText("testuser");
    await expect(memberList).toContainText("otheruser");
  });
});
