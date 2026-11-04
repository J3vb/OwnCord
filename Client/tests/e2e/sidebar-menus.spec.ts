/**
 * Mocked E2E: sidebar menus (audit batch N12, gap #15).
 *
 * Covers the sidebar affordances that had no Playwright spec:
 *   - the DM row context menu (mute / unmute, rename on a group, close/leave);
 *   - the group-DM rename prompt and the PATCH it sends;
 *   - the member-list collapse toggle and drag-to-resize, with their
 *     localStorage persistence;
 *   - the banned-members section and its Unban action;
 *   - the per-user volume menu on a voice roster row (slider + reset).
 *
 * Assertions are on rendered UI, on the app's outgoing HTTP traffic captured
 * from `__TAURI_INTERNALS__.invoke` (a `wrappers` entry, run inside the
 * mock's init script), and on localStorage only where persistence is the named behaviour.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { findUnnamedControls } from "./support/accessibility";
import {
  buildTauriMockScript,
  mockTauriFullSessionWithVoice,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
  navigateToMainPageReady,
  waitForWsReady,
  openDmRow,
  BASE_SESSION_ROUTES,
  dmChannel,
  groupDmChannel,
  dispatchContextMenu,
  useLeftMemberList,
} from "./helpers";
import { captureCalls, fetchCalls, waitForFetchCall } from "./support/ipcCapture";

// ---------------------------------------------------------------------------
// DM session — one 1:1 (100) and one named group (900)
// ---------------------------------------------------------------------------

const DM_ONE_TO_ONE_ID = 100;
const GROUP_DM_ID = 900;

const DM_MEMBERS = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  { id: 2, username: "otheruser", avatar: "", status: "online", role: "member" },
  { id: 3, username: "member1", avatar: "", status: "idle", role: "member" },
  { id: 4, username: "member2", avatar: "", status: "dnd", role: "member" },
];

const DM_CHANNELS = [dmChannel(DM_ONE_TO_ONE_ID), groupDmChannel(GROUP_DM_ID)];

/** `GET /api/v1/moderation/members` — one live permanent ban for the banned section. */
const BANNED_USER = {
  id: 9,
  username: "banneduser",
  role_id: 3,
  role_name: "member",
  status: "offline",
  created_at: "2026-03-01T00:00:00Z",
  banned: true,
};

async function mockDmSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      wrappers: [captureCalls],
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        // Group rename: PATCH /api/v1/dms/900. Longer, method-qualified
        // patterns outrank the bare DELETE route in the mock's longest-match sort.
        { pattern: `/api/v1/dms/${GROUP_DM_ID}`, method: "PATCH", status: 200, body: {} },
        // Close / leave: DELETE /api/v1/dms/{id}.
        { pattern: "/api/v1/dms/", method: "DELETE", status: 200, body: { success: true } },
        // The banned-list walk on mount and on every roster change.
        { pattern: "/api/v1/moderation/members", status: 200, body: [BANNED_USER] },
        { pattern: "/api/v1/moderation/members/", method: "PATCH", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: DM_MEMBERS,
        dm_channels: DM_CHANNELS,
      },
    }),
  );
}

/** Boot to the full DM sidebar (dms mode) through the server rail's Home. */
async function openDmSidebar(page: Page): Promise<void> {
  await submitLoginAndWait(page);
  await openDmRow(page);
  await expect(page.locator(`.dm-item[data-channel-id="${DM_ONE_TO_ONE_ID}"]`)).toBeVisible({
    timeout: 5_000,
  });
}

