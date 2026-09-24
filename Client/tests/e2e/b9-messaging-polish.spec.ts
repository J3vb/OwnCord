/**
 * B9-22: polish desktop message reading, composing and related overlays
 * (BPR-090, BPR-091).
 *
 * The journey: read a long virtualized history, receive a new message,
 * compose/reply/edit, and use search and pins — by keyboard, with stable
 * focus, no hover-only action, and a bounded reflow at the 940x500 minimum
 * window with 20px text. These tests drive the real app through the mocked
 * Tauri transport and assert observable behaviour plus the Q1 thresholds via
 * the shared b9-accessibility helpers.
 *
 * Automated evidence supplements the owner's native AT recordings, which stay
 * pending owner-run (B9-26).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_PINNED_MESSAGES,
  navigateToMainPageReady,
} from "./helpers";
import { Q1, findUnnamedControls, focusIndicator, textContrast } from "./support/b9-accessibility";

/** A long channel history so the virtualizer materializes a subrange. */
function longMessages(count: number): unknown {
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      id: 1000 + i,
      channel_id: 1,
      user: { id: (i % 2) + 1, username: i % 2 === 0 ? "testuser" : "otheruser", avatar: "" },
      content: `Message number ${i} of the fixture history`,
      timestamp: new Date(Date.UTC(2026, 2, 15, 10, 0, i)).toISOString(),
      edited_at: null,
      attachments: [],
      reactions: i % 3 === 0 ? [{ emoji: "\uD83D\uDC4D", count: 2, me: false }] : [],
      reply_to: null,
      pinned: i === count - 1,
      deleted: false,
    })),
    has_more: false,
  };
}

const LONG = longMessages(60);
/** The searchable fixture result set. */
const SEARCH_RESULTS = {
  results: [
    {
      message_id: 1005,
      channel_id: 1,
      channel_name: "general",
      user: { id: 1, username: "testuser", avatar: "" },
      content: "Message number 5 of the fixture history",
      timestamp: "2026-03-15T10:00:05Z",
    },
    {
      message_id: 1010,
      channel_id: 1,
      channel_name: "general",
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Message number 10 of the fixture history",
      timestamp: "2026-03-15T10:00:10Z",
    },
  ],
};

async function boot(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        { pattern: "/search", status: 200, body: SEARCH_RESULTS },
        { pattern: "/messages", status: 200, body: LONG },
      ],
      simulateWsFlow: true,
    }),
  );
}

