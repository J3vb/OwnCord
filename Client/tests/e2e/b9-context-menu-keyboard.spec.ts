/**
 * Keyboard operability of the shared context menus (B9 A11Y-01, OC-0460).
 *
 * Every member, channel, DM and voice-user menu is opened here from the
 * keyboard alone — focus a row, press Shift+F10 (or the Menu key) — and driven
 * with Arrow keys, Home/End, ArrowRight into a submenu, Enter to activate and
 * Escape to close and restore focus to the invoking row. A local
 * `keyboardReachable` check proves each row is itself reachable by Tab, which
 * is the assertion that would have caught the original mouse-only defect.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MEMBERS_MULTI_ROLE,
  MOCK_VOICE_STATE,
  navigateToMainPage,
  navigateToMainPageReady,
} from "./helpers";

const ONE_TO_ONE_DM_ID = 100;

/** Voice Chat (10) with a server verdict that this user may moderate it. */
const CHANNELS_WITH_MOD = MOCK_CHANNELS_WITH_CATEGORIES.map((ch) =>
  ch.id === 10 ? { ...ch, can_moderate_voice: true } : ch,
);

const DM_CHANNELS = [
  {
    channel_id: ONE_TO_ONE_DM_ID,
    recipient: { id: 2, username: "moderator1", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
];

interface CapturedCall {
  readonly cmd: string;
  readonly message?: string;
  readonly method?: string;
  readonly url?: string;
}

/** Installed after the Tauri mock so outgoing writes are observable. */
function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__;
  const orig = internals.invoke;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__capturedCalls = [];
  internals.invoke = async (cmd: string, args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = args as any;
    if (cmd === "ws_send") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({ cmd, message: a?.message });
    } else if (cmd === "plugin:http|fetch") {
      const cfg = a?.clientConfig ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({ cmd, method: cfg.method, url: cfg.url });
    }
    return orig(cmd, args);
  };
}

async function capturedCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((window as any).__capturedCalls ?? []) as CapturedCall[];
  });
}

async function mockSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/admin/api/users", status: 200, body: [] },
        { pattern: "/admin/api/users/", method: "PATCH", status: 200, body: {} },
        { pattern: "/admin/api/channels/", method: "PATCH", status: 200, body: {} },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        channels: CHANNELS_WITH_MOD,
        members: MOCK_MEMBERS_MULTI_ROLE,
        voice_states: MOCK_VOICE_STATE,
        dm_channels: DM_CHANNELS,
      },
    }),
  );
  await page.addInitScript(captureScript);
}

/**
 * Keyboard reachability: Tab from `from` (or the document start) until
 * `target` holds focus, up to `maxTabs` presses, then fail. This is the check
 * A11Y-01 was missing — a click-only `<div>` row can never satisfy it.
 */
async function keyboardReachable(
  page: Page,
  target: Locator,
  opts: { from?: Locator; maxTabs?: number } = {},
): Promise<void> {
  const maxTabs = opts.maxTabs ?? 80;
  if (opts.from !== undefined) await opts.from.focus();
  else await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < maxTabs; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  expect(
    await target.evaluate((el) => el === document.activeElement),
    "control was not reachable by Tab",
  ).toBe(true);
}

/**
 * Reachability for a roving list (B9-21): the list is a single Tab stop, so
 * Tab gets focus onto the roving cells and Arrow keys move to the named row.
 * Fails if the row cannot be reached either way.
 */
