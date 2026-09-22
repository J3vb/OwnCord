/**
 * Mocked E2E: Admin member moderation (gap #5 of the Playwright audit).
 *
 * Exercises the member context menu built by `AdminActions.createMemberContextMenu`
 * over the real `MemberList` → `SidebarMemberSection.onBan/onKick/onToggleBlock`
 * wiring:
 *   - Ban: reason + duration collected, PATCH /admin/api/users/{id} sent with
 *     `banned:true`, `ban_reason` and `ban_duration_hours` (omitted when permanent).
 *   - Force Logout: two-click confirm, DELETE /admin/api/users/{id}/sessions.
 *   - Block: two-click confirm, PUT /api/v1/blocks/{id}; Unblock: one click,
 *     DELETE /api/v1/blocks/{id}.
 *
 * A second init script wraps `__TAURI_INTERNALS__.invoke` (installed after the
 * mock's) so tests assert the exact outgoing HTTP request/method/body rather
 * than only the resulting DOM.
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { buildTauriMockScript, MOCK_LOGIN_RESPONSE, navigateToMainPage } from "./helpers";

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
      (window as any).__capturedCalls.push({
        cmd,
        method: cfg.method,
        url: cfg.url,
        body,
      });
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

async function fetchCalls(page: Page): Promise<CapturedCall[]> {
  return (await getCapturedCalls(page)).filter((c) => c.cmd === "plugin:http|fetch");
}

/** Poll until a captured call matches, and return it. Avoids racing the async request. */
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
// Session
// ---------------------------------------------------------------------------

/** The mock's route table plus the admin routes the moderation flows touch. */
const ADMIN_ROUTES = [
  { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
  { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
  { pattern: "/api/v1/blocks", status: 200, body: { blocked_user_ids: [] } },
  // GET /admin/api/users?limit=… — the banned-list walk on every roster change.
  { pattern: "/admin/api/users", status: 200, body: [] },
  // PATCH /admin/api/users/{id} — ban, unban and role change. The trailing
  // slash outranks the list pattern above in the mock's longest-match sort.
  { pattern: "/admin/api/users/", method: "PATCH", status: 200, body: {} },
  { pattern: "/admin/api/users/2/sessions", method: "DELETE", status: 204, body: null },
  { pattern: "/api/v1/blocks/2", method: "PUT", status: 200, body: {} },
  { pattern: "/api/v1/blocks/2", method: "DELETE", status: 200, body: {} },
];

async function mockModerationSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: ADMIN_ROUTES,
      simulateWsFlow: true,
    }),
  );
  await page.addInitScript(captureScript);
}

/** Open the context menu on a member row and return the menu locator.
 *  The menu is `position:fixed` at the click point, and the member rows sit
 *  low enough in the sidebar that a real right-click puts the lower items
 *  (Ban, Block) below the viewport — the test would then be measuring layout,
 *  not behaviour. Dispatch the same `contextmenu` event the browser would,
 *  from a safe coordinate: MemberList's real handler builds and positions the
 *  menu exactly as a click at that point would. */
async function openMemberMenu(page: Page, testId: string) {
  const row = page.locator(`[data-testid='${testId}']`);
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
  const menu = page.locator(".context-menu").first();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
}

