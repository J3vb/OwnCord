import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  mockTauriFullSessionWithMessages,
  navigateToMainPage,
  emitWsMessage,
} from "./helpers";

test.describe("Member List", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("renders members with role groups, avatars, names, and status", async ({ page }) => {
    const memberList = page.locator("[data-testid='member-list']");
    await expect(memberList).toBeVisible();

    // Should have at least one role group header
    const roleGroups = page.locator(".member-role-group");
    expect(await roleGroups.count()).toBeGreaterThanOrEqual(1);

    // First member should have all required elements
    const firstMember = page.locator("[data-testid='member-1']");
    await expect(firstMember).toBeVisible();
    await expect(firstMember.locator(".mi-avatar")).toBeVisible();
    await expect(firstMember.locator(".mi-name")).toBeVisible();
    await expect(firstMember.locator(".mi-status")).toBeAttached();
  });

  test("new member appears when member_join event is received", async ({ page }) => {
    const membersBefore = await page.locator(".member-item").count();

    await emitWsMessage(page, {
      type: "member_join",
      payload: {
        user: {
          id: 99,
          username: "newjoiner",
          avatar: "",
          role: "member",
        },
      },
    });

    // Wait for the new member to appear
    const newMember = page.locator(".mi-name", { hasText: "newjoiner" });
    await expect(newMember).toBeVisible({ timeout: 5_000 });

    const membersAfter = await page.locator(".member-item").count();
    expect(membersAfter).toBe(membersBefore + 1);
  });

  test("member disappears when member_ban event is received", async ({ page }) => {
    // Verify otheruser exists first
    const otherUser = page.locator(".mi-name", { hasText: "otheruser" });
    await expect(otherUser).toBeVisible({ timeout: 5_000 });

    const membersBefore = await page.locator(".member-item").count();

    await emitWsMessage(page, {
      type: "member_ban",
      payload: { user_id: 2 },
    });

    // otheruser should disappear
    await expect(otherUser).not.toBeVisible({ timeout: 5_000 });

    const membersAfter = await page.locator(".member-item").count();
    expect(membersAfter).toBe(membersBefore - 1);
  });

  test("member status updates when presence event is received", async ({ page }) => {
    // otheruser starts as "online"
    const otherUserItem = page.locator(".member-item").filter({
      has: page.locator(".mi-name", { hasText: "otheruser" }),
    });
    await expect(otherUserItem).toBeVisible({ timeout: 5_000 });

    // Should NOT have offline class initially
    await expect(otherUserItem).not.toHaveClass(/offline/);

    // Send presence update to offline
    await emitWsMessage(page, {
      type: "presence",
      payload: { user_id: 2, status: "offline" },
    });

    // Should now have offline class
    await expect(otherUserItem).toHaveClass(/offline/, { timeout: 5_000 });
  });

  test("member list is always visible in sidebar", async ({ page }) => {
    const sidebarMembers = page.locator("[data-testid='sidebar-members']");
    await expect(sidebarMembers).toBeAttached({ timeout: 3_000 });
  });
});

test.describe("Member List — Multi-role", () => {
  test("shows members grouped by role with correct counts", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const memberList = page.locator("[data-testid='member-list']");
    await expect(memberList).toBeVisible();

    // Multi-role mock has 5 members across different roles
    const members = page.locator(".member-item");
    expect(await members.count()).toBeGreaterThanOrEqual(3);

    // Multiple role groups should be present
    const roleGroups = page.locator(".member-role-group");
    expect(await roleGroups.count()).toBeGreaterThanOrEqual(2);

    // Offline members should have the offline class
    const offlineMembers = page.locator(".member-item.offline");
    await expect(offlineMembers.first()).toBeAttached({ timeout: 5000 });
  });
});