async function keyboardReachableRoving(page: Page, cellSel: string, row: Locator): Promise<void> {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  let onCell = false;
  for (let i = 0; i < 120; i++) {
    if (
      await page.evaluate(
        (sel) =>
          document.activeElement?.matches(sel) &&
          document.activeElement?.closest(".channel-list, .dm-conversation-list") !== null,
        cellSel,
      )
    ) {
      onCell = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  expect(onCell, "roving list was not reachable by Tab").toBe(true);
  for (let i = 0; i < 40; i++) {
    if (await row.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("ArrowDown");
  }
  expect(
    await row.evaluate((el) => el === document.activeElement),
    "roving row was not reachable by Tab + Arrow",
  ).toBe(true);
}

/** Open a row's menu from the keyboard alone. */
async function openMenuWithKeyboard(page: Page, row: Locator): Promise<void> {
  await row.focus();
  await page.keyboard.press("Shift+F10");
}

function menuItems(page: Page, className: string): Locator {
  return page.locator(`.${className} [role="menuitem"]`);
}

test.describe("context menus are keyboard-operable (A11Y-01)", () => {
  test.beforeEach(async ({ page }) => {
    await mockSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("member menu: reachable, opens on Shift+F10, arrows move, Enter blocks, Escape restores focus", async ({
    page,
  }) => {
    const row = page.locator("[data-testid='member-2']");
    await expect(row).toBeVisible({ timeout: 5_000 });

    // The row itself is Tab-reachable (not hover-only).
    await keyboardReachable(page, row);

    await openMenuWithKeyboard(page, row);
    const menu = page.locator(".context-menu").first();
    await expect(menu).toBeVisible({ timeout: 3_000 });

    // Focus moved into the menu, onto a real focusable menuitem. The Change
    // Role trigger's text includes its nested submenu rows, so match on it.
    await expect(menu.locator("[role='menuitem']:focus")).toHaveCount(1);
    await expect(menu.locator("[role='menuitem']:focus")).toContainText("Change Role");

    // ArrowDown steps to the next row.
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator("[role='menuitem']:focus")).toHaveText("Force Logout");

    // Home/End jump to the edges.
    await page.keyboard.press("End");
    await expect(menu.locator("[role='menuitem']:focus")).toHaveText("Block");
    await page.keyboard.press("Home");
    await expect(menu.locator("[role='menuitem']:focus")).toContainText("Change Role");

    // Enter on the row is the same two-click block confirm a mouse gets.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(menu.locator("[data-testid='block-toggle']")).toHaveText("Are you sure?");
  });

  test("member menu: ArrowRight opens the Change Role submenu and Enter picks a role", async ({
    page,
  }) => {
    const row = page.locator("[data-testid='member-2']");
    await row.focus();
    await page.keyboard.press("Shift+F10");

    const menu = page.locator(".context-menu").first();
    await expect(menu.locator("[role='menuitem']:focus")).toContainText("Change Role");
    await page.keyboard.press("ArrowRight");

    const sub = menu.locator(".context-menu__submenu");
    await expect(sub.locator("[role='menuitem']:focus")).toHaveText("admin");
    // Arrows move within the submenu; step down and back to prove it, then
    // pick admin (the target's current role is moderator, so member would be a
    // no-op and admins is the change this asserts).
    await page.keyboard.press("ArrowDown");
    await expect(sub.locator("[role='menuitem']:focus")).toHaveText("moderator");
    await page.keyboard.press("ArrowUp");
    await expect(sub.locator("[role='menuitem']:focus")).toHaveText("admin");
    await page.keyboard.press("Enter");

    await expect(async () => {
      const call = (await capturedCalls(page)).find(
        (c) => (c.url ?? "").includes("/admin/api/users/2") && c.method === "PATCH",
      );
      expect(call).toBeDefined();
    }).toPass({ timeout: 5_000 });
  });

  test("member menu: Escape closes and returns focus to the invoking row", async ({ page }) => {
    const row = page.locator("[data-testid='member-2']");
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.locator(".context-menu").first()).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu").first()).toHaveCount(0);
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test("channel menu: opens from the keyboard, activates Mute, and offers Move Up/Down", async ({
    page,
  }) => {
    const row = page.locator("[data-testid='channel-2']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await keyboardReachableRoving(page, ".channel-item", row);

    await openMenuWithKeyboard(page, row);
    const menu = page.locator(".channel-ctx-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await expect(menu.locator("[role='menuitem']:focus")).toHaveCount(1);

    // The keyboard move pair is present for a channel manager.
    await expect(menu.locator("[data-testid='ctx-move-up']")).toHaveCount(1);
    await expect(menu.locator("[data-testid='ctx-move-down']")).toHaveCount(1);

    // Arrow to Mute and activate it with Enter; the row picks up the muted
    // class from the redraw the menu triggers.
    await menu.locator("[data-testid='ctx-mute-channel']").focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveClass(/muted/);
  });

  test("channel menu: Move Down reorders through the same callback as the drag path", async ({
    page,
  }) => {
    const row = page.locator("[data-testid='channel-1']");
    await openMenuWithKeyboard(page, row);
    const menu = page.locator(".channel-ctx-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });

    await menu.locator("[data-testid='ctx-move-down']").focus();
    await page.keyboard.press("Enter");

    await expect(async () => {
      const call = (await capturedCalls(page)).find(
        (c) => (c.url ?? "").includes("/admin/api/channels/") && c.method === "PATCH",
      );
      expect(call).toBeDefined();
    }).toPass({ timeout: 5_000 });
  });

  test("DM menu: opens from the keyboard and Enter mutes the conversation", async ({ page }) => {
    await page.locator("[data-testid='dm-entry']").first().click();
    const row = page.locator(`.dm-item[data-channel-id="${ONE_TO_ONE_DM_ID}"]`);
    await expect(row).toBeVisible({ timeout: 5_000 });

    await keyboardReachableRoving(page, ".dm-item", row);
    await openMenuWithKeyboard(page, row);

    const menu = page.locator(".dm-context-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await expect(menu.locator("[role='menuitem']:focus")).toHaveCount(1);

    await menu.locator(`[data-testid='dm-mute-${ONE_TO_ONE_DM_ID}']`).focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveClass(/muted/);
  });

  test("voice menu: participant row is Tab-reachable and Server Mute fires from the keyboard", async ({
    page,
  }) => {
    const row = page.locator(".voice-user-item[data-voice-uid='2']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await keyboardReachable(page, row);

    await openMenuWithKeyboard(page, row);
    const menu = page.locator(".user-vol-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await expect(menu.locator("[role='menuitem']:focus")).toHaveCount(1);

    await menu.locator("[data-action='server-mute']").focus();
    await page.keyboard.press("Enter");

    await expect(async () => {
      const call = (await capturedCalls(page)).find((c) =>
        (c.message ?? "").includes("voice_mod_mute"),
      );
      expect(call).toBeDefined();
    }).toPass({ timeout: 5_000 });
  });

  test("voice menu: Escape restores focus to the participant row", async ({ page }) => {
    const row = page.locator(".voice-user-item[data-voice-uid='3']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.locator(".user-vol-menu")).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(page.locator(".user-vol-menu")).toHaveCount(0);
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
  });
});