async function submitLoginAndWait(page: Page): Promise<void> {
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

/** Open a DM row's context menu. The menu is `position:fixed` at the click
 *  point and its own items sit over the rows below it, so a real right-click on
 *  a second row can be intercepted by the first menu. Dispatch the same
 *  `contextmenu` event the browser would, from a safe coordinate — the row's
 *  real handler builds and positions the menu exactly as a click would (same
 *  approach as admin-moderation.spec.ts). */
async function openDmRowMenu(page: Page, channelId: number): Promise<void> {
  await dispatchContextMenu(page.locator(`.dm-item[data-channel-id="${channelId}"]`));
  await expect(page.locator(".dm-context-menu")).toBeVisible({ timeout: 3_000 });
}

// ---------------------------------------------------------------------------
// DM row context menu — mute / close
// ---------------------------------------------------------------------------

test.describe("DM sidebar — row context menu", () => {
  test.beforeEach(async ({ page }) => {
    await mockDmSession(page);
    await page.goto("/");
    await openDmSidebar(page);
  });

  test("muting a DM dims its row and flips the menu label to Unmute", async ({ page }) => {
    const row = page.locator(`.dm-item[data-channel-id="${DM_ONE_TO_ONE_ID}"]`);
    await expect(row).not.toHaveClass(/muted/);

    await openDmRowMenu(page, DM_ONE_TO_ONE_ID);
    const muteItem = page.locator(`[data-testid='dm-mute-${DM_ONE_TO_ONE_ID}']`);
    await expect(muteItem).toHaveText("Mute Conversation");

    await muteItem.click();

    // The rebuilt row carries the muted class — rendered UI, not storage.
    await expect(row).toHaveClass(/muted/);

    // Reopening the menu now offers the inverse action.
    await openDmRowMenu(page, DM_ONE_TO_ONE_ID);
    await expect(page.locator(`[data-testid='dm-mute-${DM_ONE_TO_ONE_ID}']`)).toHaveText(
      "Unmute Conversation",
    );

    // Unmuting restores the row.
    await page.locator(`[data-testid='dm-mute-${DM_ONE_TO_ONE_ID}']`).click();
    await expect(row).not.toHaveClass(/muted/);
  });

  test("closing a 1:1 DM sends DELETE and drops the row", async ({ page }) => {
    const row = page.locator(`.dm-item[data-channel-id="${DM_ONE_TO_ONE_ID}"]`);

    await openDmRowMenu(page, DM_ONE_TO_ONE_ID);
    const closeItem = page.locator(`[data-testid='dm-close-${DM_ONE_TO_ONE_ID}']`);
    await expect(closeItem).toHaveText("Close DM");
    await closeItem.click();

    const call = await waitForFetchCall(
      page,
      (c) => (c.url ?? "").includes(`/api/v1/dms/${DM_ONE_TO_ONE_ID}`) && c.method === "DELETE",
    );
    expect(call.method).toBe("DELETE");

    await expect(row).not.toBeVisible({ timeout: 5_000 });
  });

  test("only a group DM offers Rename Group", async ({ page }) => {
    await openDmRowMenu(page, DM_ONE_TO_ONE_ID);
    await expect(page.locator(`[data-testid='dm-rename-${DM_ONE_TO_ONE_ID}']`)).toHaveCount(0);
    await expect(page.locator(`[data-testid='dm-close-${DM_ONE_TO_ONE_ID}']`)).toBeVisible();

    // Reopening on the group replaces the menu (same class is swept first).
    await openDmRowMenu(page, GROUP_DM_ID);
    await expect(page.locator(`[data-testid='dm-rename-${GROUP_DM_ID}']`)).toHaveText(
      "Rename Group",
    );
    await expect(page.locator(`[data-testid='dm-close-${GROUP_DM_ID}']`)).toHaveText("Leave Group");
  });

  // DP-34: leaving a group is destructive and confirms first; a 1:1 hide does not.
  test("leaving a group asks for confirmation before sending DELETE", async ({ page }) => {
    const row = page.locator(`.dm-item[data-channel-id="${GROUP_DM_ID}"]`);

    await openDmRowMenu(page, GROUP_DM_ID);
    await page.locator(`[data-testid='dm-close-${GROUP_DM_ID}']`).click();

    // The confirm is up, and nothing has been sent yet.
    await expect(page.locator("[data-testid='dm-leave-modal']")).toBeVisible({ timeout: 3_000 });
    expect((await fetchCalls(page)).some((c) => c.method === "DELETE")).toBe(false);

    await page.locator("[data-testid='dm-leave-confirm']").click();

    const call = await waitForFetchCall(
      page,
      (c) => (c.url ?? "").includes(`/api/v1/dms/${GROUP_DM_ID}`) && c.method === "DELETE",
    );
    expect(call.method).toBe("DELETE");
    await expect(row).not.toBeVisible({ timeout: 5_000 });
  });

  test("the group-leave confirm is a named dialog and the ✕ title leads to it", async ({
    page,
  }) => {
    const row = page.locator(`.dm-item[data-channel-id="${GROUP_DM_ID}"]`);
    // The ✕ is hover-only; move the pointer onto the row to reveal it.
    await row.hover();
    await row.locator(".dm-close").click();

    const dialog = page.getByRole("dialog", { name: "Leave this group?" });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    // Cancel is the first control and takes focus, so Enter cannot destroy by
    // accident — the same shape DeleteChannelModal uses.
    await expect(dialog.locator("[data-testid='dm-leave-cancel']")).toBeFocused();
    expect(await findUnnamedControls(dialog)).toEqual([]);
  });

  test("cancelling the group-leave confirm leaves the group in place", async ({ page }) => {
    const row = page.locator(`.dm-item[data-channel-id="${GROUP_DM_ID}"]`);

    await openDmRowMenu(page, GROUP_DM_ID);
    await page.locator(`[data-testid='dm-close-${GROUP_DM_ID}']`).click();
    await page.locator("[data-testid='dm-leave-cancel']").click();

    await expect(page.locator("[data-testid='dm-leave-modal']")).toBeHidden();
    await expect(row).toBeVisible();
    expect((await fetchCalls(page)).some((c) => c.method === "DELETE")).toBe(false);
  });

  test("a 1:1 close stays one click (no confirm)", async ({ page }) => {
    const row = page.locator(`.dm-item[data-channel-id="${DM_ONE_TO_ONE_ID}"]`);

    await openDmRowMenu(page, DM_ONE_TO_ONE_ID);
    await page.locator(`[data-testid='dm-close-${DM_ONE_TO_ONE_ID}']`).click();

    await expect(page.locator("[data-testid='dm-leave-modal']")).toHaveCount(0);
    await waitForFetchCall(
      page,
      (c) => (c.url ?? "").includes(`/api/v1/dms/${DM_ONE_TO_ONE_ID}`) && c.method === "DELETE",
    );
    await expect(row).not.toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Group-DM rename prompt
// ---------------------------------------------------------------------------

test.describe("DM sidebar — group rename", () => {
  test.beforeEach(async ({ page }) => {
    await mockDmSession(page);
    await page.goto("/");
    await openDmSidebar(page);
  });

  test("Rename Group opens the prompt pre-filled and PATCHes the new name", async ({ page }) => {
    await openDmRowMenu(page, GROUP_DM_ID);
    await page.locator(`[data-testid='dm-rename-${GROUP_DM_ID}']`).click();

    const input = page.locator("[data-testid='dm-rename-input']");
    await expect(input).toBeVisible({ timeout: 3_000 });
    await expect(input).toHaveValue("Study Group");

    await input.fill("Book Club");
    await page.locator("[data-testid='prompt-confirm']").click();

    const call = await waitForFetchCall(
      page,
      (c) => (c.url ?? "").includes(`/api/v1/dms/${GROUP_DM_ID}`) && c.method === "PATCH",
    );
    expect(call.method).toBe("PATCH");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ name: "Book Club" });
  });
});

// ---------------------------------------------------------------------------
// Member list — collapse + drag-to-resize
// ---------------------------------------------------------------------------

test.describe("Member list section", () => {
  test.beforeEach(async ({ page }) => {
    // The default moved to the right column in 3C-6c; this is the left section.
    await useLeftMemberList(page);
    await mockDmSession(page);
    await page.goto("/");
    await submitLoginAndWait(page);
    await expect(page.locator(".sidebar-members-header")).toBeVisible({ timeout: 5_000 });
  });

  test("the header toggles collapse, hiding content and handle, and persists it", async ({
    page,
  }) => {
    const header = page.locator(".sidebar-members-header");
    const content = page.locator(".sidebar-members-content");
    const handle = page.locator(".sidebar-resize-handle");

    await expect(header).not.toHaveClass(/collapsed/);
    await expect(content).toBeVisible();
    await expect(handle).toBeVisible();

    await header.click();

    await expect(header).toHaveClass(/collapsed/);
    await expect(content).toBeHidden();
    await expect(handle).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("owncord:member-list-collapsed"))).toBe(
      "true",
    );

    await header.click();

    await expect(header).not.toHaveClass(/collapsed/);
    await expect(content).toBeVisible();
    await expect(handle).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("owncord:member-list-collapsed"))).toBe(
      "false",
    );
  });

  test("dragging the resize handle grows the section and saves the height", async ({ page }) => {
    const section = page.locator("[data-testid='sidebar-members']");
    const handle = page.locator(".sidebar-resize-handle");
    // Start from a saved height well under the 65 % cap, so the drag has room
    // to grow however much space the sidebar leaves the section at this size.
    await page.evaluate(() => localStorage.setItem("owncord:member-list-height", "200"));
    await page.reload();
    await submitLoginAndWait(page);
    await expect(section).toHaveCSS("height", "200px");
    await handle.scrollIntoViewIfNeeded();

    const startHeight = await section.evaluate((el: HTMLElement) => el.offsetHeight);
    const box = await handle.boundingBox();
    if (box === null) throw new Error("resize handle has no box");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, { steps: 5 });
    await page.mouse.up();

    // The rendered height grew by the drag distance (80px up).
    await expect
      .poll(async () => section.evaluate((el) => Number.parseFloat(el.style.height) || 0))
      .toBeGreaterThan(startHeight + 40);

    const saved = await page.evaluate(() => localStorage.getItem("owncord:member-list-height"));
    expect(saved).not.toBeNull();
    expect(Number(saved)).toBeGreaterThan(startHeight + 40);
  });
});

