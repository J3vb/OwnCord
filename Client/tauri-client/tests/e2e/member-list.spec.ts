import { test, expect } from "@playwright/test";
import { mockTauriFullSession, mockTauriFullSessionWithMessages, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Member List
// ---------------------------------------------------------------------------

test.describe("Member List", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("member list is visible", async ({ page }) => {
    const memberList = page.locator(".member-list");
    await expect(memberList).toBeVisible();
  });

  test("member list shows role groups", async ({ page }) => {
    const roleGroups = page.locator(".member-role-group");
    const count = await roleGroups.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("member items display usernames", async ({ page }) => {
    const memberItem = page.locator(".member-item").first();
    await expect(memberItem).toBeVisible();

    const name = memberItem.locator(".mi-name");
    await expect(name).toBeVisible();
  });

  test("member items show avatars", async ({ page }) => {
    const memberItem = page.locator(".member-item").first();
    const avatar = memberItem.locator(".mi-avatar");
    await expect(avatar).toBeVisible();
  });

  test("member items show status indicators", async ({ page }) => {
    const memberItem = page.locator(".member-item").first();
    const status = memberItem.locator(".mi-status");
    await expect(status).toBeAttached();
  });
});

test.describe("Member List — Multi-role", () => {
  test("shows members from multiple roles", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const memberList = page.locator(".member-list");
    await expect(memberList).toBeVisible();

    const members = page.locator(".member-item");
    const count = await members.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("offline members have offline class", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Wait for member list to populate
    await page.waitForTimeout(500);

    const offlineMembers = page.locator(".member-item.offline");
    const count = await offlineMembers.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
