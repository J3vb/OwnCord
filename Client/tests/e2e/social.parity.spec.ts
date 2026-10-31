/**
 * Mocked E2E: Social parity — group DM create/leave and role change via the
 * member context menu.
 *
 * Both flows are HTTP-only from the client's side (no ws_send involved):
 *   - Group DM create:  POST /api/v1/dms/group   (SidebarDmHelpers.handleCreateGroupDm)
 *   - Group DM leave:   DELETE /api/v1/dms/{id}  (SidebarArea.closeOrLeaveDm → api.closeDm)
 *   - Change Role:      PATCH /api/v1/moderation/members/{id} { role_id }  (features/members/memberPanel onChangeRole)
 *
 * A `wrappers` entry wraps window.__TAURI_INTERNALS__.invoke (run inside the
 * init script buildTauriMockScript installs) to record every HTTP fetch
 * and ws_send call into window.__capturedCalls, so tests can assert the exact
 * outgoing request/method/body instead of only the resulting DOM state.
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_PINNED_MESSAGES,
  MOCK_ROLES,
  MOCK_MEMBERS_MULTI_ROLE,
  navigateToMainPage,
  waitForWsReady,
  openHome,
  BASE_SESSION_ROUTES,
  groupDmChannel,
} from "./helpers";
import { captureCalls, waitForCapturedCall } from "./support/ipcCapture";

// ---------------------------------------------------------------------------
// Feature 1: Group DM create + leave
// ---------------------------------------------------------------------------

const GROUP_DM_CHANNEL_ID = 900;

/** The group DM seeded in the ready payload, used for the render+leave slice. */
const SEEDED_GROUP_DM = groupDmChannel(GROUP_DM_CHANNEL_ID);

/** The server's response to POST /dms/group, for the create-flow slice. */
const CREATED_GROUP_DM = {
  channel_id: 901,
  recipient: { id: 2, username: "moderator1", avatar: "", status: "online" },
  recipients: [
    { id: 2, username: "moderator1", avatar: "", status: "online" },
    { id: 3, username: "member1", avatar: "", status: "idle" },
  ],
  name: "",
  is_group: true,
  last_message_id: null,
  last_message: "",
  last_message_at: "2026-03-15T12:05:00Z",
  unread_count: 0,
  mention_count: 0,
};

async function mockSocialSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      wrappers: [captureCalls],
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        // More specific pattern first is not required — buildTauriMockScript
        // sorts by pattern length, so "/api/v1/dms/group" always outranks the
        // shorter generic "/api/v1/dms/" leave/close pattern below.
        { pattern: "/api/v1/dms/group", status: 200, body: CREATED_GROUP_DM },
        { pattern: "/api/v1/dms/", status: 200, body: { success: true } },
        { pattern: "/api/v1/moderation/members/", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: MOCK_MEMBERS_MULTI_ROLE,
        dm_channels: [SEEDED_GROUP_DM],
      },
    }),
  );
}