// ---------------------------------------------------------------------------
// Banned members section + unban
// ---------------------------------------------------------------------------

test.describe("Banned members section", () => {
  test.beforeEach(async ({ page }) => {
    await mockDmSession(page);
    await page.goto("/");
    await submitLoginAndWait(page);
  });

  test("lists a banned account and Unban PATCHes banned:false", async ({ page }) => {
    const bannedName = page.locator("[data-testid='sidebar-banned'] .banned-name");
    await expect(bannedName).toBeVisible({ timeout: 5_000 });
    await expect(bannedName).toHaveText("banneduser");

    await page.locator("[data-testid='unban-member']").click();

    const call = await waitForFetchCall(
      page,
      (c) =>
        (c.url ?? "").includes(`/api/v1/moderation/members/${BANNED_USER.id}`) &&
        c.method === "PATCH",
    );
    expect(call.method).toBe("PATCH");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ banned: false });

    await expect(
      page.locator("[data-testid='toast']", { hasText: "Unbanned banneduser" }),
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Per-user volume menu on a voice roster row
// ---------------------------------------------------------------------------

/** Right-clicks the voice roster row of `uid` and returns it with its open volume menu. */
async function openVolumeMenu(page: Page, uid: number) {
  const row = page.locator(`.voice-user-item[data-voice-uid='${uid}']`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click({ button: "right" });
  const menu = page.locator(".user-vol-menu");
  await expect(menu).toBeVisible({ timeout: 3_000 });
  return { row, menu, slider: menu.locator("input.settings-slider") };
}

test.describe("Per-user volume menu", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("the slider changes the label and the value persists when the menu is reopened", async ({
    page,
  }) => {
    const { row, menu } = await openVolumeMenu(page, 2);
    await expect(menu.locator(".context-menu-item", { hasText: "moderator1" })).toBeVisible();
    await expect(
      menu.locator(".context-menu-item", { hasText: "User Volume: 100%" }),
    ).toBeVisible();

    const slider = menu.locator("input.settings-slider");
    await expect(slider).toHaveValue("100");

    // Arrow keys are the honest way to drive a native range control.
    await slider.focus();
    for (let i = 0; i < 10; i++) {
      await slider.press("ArrowLeft");
    }
    await expect(menu.locator(".slider-val")).toHaveText("90%");
    await expect(menu.locator(".context-menu-item", { hasText: "User Volume: 90%" })).toBeVisible();

    // Dismiss, then reopen: the saved volume is what the menu reads back.
    await page.mouse.click(5, 5);
    await expect(menu).not.toBeVisible();

    await row.click({ button: "right" });
    await expect(page.locator(".user-vol-menu")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".user-vol-menu input.settings-slider")).toHaveValue("90");
    // The label was seeded from the saved volume too, not defaulted.
    await expect(page.locator(".user-vol-menu .slider-val")).toHaveText("90%");
  });

  test("Reset Volume returns the slider and label to 100%", async ({ page }) => {
    const { row, menu, slider } = await openVolumeMenu(page, 3);
    await slider.focus();
    for (let i = 0; i < 5; i++) {
      await slider.press("ArrowLeft");
    }
    await expect(menu.locator(".slider-val")).toHaveText("95%");

    await menu.locator(".context-menu-item", { hasText: "Reset Volume" }).click();

    await expect(slider).toHaveValue("100");
    await expect(menu.locator(".slider-val")).toHaveText("100%");
    await expect(
      menu.locator(".context-menu-item", { hasText: "User Volume: 100%" }),
    ).toBeVisible();

    // The reset was saved, not just painted: the reopened menu reads 100.
    await page.mouse.click(5, 5);
    await expect(menu).not.toBeVisible();
    await row.click({ button: "right" });
    await expect(page.locator(".user-vol-menu")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".user-vol-menu input.settings-slider")).toHaveValue("100");
    await expect(page.locator(".user-vol-menu .slider-val")).toHaveText("100%");
  });

  test("the slider goes to 200% and Mute marks the row while keeping the level", async ({
    page,
  }) => {
    const { row, menu, slider } = await openVolumeMenu(page, 2);
    await slider.focus();
    await slider.press("End");
    await expect(menu.locator(".slider-val")).toHaveText("200%");

    const mute = menu.locator("[role='menuitemcheckbox']", { hasText: "Mute" });
    await expect(mute).toHaveAttribute("aria-checked", "false");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-checked", "true");
    await expect(row.locator(".vu-local-muted")).toBeVisible();

    // Reopened: still muted, and the level under the Mute is unchanged.
    await page.mouse.click(5, 5);
    await expect(menu).not.toBeVisible();
    await row.click({ button: "right" });
    await expect(page.locator(".user-vol-menu input.settings-slider")).toHaveValue("200");
    const reopened = page.locator(".user-vol-menu [role='menuitemcheckbox']");
    await expect(reopened).toHaveAttribute("aria-checked", "true");

    await reopened.click();
    await expect(row.locator(".vu-local-muted")).toHaveCount(0);
  });
});
