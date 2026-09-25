/**
 * B9 narrow-width navigation (WCAG 1.4.10 Reflow).
 *
 * At a CSS viewport of 800px or less — what a 1280px desktop window becomes at
 * 200 % page zoom — `responsive.css` collapses `.unified-sidebar` to zero
 * width. Every entry point that lives only in that sidebar (channels and DMs,
 * the requests inbox, the Moderation Center, Settings and My reports) then
 * becomes unreachable. This spec runs at the effective 200 % zoom viewport
 * (640x400, the same model as `support/b9-zoom.ts`) and proves the header menu
 * button opens the sidebar as a drawer and that each destination is reachable
 * from it: keyboard-only for Settings, the Moderation Center, a DM and the
 * requests inbox, plus one pointer path for opening and outside-click closing.
 *
 * The zoom lane's own spec (b9-zoom.spec.ts) carries the deferred sidebar
 * screen; this is the behavioural counterpart, not a copy of it.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  submitLogin,
  waitForWsReady,
} from "./helpers";

const DM_CHANNELS = [
  {
    channel_id: 100,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
];

const REQUESTS = [
  {
    id: 2,
    channel_id: 202,
    sender: { id: 12, username: "stranger", display_name: "A Stranger", avatar: "" },
    preview: { message_id: 902, content: "hello?", timestamp: "2026-09-05T12:00:00Z" },
    created_at: "2026-09-05T12:00:00Z",
  },
];

// The effective 200 % zoom viewport: a 1280x800 window at 200 % page zoom.
test.use({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });

async function signIn(page: Page): Promise<void> {
  await submitLogin(page);
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
  await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
}

const toggle = (page: Page) => page.locator("[data-testid='sidebar-toggle']");
const sidebar = (page: Page) => page.locator("[data-testid='unified-sidebar']");

async function openWithKeyboard(page: Page): Promise<void> {
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar(page)).toBeVisible();
}

/** Focus `keyboardTarget` then activate it, the way the keyboard model does. */
async function activate(page: Page, keyboardTarget: ReturnType<Page["locator"]>): Promise<void> {
  await keyboardTarget.focus();
  await page.keyboard.press("Enter");
}

test.describe("B9 narrow-width sidebar drawer", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
          { pattern: "/api/v1/dm-requests", status: 200, body: { requests: REQUESTS } },
          {
            pattern: "/api/v1/moderation/queue",
            method: "GET",
            status: 200,
            body: [],
          },
        ],
        simulateWsFlow: true,
        readyOverrides: { dm_channels: DM_CHANNELS },
      }),
    );
    await page.goto("/");
    await signIn(page);
  });

  test("the menu button opens the drawer, moves focus in, and restores it on Escape", async ({
    page,
  }) => {
    // Above the breakpoint the toggle is hidden and the sidebar is in flow.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(toggle(page)).toBeHidden();
    await expect(sidebar(page)).toBeVisible();
    await page.setViewportSize({ width: 640, height: 400 });

    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    await openWithKeyboard(page);
    // Focus moved into the drawer.
    expect(
      await page.evaluate(
        () => document.activeElement?.closest("[data-testid='unified-sidebar']") !== null,
      ),
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar(page)).not.toHaveClass(/drawer-open/);
    await expect(toggle(page)).toBeFocused();
  });

  test("keyboard reaches Settings, the Moderation Center, a DM and the requests inbox", async ({
    page,
  }) => {
    // Settings (My reports lives in its Safety tab).
    await openWithKeyboard(page);
    await activate(page, page.locator("button[aria-label='Settings']"));
    await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
    await expect(sidebar(page)).not.toHaveClass(/drawer-open/);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='settings-overlay']")).not.toHaveClass(/open/);

    // The Moderation Center. A content view replaces the chat column (and with
    // it the header's menu button), so the B9-4 back path — Close/Escape —
    // returns to the channel before the drawer is opened again.
    await openWithKeyboard(page);
    await activate(page, page.locator("[data-testid='moderation-btn']"));
    await expect(page.locator("[data-testid='mod-center']")).toBeVisible();
    await expect(sidebar(page)).not.toHaveClass(/drawer-open/);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='chat-area']")).toBeVisible();

    // A DM.
    await openWithKeyboard(page);
    await activate(page, page.locator("[data-testid='dm-entry']").first());
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("otheruser");
    await expect(sidebar(page)).not.toHaveClass(/drawer-open/);

    // The requests inbox (its entry lives in DM mode).
    await openWithKeyboard(page);
    await activate(page, page.locator("[data-testid='dm-requests-entry']"));
    await expect(page.locator("[data-testid='requests-inbox']")).toBeVisible();
    await expect(sidebar(page)).not.toHaveClass(/drawer-open/);
  });

  test("a pointer opens the drawer and an outside click closes it", async ({ page }) => {
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar(page)).toHaveClass(/drawer-open/);

    await page
      .locator("[data-testid='sidebar-drawer-backdrop']")
      .click({ position: { x: 500, y: 200 } });
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar(page)).not.toHaveClass(/drawer-open/);
  });
});