test.describe("@parity Group DM create + leave", () => {
  test.beforeEach(async ({ page }) => {
    await mockSocialSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await waitForWsReady(page);
  });

  test("member picker creates a group DM from 2+ selected members", async ({ page }) => {
    // Entry point: the "+" button in the Home DM list.
    await openHome(page);
    const newDmBtn = page.locator(".dm-section-label .dm-add");
    await expect(newDmBtn).toBeVisible({ timeout: 5_000 });
    await newDmBtn.click();

    const modal = page.locator(".dm-member-picker-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Select two members — the picker itself decides "group" once 2+ are picked.
    const pick2 = page.locator("[data-testid='dm-picker-member-2']");
    const pick3 = page.locator("[data-testid='dm-picker-member-3']");
    await expect(pick2).toBeVisible();
    await expect(pick3).toBeVisible();
    await pick2.click();
    await pick3.click();

    const createBtn = page.locator("[data-testid='dm-picker-create']");
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toHaveText("Create Group DM (3)");

    await createBtn.click();

    // Outgoing request: POST /api/v1/dms/group with both recipient ids.
    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").includes("/api/v1/dms/group"),
    );
    expect(call.method).toBe("POST");
    const body = JSON.parse(call.body ?? "{}") as { recipient_ids: number[]; name: string };
    expect(body.recipient_ids.toSorted()).toEqual([2, 3]);

    // Round-trip observable effect: the app switches into the new group DM.
    const backHeader = page.locator("[data-testid='dm-back-header']");
    await expect(backHeader).toBeVisible({ timeout: 5_000 });
  });

  test("a group DM in dm_channels renders stacked avatars + member count, and Leave Group fires DELETE", async ({
    page,
  }) => {
    // Home switches into full DM sidebar mode, where DmSidebar renders the
    // group-specific chrome.
    await openHome(page);

    const groupItem = page.locator(`.dm-item[data-channel-id="${GROUP_DM_CHANNEL_ID}"]`);
    await expect(groupItem).toBeVisible({ timeout: 5_000 });

    // Stacked avatars + participant count (2 recipients + self = 3).
    const avatarStack = page.locator(`[data-testid='dm-avatar-stack-${GROUP_DM_CHANNEL_ID}']`);
    await expect(avatarStack).toBeVisible();
    const memberCount = page.locator(`[data-testid='dm-members-${GROUP_DM_CHANNEL_ID}']`);
    await expect(memberCount).toHaveText("3");

    // Leave via the row's context menu (avoids relying on the hover-only close button).
    await groupItem.click({ button: "right" });
    const leaveItem = page.locator(`[data-testid='dm-close-${GROUP_DM_CHANNEL_ID}']`);
    await expect(leaveItem).toBeVisible({ timeout: 5_000 });
    await expect(leaveItem).toHaveText("Leave Group");
    await leaveItem.click();
    // Leaving a group is destructive, so it asks first (DP-34).
    await page.locator("[data-testid='dm-leave-confirm']").click();

    const call = await waitForCapturedCall(
      page,
      (c) =>
        c.cmd === "plugin:http|fetch" &&
        (c.url ?? "").includes(`/api/v1/dms/${GROUP_DM_CHANNEL_ID}`),
    );
    expect(call.method).toBe("DELETE");

    // Observable effect: the row is gone (removed optimistically, per
    // SidebarArea.closeOrLeaveDm's comment — it does not wait on the request).
    await expect(groupItem).not.toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Feature 2: Change Role via the member context menu
// ---------------------------------------------------------------------------

async function mockRoleChangeSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      wrappers: [captureCalls],
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        { pattern: "/api/v1/moderation/members/", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: MOCK_MEMBERS_MULTI_ROLE,
      },
    }),
  );
}

test.describe("@parity Change Role via member context menu", () => {
  test.beforeEach(async ({ page }) => {
    await mockRoleChangeSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await waitForWsReady(page);
  });

  test("admin sees Change Role with role options, and picking one fires the role-change request", async ({
    page,
  }) => {
    // testuser (local user, id 1) is "admin" — MANAGE_ROLES comes from the
    // ADMINISTRATOR bit in MOCK_ROLES, so the full admin menu renders.
    const target = page.locator("[data-testid='member-2']"); // moderator1, role "moderator"
    await expect(target).toBeVisible({ timeout: 5_000 });
    await target.click({ button: "right" });

    const menu = page.locator(".context-menu").first();
    await expect(menu).toBeVisible({ timeout: 5_000 });

    const roleTrigger = menu.locator(".context-menu__item", { hasText: "Change Role" });
    await expect(roleTrigger).toBeVisible();

    // The submenu is hidden until hover (JS mouseenter, not pure CSS :hover).
    await roleTrigger.hover();
    // Timeout is a second flyout in the same menu, so scope to the Change Role item.
    const submenu = roleTrigger.locator(".context-menu__submenu");
    await expect(submenu).toBeVisible();

    // All three server roles are offered (MOCK_ROLES, minus "owner" — none seeded).
    for (const role of MOCK_ROLES.map((r) => r.name)) {
      await expect(submenu.locator(".context-menu__item", { hasText: role })).toBeVisible();
    }

    // moderator1 is currently "moderator" — pick "member" instead.
    const memberOption = submenu.locator(".context-menu__item", { hasText: "member" }).first();
    await memberOption.click();

    // Outgoing request: PATCH /api/v1/moderation/members/2 { role_id: 3 } (member's id in MOCK_ROLES).
    const call = await waitForCapturedCall(
      page,
      (c) =>
        c.cmd === "plugin:http|fetch" && (c.url ?? "").includes("/api/v1/moderation/members/2"),
    );
    expect(call.method).toBe("PATCH");
    const body = JSON.parse(call.body ?? "{}") as { role_id: number };
    expect(body.role_id).toBe(3);
  });
});
