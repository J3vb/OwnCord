import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  mockTauriFullSession,
  mockTauriFullSessionWithMessages,
  navigateToMainPage,
  emitWsMessage,
  openSettings,
  switchSettingsTab,
  waitForWsReady,
  MOCK_PINNED_MESSAGES,
  openDmRow,
  BASE_SESSION_ROUTES,
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
    // The ready roster can render in more than one pass, so wait for both
    // mocked members before taking the baseline count.
    await expect(page.locator(".mi-name", { hasText: "otheruser" })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator(".member-item")).toHaveCount(2);
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

    await expect(page.locator(".member-item")).toHaveCount(membersBefore + 1);
  });

  test("member disappears when member_ban event is received", async ({ page }) => {
    // Verify otheruser exists first
    const otherUser = page.locator(".mi-name", { hasText: "otheruser" });
    await expect(otherUser).toBeVisible({ timeout: 5_000 });

    await expect(page.locator(".member-item")).toHaveCount(2);
    const membersBefore = await page.locator(".member-item").count();

    await emitWsMessage(page, {
      type: "member_ban",
      payload: { user_id: 2 },
    });

    // otheruser should disappear
    await expect(otherUser).not.toBeVisible({ timeout: 5_000 });

    await expect(page.locator(".member-item")).toHaveCount(membersBefore - 1);
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

    // ...and sit under the OFFLINE header.
    const offlineHeader = page.locator("[data-testid='member-group-offline']");
    await expect(offlineHeader).toHaveText("OFFLINE — 1");
    await expect(
      offlineHeader.locator("xpath=following-sibling::*[1]").locator(".mi-name"),
    ).toHaveText("otheruser");
  });

  test("the search box filters the rows and Escape restores the list", async ({ page }) => {
    const search = page.locator("[data-testid='member-search']");
    await expect(search).toBeVisible({ timeout: 5_000 });
    const names = page.locator(".member-item .mi-name");
    await expect(names.first()).toBeVisible();
    const all = await names.allTextContents();
    expect(all).toContain("otheruser");

    await search.fill("@OTHERUS");
    await expect(names).toHaveText(["otheruser"]);
    await expect(page.locator(".member-role-group")).toHaveText([/— 1$/]);

    await search.fill("zzz-no-match");
    await expect(page.locator(".member-item")).toHaveCount(0);
    await expect(page.locator(".member-list-empty-text")).toHaveText(
      "No members match your search",
    );

    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(names).toHaveText(all);
  });

  test("member list is visible in the right column by default", async ({ page }) => {
    // No stored layout: the default is the right-hand column (3C-6c).
    const column = page.locator("[data-testid='member-column']");
    await expect(column).toBeVisible({ timeout: 3_000 });
    await expect(column.locator("[data-testid='member-list']")).toBeVisible();
    await expect(page.locator("[data-testid='sidebar-members']")).toHaveCount(0);
  });
});

test.describe("Member List — under the channels", () => {
  test.beforeEach(async ({ page }) => {
    // The default moved to the right column in 3C-6c; this is the left layout.
    await page.addInitScript(() => {
      localStorage.setItem("owncord:settings:memberListLayout", JSON.stringify("left"));
    });
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
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

    // Each role counts only its online members; offline people share the
    // last group.
    await expect(page.locator(".member-role-group")).toHaveText([
      "ADMIN — 1",
      "MODERATOR — 1",
      "MEMBER — 2",
      "OFFLINE — 1",
    ]);

    // Offline members should have the offline class
    const offlineMembers = page.locator(".member-item.offline");
    await expect(offlineMembers.first()).toBeAttached({ timeout: 5000 });
  });
});

// 3C-6b: the right-hand column, its header toggle and the Appearance setting.
test.describe("Member List — right column (3C-6b)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ...BASE_SESSION_ROUTES,
          { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        ],
        simulateWsFlow: true,
        readyOverrides: {
          dm_channels: [
            {
              channel_id: 100,
              recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
              last_message_id: 500,
              last_message: "Hey there!",
              last_message_at: "2026-03-15T12:00:00Z",
              unread_count: 0,
            },
          ],
        },
      }),
    );
    await page.addInitScript(() => {
      // Only on the first load: a reload must keep what the test changed.
      if (sessionStorage.getItem("e2e-seeded") !== null) return;
      sessionStorage.setItem("e2e-seeded", "1");
      localStorage.setItem("owncord:settings:memberListLayout", JSON.stringify("right"));
    });
    await page.goto("/");
    await navigateToMainPage(page);
    await waitForWsReady(page);
  });

  test("shows the seeded members in the column; the toggle hides it and the choice survives a reload", async ({
    page,
  }) => {
    const column = page.locator("[data-testid='member-column']");
    const toggle = page.locator("[data-testid='member-list-toggle']");
    await expect(column).toBeVisible();
    await expect(column.locator("[data-testid='member-1']")).toBeVisible();
    await expect(column.locator(".mi-name", { hasText: "otheruser" })).toBeVisible();
    await expect(page.locator("[data-testid='sidebar-members']")).toHaveCount(0);
    await expect(page.locator("[data-testid='member-list']")).toHaveCount(1);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAttribute("aria-controls", "member-column");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(column).toBeHidden();
    await expect(page.locator("[data-testid='member-list']")).toHaveCount(0);
    await expect(toggle).toBeFocused();

    await page.reload();
    await navigateToMainPage(page);
    await waitForWsReady(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(column).toBeHidden();

    await toggle.click();
    await expect(column).toBeVisible();
    await expect(column.locator("[data-testid='member-1']")).toBeVisible();
  });

  test("in a DM the toggle and the column are gone", async ({ page }) => {
    const column = page.locator("[data-testid='member-column']");
    const toggle = page.locator("[data-testid='member-list-toggle']");
    await expect(column).toBeVisible();

    await openDmRow(page);
    await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();
    await expect(toggle).toBeHidden();
    await expect(column).toBeHidden();
    await expect(page.locator("[data-testid='member-list']")).toHaveCount(0);
  });

  test("Appearance > Member list position moves the list under the channels, with one list throughout", async ({
    page,
  }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    const group = page.locator("[data-testid='member-layout']");
    await expect(group.locator("[aria-checked='true']")).toHaveAttribute("data-value", "right");

    await page.locator("[data-testid='member-layout-left']").click();
    await expect(page.locator("[data-testid='sidebar-members']")).toBeAttached();
    await expect(page.locator("[data-testid='member-column']")).toBeHidden();
    await expect(page.locator("[data-testid='member-list-toggle']")).toBeHidden();
    await expect(page.locator("[data-testid='member-list']")).toHaveCount(1);

    await page.locator("[data-testid='member-layout-right']").click();
    await expect(page.locator("[data-testid='sidebar-members']")).toHaveCount(0);
    await expect(
      page.locator("[data-testid='member-column'] [data-testid='member-list']"),
    ).toHaveCount(1);
    await expect(page.locator("[data-testid='member-list']")).toHaveCount(1);
  });
});
