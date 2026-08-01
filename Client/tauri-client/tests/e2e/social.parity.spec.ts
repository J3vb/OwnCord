/**
 * Mocked E2E: Social parity — group DM create/leave and role change via the
 * member context menu.
 *
 * Both flows are HTTP-only from the client's side (no ws_send involved):
 *   - Group DM create:  POST /api/v1/dms/group   (SidebarDmHelpers.handleCreateGroupDm)
 *   - Group DM leave:   DELETE /api/v1/dms/{id}  (SidebarArea.closeOrLeaveDm → api.closeDm)
 *   - Change Role:      PATCH /admin/api/users/{id} { role_id }  (SidebarMemberSection.onChangeRole)
 *
 * A second init script wraps window.__TAURI_INTERNALS__.invoke (installed
 * *after* the one buildTauriMockScript installs) to record every HTTP fetch
 * and ws_send call into window.__capturedCalls, so tests can assert the exact
 * outgoing request/method/body instead of only the resulting DOM state.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  MOCK_ROLES,
  MOCK_MEMBERS_MULTI_ROLE,
  navigateToMainPage,
  waitForWsReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// Call capture — records plugin:http|fetch and ws_send invocations
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly cmd: string;
  readonly method?: string;
  readonly url?: string;
  readonly body?: string | null;
  readonly message?: string;
}

/** Installed as a second init script, after the Tauri mock sets up `invoke`. */
function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__;
  const orig = internals.invoke;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__capturedCalls = [];
  internals.invoke = async (cmd: string, args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = args as any;
    if (cmd === "plugin:http|fetch") {
      const cfg = a?.clientConfig ?? {};
      let body: string | null = null;
      if (Array.isArray(cfg.data)) {
        try {
          body = new TextDecoder().decode(new Uint8Array(cfg.data));
        } catch {
          body = null;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({
        cmd,
        method: cfg.method,
        url: cfg.url,
        body,
      });
    } else if (cmd === "ws_send") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({ cmd, message: a?.message });
    }
    return orig(cmd, args);
  };
}

async function getCapturedCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((window as any).__capturedCalls ?? []) as CapturedCall[];
  });
}

/** Poll until a captured call matches, and return it. Avoids racing the async request. */
async function waitForCapturedCall(
  page: Page,
  predicate: (call: CapturedCall) => boolean,
  timeout = 5_000,
): Promise<CapturedCall> {
  let found: CapturedCall | undefined;
  await expect(async () => {
    const calls = await getCapturedCalls(page);
    found = calls.find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

// ---------------------------------------------------------------------------
// Feature 1: Group DM create + leave
// ---------------------------------------------------------------------------

const GROUP_DM_CHANNEL_ID = 900;

/** The group DM seeded in the ready payload, used for the render+leave slice. */
const SEEDED_GROUP_DM = {
  channel_id: GROUP_DM_CHANNEL_ID,
  recipient: { id: 3, username: "member1", avatar: "", status: "idle" },
  recipients: [
    { id: 3, username: "member1", avatar: "", status: "idle" },
    { id: 4, username: "member2", avatar: "", status: "dnd" },
  ],
  name: "Study Group",
  is_group: true,
  last_message_id: null,
  last_message: "Hey everyone",
  last_message_at: "2026-03-15T12:00:00Z",
  unread_count: 0,
  mention_count: 0,
};

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
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        // More specific pattern first is not required — buildTauriMockScript
        // sorts by pattern length, so "/api/v1/dms/group" always outranks the
        // shorter generic "/api/v1/dms/" leave/close pattern below.
        { pattern: "/api/v1/dms/group", status: 200, body: CREATED_GROUP_DM },
        { pattern: "/api/v1/dms/", status: 200, body: { success: true } },
        { pattern: "/admin/api/users/", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: MOCK_MEMBERS_MULTI_ROLE,
        dm_channels: [SEEDED_GROUP_DM],
      },
    }),
  );
  await page.addInitScript(captureScript);
}

test.describe("@parity Group DM create + leave", () => {
  test.beforeEach(async ({ page }) => {
    await mockSocialSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await waitForWsReady(page);
  });

  test("member picker creates a group DM from 2+ selected members", async ({ page }) => {
    // Entry point: the "+" button in the embedded DM section (channels mode).
    const newDmBtn = page.locator(".sidebar-dm-section .category-add-btn");
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
    // Open the seeded group DM from the channels-mode preview to switch into
    // full DM sidebar mode, where DmSidebar renders the group-specific chrome.
    const dmEntry = page.locator("[data-testid='dm-entry']").first();
    await expect(dmEntry).toBeVisible({ timeout: 5_000 });
    await dmEntry.click();

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
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        { pattern: "/admin/api/users/", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: MOCK_MEMBERS_MULTI_ROLE,
      },
    }),
  );
  await page.addInitScript(captureScript);
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
    const submenu = menu.locator(".context-menu__submenu");
    await expect(submenu).toBeVisible();

    // All three server roles are offered (MOCK_ROLES, minus "owner" — none seeded).
    for (const role of MOCK_ROLES.map((r) => r.name)) {
      await expect(submenu.locator(".context-menu__item", { hasText: role })).toBeVisible();
    }

    // moderator1 is currently "moderator" — pick "member" instead.
    const memberOption = submenu.locator(".context-menu__item", { hasText: "member" }).first();
    await memberOption.click();

    // Outgoing request: PATCH /admin/api/users/2 { role_id: 3 } (member's id in MOCK_ROLES).
    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "plugin:http|fetch" && (c.url ?? "").includes("/admin/api/users/2"),
    );
    expect(call.method).toBe("PATCH");
    const body = JSON.parse(call.body ?? "{}") as { role_id: number };
    expect(body.role_id).toBe(3);
  });
});
