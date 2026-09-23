/**
 * B9-21: shell polish and performance.
 *
 * The desktop shell must keep focus, scroll and row identity while names,
 * presence and unread counts change, and the sidebar navigation must be
 * operable from the keyboard (BPR-090, BPR-091). These tests run against the
 * real app and assert the observable behaviour, not an implementation:
 *
 * - one Tab stop per list, ArrowUp/Down roving, Enter/Space activation;
 * - row DOM identity survives an unrelated store update (the keyed list);
 * - the DM list's search input and focus survive a refresh (the in-place
 *   update replaces OC-0280's destroy+recreate);
 * - a scroll position in a long channel list is not reset by an update;
 * - the sidebar reflows at the 940x500 minimum window without losing
 *   navigation or clipping.
 *
 * Automated evidence supplements the owner's native AT recordings, which stay
 * pending owner-run (B9-26).
 */
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  mockTauriFullSession,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  navigateToMainPageReady,
} from "./helpers";

/** A long channel list in two categories, to exercise scroll and roving. */
const LONG_CHANNELS = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  name: `channel-${i}`,
  type: "text" as const,
  position: i % 20,
  category: i < 20 ? "Alpha" : "Beta",
}));

const DM_CHANNELS = [
  {
    channel_id: 100,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 1,
  },
  {
    channel_id: 101,
    recipient: { id: 3, username: "thirduser", avatar: "", status: "idle" },
    last_message_id: 501,
    last_message: "Yo",
    last_message_at: "2026-03-15T12:05:00Z",
    unread_count: 0,
  },
];

test.describe("B9-21 shell polish", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        ],
        simulateWsFlow: true,
        readyOverrides: { channels: LONG_CHANNELS, dm_channels: DM_CHANNELS },
      }),
    );
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("the channel list is one Tab stop with arrow-key navigation (BPR-091)", async ({ page }) => {
    const rows = page.locator(".channel-list .channel-item");
    await expect(rows.first()).toBeVisible();

    // Exactly one row is tabbable.
    await expect(page.locator(".channel-list .channel-item[tabindex='0']")).toHaveCount(1);

    // Tab into the list, then rove with ArrowDown and activate with Enter.
    await rows.first().focus();
    const firstName = await rows.first().locator(".ch-name").textContent();
    await page.keyboard.press("ArrowDown");
    const focusedName = await page.evaluate(
      () => document.activeElement?.querySelector(".ch-name")?.textContent ?? null,
    );
    expect(focusedName).not.toBe(firstName);

    // The focus ring is visible on the roved row (Q1: 2px). Read it before
    // activating, since Enter changes the active row.
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return { cls: el.className, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(ring.cls).toContain("channel-item");
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);

    await page.keyboard.press("Enter");
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText(focusedName ?? "");
  });

  test("a row keeps its identity across an unrelated unread update", async ({ page }) => {
    const row = page.locator('[data-channel-id="5"]');
    await expect(row).toBeVisible();

    // Mark the node, then push an unrelated store change through the real
    // message path (a mention bumps counts on another channel).
    await row.evaluate((el) => el.setAttribute("data-b9-probe", "1"));
    await page.evaluate(() => {
      // The same shape incrementUnread produces: a fresh channels Map.
      const w = window as unknown as { __tauriEmitEvent: (e: string, d: string) => void };
      w.__tauriEmitEvent(
        "ws-message",
        JSON.stringify({
          type: "chat_message",
          payload: {
            id: 9001,
            channel_id: 6,
            user: { id: 2, username: "otheruser", avatar: "" },
            content: "hi",
            timestamp: new Date().toISOString(),
            edited_at: null,
            attachments: [],
            reactions: [],
            reply_to: null,
            pinned: false,
            deleted: false,
          },
        }),
      );
    });

    // The unrelated row was reused (its probe survived).
    await expect(page.locator('[data-channel-id="5"][data-b9-probe="1"]')).toHaveCount(1);
  });

  test("DM mode keeps the search input and focus across a refresh", async ({ page }) => {
    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();

    const search = page.locator(".dm-search");
    await search.fill("other");
    await search.focus();

    // A presence flip reaches dmStore and refreshes the DM list.
    await page.evaluate(() => {
      const w = window as unknown as { __tauriEmitEvent: (e: string, d: string) => void };
      w.__tauriEmitEvent(
        "ws-message",
        JSON.stringify({ type: "presence", payload: { user_id: 2, status: "idle" } }),
      );
    });

    // The same input node, still holding the query and focus.
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("other");
  });

  test("a long channel list keeps its scroll position across an update", async ({ page }) => {
    const list = page.locator(".channel-list");
    await list.evaluate((el) => {
      el.scrollTop = 120;
    });
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    // Unrelated store change.
    await page.evaluate(() => {
      const w = window as unknown as { __tauriEmitEvent: (e: string, d: string) => void };
      w.__tauriEmitEvent(
        "ws-message",
        JSON.stringify({ type: "presence", payload: { user_id: 2, status: "dnd" } }),
      );
    });

    const after = await list.evaluate((el) => el.scrollTop);
    expect(after).toBe(before);
  });

  test("the sidebar reflows at the 940x500 minimum window without losing navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 940, height: 500 });

    const sidebar = page.locator("[data-testid='unified-sidebar']");
    await expect(sidebar).toBeVisible();

    // No horizontal overflow, and the channel rows are still reachable.
    const overflow = await sidebar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator(".channel-list .channel-item").first()).toBeInViewport();

    // A focused row stays within the viewport (Q1 reflow: focus never off
    // screen).
    const row = page.locator(".channel-list .channel-item").first();
    await row.focus();
    await expect(row).toBeInViewport();
  });
});

test.describe("B9-21 DM preview list", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        ],
        simulateWsFlow: true,
        readyOverrides: { dm_channels: DM_CHANNELS },
      }),
    );
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("the embedded DM preview is a single Tab stop and arrow-navigable", async ({ page }) => {
    const entries = page.locator(".sidebar-dm-section [data-testid='dm-entry']");
    await expect(entries.first()).toBeVisible();
    await expect(page.locator(".sidebar-dm-section [data-testid='dm-entry'][tabindex='0']")).toHaveCount(1);

    await entries.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(entries.nth(1)).toBeFocused();
  });
});