test.describe("Admin moderation — member context menu", () => {
  test.beforeEach(async ({ page }) => {
    await mockModerationSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("ban collects a reason and duration, and PATCHes the exact ban body", async ({ page }) => {
    const menu = await openMemberMenu(page, "member-2");

    await menu.locator(".context-menu__item", { hasText: /^Ban$/ }).click();
    const reason = menu.locator("[data-testid='ban-reason-input']");
    await expect(reason).toBeVisible();
    await reason.fill("spamming #general");
    await menu.locator("[data-testid='ban-duration-select']").selectOption({ label: "1 day" });
    await menu.locator("[data-testid='ban-confirm']").click();

    const call = await waitForCall(
      page,
      (c) => (c.url ?? "").includes("/admin/api/users/2") && c.method === "PATCH",
    );
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body.banned).toBe(true);
    expect(body.ban_reason).toBe("spamming #general");
    expect(body.ban_duration_hours).toBe(24);

    await expect(
      page.locator("[data-testid='toast']", { hasText: "Banned otheruser for 24h" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("a permanent ban omits the duration and confirms without one", async ({ page }) => {
    const menu = await openMemberMenu(page, "member-2");

    await menu.locator(".context-menu__item", { hasText: /^Ban$/ }).click();
    await menu.locator("[data-testid='ban-confirm']").click();

    const call = await waitForCall(
      page,
      (c) => (c.url ?? "").includes("/admin/api/users/2") && c.method === "PATCH",
    );
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body.banned).toBe(true);
    expect(body.ban_reason).toBe("");
    expect(body).not.toHaveProperty("ban_duration_hours");

    await expect(
      page.locator("[data-testid='toast']", { hasText: "Banned otheruser" }),
    ).toBeVisible({
      timeout: 5_000,
    });
  });

  test("force logout needs two clicks: the first only arms, the second revokes sessions", async ({
    page,
  }) => {
    const menu = await openMemberMenu(page, "member-2");
    const logout = menu.locator("[data-testid='force-logout']");
    await expect(logout).toHaveText("Force Logout");

    await logout.click();
    await expect(logout).toHaveText("Log them out?");
    // Armed but not fired: no DELETE has gone out.
    expect((await fetchCalls(page)).filter((c) => c.method === "DELETE")).toHaveLength(0);

    await logout.click();
    const call = await waitForCall(
      page,
      (c) => (c.url ?? "").includes("/admin/api/users/2/sessions") && c.method === "DELETE",
    );
    expect(call.method).toBe("DELETE");
    expect((await fetchCalls(page)).filter((c) => c.method === "DELETE")).toHaveLength(1);

    await expect(
      page.locator("[data-testid='toast']", { hasText: "Forced otheruser to log out" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("block confirms with two clicks, then unblock is a single click", async ({ page }) => {
    const menu = await openMemberMenu(page, "member-2");
    const blockItem = menu.locator("[data-testid='block-toggle']");
    await expect(blockItem).toHaveText("Block");

    await blockItem.click();
    await expect(blockItem).toHaveText("Are you sure?");
    expect(
      (await fetchCalls(page)).filter((c) => (c.url ?? "").includes("/api/v1/blocks/")),
    ).toHaveLength(0);

    await blockItem.click();
    const blockCall = await waitForCall(
      page,
      (c) => (c.url ?? "").includes("/api/v1/blocks/2") && c.method === "PUT",
    );
    expect(blockCall.method).toBe("PUT");
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Blocked otheruser" }),
    ).toBeVisible({
      timeout: 5_000,
    });

    // Close the menu, then reopen: the row now offers Unblock (one click).
    await page.mouse.click(5, 5);
    await expect(menu).not.toBeVisible();
    const reopened = await openMemberMenu(page, "member-2");
    const unblockItem = reopened.locator("[data-testid='block-toggle']");
    await expect(unblockItem).toHaveText("Unblock");

    await unblockItem.click();
    const unblockCall = await waitForCall(
      page,
      (c) => (c.url ?? "").includes("/api/v1/blocks/2") && c.method === "DELETE",
    );
    expect(unblockCall.method).toBe("DELETE");
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Unblocked otheruser" }),
    ).toBeVisible({
      timeout: 5_000,
    });
  });

  test("a demoted moderator loses Ban and Force Logout but keeps Block", async ({ page }) => {
    // Demote the signed-in user to "member" through the same live member_update
    // path a real promotion/demotion uses; MemberList reads authStore live.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__tauriEmitEvent(
        "ws-message",
        JSON.stringify({ type: "member_update", payload: { user_id: 1, role: "member" } }),
      );
    });

    const menu = await openMemberMenu(page, "member-2");
    await expect(menu.locator("[data-testid='block-toggle']")).toBeVisible();
    await expect(menu.locator(".context-menu__item", { hasText: /^Ban$/ })).toHaveCount(0);
    await expect(menu.locator("[data-testid='force-logout']")).toHaveCount(0);
    await expect(menu.locator(".context-menu__item", { hasText: "Change Role" })).toHaveCount(0);
    expect(await menu.locator(".context-menu__item").allTextContents()).toEqual(["Block"]);
  });
});