async function start(page: Page): Promise<void> {
  await boot(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
}

/** A message id the virtualizer has actually rendered (near the live tail). */
const RENDERED = 1005;

test.describe("B9-22 message reading", () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test("a virtualized rebuild keeps focus on the row's action control", async ({ page }) => {
    const reply = page.locator(`[data-testid='msg-reply-${RENDERED}']`);
    await reply.scrollIntoViewIfNeeded();
    await reply.focus();
    await expect(reply).toBeFocused();
    const node = await reply.elementHandle();

    // A live message arrives, replacing rendered rows. Focus must land back on
    // the same row's action control rather than dropping to <body>.
    await page.evaluate(() => {
      const w = window as unknown as { __tauriEmitEvent: (e: string, d: string) => void };
      w.__tauriEmitEvent(
        "ws-message",
        JSON.stringify({
          type: "chat_message",
          payload: {
            id: 9999,
            channel_id: 1,
            user: { id: 2, username: "otheruser", avatar: "" },
            content: "just arrived",
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

    await expect(page.locator("[data-testid='message-9999']")).toBeVisible();
    const restored = page.locator(`[data-testid='msg-reply-${RENDERED}']`);
    await expect(restored).toBeFocused();
    expect(await restored.elementHandle()).not.toBe(node);
  });

  test("the scroll-to-bottom control has an accessible name", async ({ page }) => {
    const btn = page.locator(".scroll-to-bottom-btn");
    await expect(btn).toHaveAttribute("aria-label", "Scroll to bottom");
  });

  test("no messaging action is hover-only: the action bar reveals on focus", async ({ page }) => {
    const bar = page.locator(`[data-testid='message-${RENDERED}'] .msg-actions-bar`);
    await bar.scrollIntoViewIfNeeded();
    await expect(bar).toHaveCSS("opacity", "0");

    // Reach the action by keyboard so Chromium's :focus-visible modality
    // matches (a programmatic focus after a mouse click does not): focus the
    // button, step away and back with Tab.
    const reply = page.locator(`[data-testid='msg-reply-${RENDERED}']`);
    await reply.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(reply).toBeFocused();
    await expect(bar).toHaveCSS("opacity", "1");
    await expect(bar).toHaveCSS("pointer-events", "auto");

    const indicator = await focusIndicator(page);
    expect(indicator.problems).toEqual([]);
  });
});

test.describe("B9-22 composing and overlays", () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test("the composer keeps text selection and names its controls", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("bold me");
    await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 4));
    await textarea.focus();

    // Ctrl+B wraps the selection in a marker without clearing the draft.
    await page.keyboard.press("Control+b");
    await expect(textarea).toHaveValue("**bold** me");
    await expect(textarea).toHaveAccessibleName(/Message #general/);
    await expect(page.locator(".message-input-wrap .send-btn")).toHaveAccessibleName(
      "Send message",
    );
  });

  test("the reply overlay has a named close control and restores the bar", async ({ page }) => {
    const row = page.locator(`[data-testid='message-${RENDERED}']`);
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await page.locator(`[data-testid='msg-reply-${RENDERED}']`).click();

    const replyBar = page.locator(".reply-bar.visible").first();
    await expect(replyBar).toBeVisible();
    await expect(replyBar.locator(".reply-close")).toHaveAccessibleName("Cancel reply");

    await replyBar.locator(".reply-close").click();
    await expect(replyBar).toBeHidden();
  });

  test("the search overlay is a combobox over a listbox with a polite status", async ({ page }) => {
    await page.keyboard.press("Control+f");
    const input = page.locator("[data-testid='search-overlay-input']");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("role", "combobox");
    await expect(page.locator(".search-overlay-results")).toHaveAttribute("role", "listbox");

    await input.fill("Message number");
    const first = page.locator("[data-testid='search-result-0']");
    await expect(first).toBeVisible();
    // The active option is named through aria-activedescendant while the input
    // keeps DOM focus.
    await expect(input).toHaveAttribute("aria-activedescendant", "search-result-option-0");
    await expect(first).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(input).toHaveAttribute("aria-activedescendant", "search-result-option-1");

    await expect(page.locator(".search-overlay-status")).toHaveAttribute("role", "status");
  });

  test("the pinned panel reveals its row actions on focus, not hover only", async ({ page }) => {
    await page.locator("[data-testid='pin-btn']").click();
    const panel = page.locator(".pinned-panel");
    await expect(panel).toBeVisible();

    const actions = panel.locator(".pinned-msg__actions").first();
    await expect(actions).toHaveCSS("opacity", "0");

    const jump = panel.locator(".pinned-msg__actions button").first();
    await expect(jump).toHaveAccessibleName("Jump to message");
    await jump.focus();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("pointer-events", "auto");

    const unnamed = await findUnnamedControls(panel);
    expect(unnamed).toEqual([]);
  });
});

test.describe("B9-22 accessibility reflow at 940x500 with 20px text", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("message reading and composing keep every control whole and on screen", async ({
    page,
  }, testInfo) => {
    // Q1's largest text, applied by the real startup path — set before login so
    // the mocked session survives (setAppearance reloads).
    await page.addInitScript(() => {
      localStorage.setItem("owncord:settings:fontSize", "20");
      localStorage.setItem("owncord:settings:largeFont", "true");
    });
    await start(page);

    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(textarea).toBeVisible();

    // No horizontal page overflow at the minimum window with large text.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

    // The composer's controls stay reachable (focus never off screen) and no
    // control is horizontally clipped by its ancestor.
    await textarea.focus();
    await expect(textarea).toBeInViewport();
    expect(await textarea.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    const header = page.locator("[data-testid='chat-header']");
    expect(await header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

    // Message text contrast at Q1's 4.5:1 with the large-text theme.
    const author = page.locator(`[data-testid='message-${RENDERED}'] .msg-author`);
    await author.scrollIntoViewIfNeeded();
    const text = await textContrast(author);
    expect(text.ratio).toBeGreaterThanOrEqual(Q1.text);

    await testInfo.attach("messaging-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});

test.describe("B9-22 changed-area screenshots (evidence)", () => {
  test("captures the polished messaging surfaces", async ({ page }, testInfo) => {
    await start(page);

    await testInfo.attach("reading-dark.png", {
      body: await page.screenshot({ animations: "disabled", caret: "hide" }),
      contentType: "image/png",
    });

    // Action bar revealed by keyboard focus rather than hover alone.
    await page.locator(`[data-testid='msg-reply-${RENDERED}']`).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await testInfo.attach("actions-focus-dark.png", {
      body: await page.screenshot({ animations: "disabled", caret: "hide" }),
      contentType: "image/png",
    });

    // Search overlay combobox with the active option highlighted.
    await page.keyboard.press("Control+f");
    const input = page.locator("[data-testid='search-overlay-input']");
    await input.fill("Message number");
    await input.press("ArrowDown");
    await expect(page.locator("[data-testid='search-result-0']")).toBeVisible();
    await testInfo.attach("search-dark.png", {
      body: await page.screenshot({ animations: "disabled", caret: "hide" }),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");

    // Pinned panel with its row actions revealed by focus.
    await page.locator("[data-testid='pin-btn']").click();
    const panel = page.locator(".pinned-panel");
    await expect(panel).toBeVisible();
    await panel.locator(".pinned-msg__actions button").first().focus();
    await testInfo.attach("pins-focus-dark.png", {
      body: await page.screenshot({ animations: "disabled", caret: "hide" }),
      contentType: "image/png",
    });
  });
});
