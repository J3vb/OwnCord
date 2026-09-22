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
 * from `__TAURI_INTERNALS__.invoke` (a second init script, installed after the
 * mock's), and on localStorage only where persistence is the named behaviour.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  mockTauriFullSessionWithVoice,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
  navigateToMainPageReady,
  waitForWsReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// Call capture — records plugin:http|fetch invocations
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly cmd: string;
  readonly method?: string;
  readonly url?: string;
  readonly body?: string | null;
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
      (window as any).__capturedCalls.push({ cmd, method: cfg.method, url: cfg.url, body });
    }
    return orig(cmd, args);
  };
}

async function fetchCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    const calls =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).__capturedCalls ?? []) as CapturedCall[];
    return calls.filter((c) => c.cmd === "plugin:http|fetch");
  });
}

/** Poll until a captured fetch matches, and return it. Avoids racing the async request. */
async function waitForCall(
  page: Page,
  predicate: (call: CapturedCall) => boolean,
  timeout = 5_000,
): Promise<CapturedCall> {
  let found: CapturedCall | undefined;
  await expect(async () => {
    found = (await fetchCalls(page)).find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

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

const DM_CHANNELS = [
  {
    channel_id: DM_ONE_TO_ONE_ID,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
  {
    channel_id: GROUP_DM_ID,
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
  },
];

/** `GET /admin/api/users` — one live permanent ban for the banned section. */
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
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        // Group rename: PATCH /api/v1/dms/900. Longer, method-qualified
        // patterns outrank the bare DELETE route in the mock's longest-match sort.
        { pattern: `/api/v1/dms/${GROUP_DM_ID}`, method: "PATCH", status: 200, body: {} },
        // Close / leave: DELETE /api/v1/dms/{id}.
        { pattern: "/api/v1/dms/", method: "DELETE", status: 200, body: { success: true } },
        // The banned-list walk on mount and on every roster change.
        { pattern: "/admin/api/users", status: 200, body: [BANNED_USER] },
        { pattern: "/admin/api/users/", method: "PATCH", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: DM_MEMBERS,
        dm_channels: DM_CHANNELS,
      },
    }),
  );
  await page.addInitScript(captureScript);
}

/** Boot to the full DM sidebar (dms mode) from the channels-mode preview row. */
async function openDmSidebar(page: Page): Promise<void> {
  await submitLoginAndWait(page);
  const dmEntry = page.locator("[data-testid='dm-entry']").first();
  await expect(dmEntry).toBeVisible({ timeout: 5_000 });
  await dmEntry.click();
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
  const row = page.locator(`.dm-item[data-channel-id="${channelId}"]`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.evaluate((el) =>
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 640,
        clientY: 80,
        button: 2,
      }),
    ),
  );
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

    const call = await waitForCall(
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

    const call = await waitForCall(
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
    await handle.scrollIntoViewIfNeeded();

    const startHeight = await section.evaluate((el) => el.offsetHeight);
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

    const call = await waitForCall(
      page,
      (c) => (c.url ?? "").includes(`/admin/api/users/${BANNED_USER.id}`) && c.method === "PATCH",
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

test.describe("Per-user volume menu", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("the slider changes the label and the value persists when the menu is reopened", async ({
    page,
  }) => {
    const row = page.locator(".voice-user-item[data-voice-uid='2']");
    await expect(row).toBeVisible({ timeout: 5_000 });

    await row.click({ button: "right" });
    const menu = page.locator(".user-vol-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await expect(menu.locator(".context-menu-item", { hasText: "moderator1" })).toBeVisible();
    await expect(
      menu.locator(".context-menu-item", { hasText: "User Volume: 100%" }),
    ).toBeVisible();

    const slider = menu.locator("input.settings-slider");
    await expect(slider).toHaveValue("100");

    // Arrow keys are the honest way to drive a native range control.
    await slider.focus();
    for (let i = 0; i < 10; i++) {
      await slider.press("ArrowRight");
    }
    await expect(menu.locator(".slider-val")).toHaveText("110%");
    await expect(
      menu.locator(".context-menu-item", { hasText: "User Volume: 110%" }),
    ).toBeVisible();

    // Dismiss, then reopen: the saved volume is what the menu reads back.
    await page.mouse.click(5, 5);
    await expect(menu).not.toBeVisible();

    await row.click({ button: "right" });
    await expect(page.locator(".user-vol-menu")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".user-vol-menu input.settings-slider")).toHaveValue("110");
    // The label was seeded from the saved volume too, not defaulted.
    await expect(page.locator(".user-vol-menu .slider-val")).toHaveText("110%");
  });

  test("Reset Volume returns the slider and label to 100%", async ({ page }) => {
    const row = page.locator(".voice-user-item[data-voice-uid='3']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click({ button: "right" });

    const menu = page.locator(".user-vol-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    const slider = menu.locator("input.settings-slider");
    await slider.focus();
    for (let i = 0; i < 5; i++) {
      await slider.press("ArrowRight");
    }
    await expect(menu.locator(".slider-val")).toHaveText("105%");

    await menu.locator(".context-menu-item", { hasText: "Reset Volume" }).click();

    await expect(slider).toHaveValue("100");
    await expect(menu.locator(".slider-val")).toHaveText("100%");
    await expect(
      menu.locator(".context-menu-item", { hasText: "User Volume: 100%" }),
    ).toBeVisible();
  });
});
