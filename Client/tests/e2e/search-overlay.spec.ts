/**
 * Mocked E2E: message search overlay (Ctrl+F), gap #7.
 *
 * Covers the whole user-visible path the audit found untested:
 *   - Ctrl+F (and the chat-header search trigger) opens the overlay
 *   - input is debounced: a burst of typing issues one scoped request
 *   - a < MIN_QUERY_LEN query shows the hint instead of searching
 *   - results render channel/author/content; empty results say so
 *   - ArrowDown/ArrowUp move the active row with wrap-around
 *   - Enter / click jump to the message (highlight) and close the overlay,
 *     switching channels when the hit lives elsewhere
 *   - Escape / backdrop click close
 *
 * Assertions read rendered UI plus the outgoing HTTP traffic recorded in
 * `window.__invokeLog` (the Tauri mock logs every IPC invoke), never the
 * mocks' own internals.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
} from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEARCH_RESULTS = {
  results: [
    {
      message_id: 101,
      channel_id: 1,
      channel_name: "general",
      user: { id: 1, username: "testuser", avatar: "" },
      content: "Hello world!",
      timestamp: "2026-03-15T10:00:00Z",
    },
    {
      message_id: 201,
      channel_id: 2,
      channel_name: "random",
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Second result",
      timestamp: "2026-03-15T10:01:00Z",
    },
  ],
};

/** #random (channel 2) history, containing the second search hit. */
const CHANNEL_2_MESSAGES = {
  messages: [
    {
      id: 201,
      channel_id: 2,
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Second result",
      timestamp: "2026-03-15T10:01:00Z",
      edited_at: null,
      attachments: [],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
  ],
  has_more: false,
};

const AROUND_CHANNEL_2 = {
  messages: CHANNEL_2_MESSAGES.messages,
  has_more_before: false,
  has_more_after: false,
};

async function mockSessionWithSearch(page: Page, searchResults: unknown): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        // Longest patterns first in this list, but buildTauriMockScript sorts by
        // length anyway — the around route must win over the tail route.
        { pattern: "/channels/2/messages/around", status: 200, body: AROUND_CHANNEL_2 },
        { pattern: "/channels/2/messages", status: 200, body: CHANNEL_2_MESSAGES },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        { pattern: "/search", status: 200, body: searchResults },
      ],
      simulateWsFlow: true,
    }),
  );
}

/** Query strings of every `/search` request the client has issued, in order. */
async function searchQueries(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __invokeLog: Array<{ cmd: string; args?: { clientConfig?: { url?: string } } }>;
      }
    ).__invokeLog
      .filter((e) => e.cmd === "plugin:http|fetch")
      .map((e) => e.args?.clientConfig?.url ?? "")
      .filter((url) => url.includes("/search"))
      .map((url) => new URL(url).searchParams.get("q") ?? ""),
  );
}

async function searchChannelIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __invokeLog: Array<{ cmd: string; args?: { clientConfig?: { url?: string } } }>;
      }
    ).__invokeLog
      .filter((e) => e.cmd === "plugin:http|fetch")
      .map((e) => e.args?.clientConfig?.url ?? "")
      .filter((url) => url.includes("/search"))
      .map((url) => new URL(url).searchParams.get("channel_id") ?? ""),
  );
}

const OVERLAY = "[data-testid='search-overlay']";
const INPUT = "[data-testid='search-overlay-input']";
const STATUS = ".search-overlay-status";

async function openOverlay(page: Page): Promise<void> {
  await page.keyboard.press("Control+f");
  await expect(page.locator(OVERLAY)).toBeVisible();
  await expect(page.locator(INPUT)).toBeFocused();
}

async function loginAndWait(page: Page, searchResults: unknown = SEARCH_RESULTS): Promise<void> {
  await mockSessionWithSearch(page, searchResults);
  await page.goto("/");
  await navigateToMainPage(page);
  await expect(page.locator("[data-testid='message-101']")).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Search overlay", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndWait(page);
  });

  test("Ctrl+F opens the overlay and focuses its input", async ({ page }) => {
    await openOverlay(page);
    await expect(page.locator(`${OVERLAY} .search-overlay-results`)).toBeAttached();
    await expect(page.locator(INPUT)).toHaveAttribute("placeholder", "Search messages...");
  });

  test("focusing the chat-header search input opens the overlay", async ({ page }) => {
    await page.locator("[data-testid='search-input']").click();
    await expect(page.locator(OVERLAY)).toBeVisible();
    await expect(page.locator(INPUT)).toBeFocused();
  });

  test("input is debounced, then sends the final query once, scoped to the channel", async ({
    page,
  }) => {
    await openOverlay(page);

    // A burst faster than the 300ms debounce window. Debounce and the 500ms
    // rate limiter each collapse it; drop both and this fires per keystroke
    // past the 2-char minimum ("he", "hel", "hell", "hello"), failing the poll.
    await page.locator(INPUT).pressSequentially("hello", { delay: 20 });

    await expect.poll(() => searchQueries(page)).toEqual(["hello"]);
    // Scoped to the active channel (#general = 1), not a global search.
    expect(await searchChannelIds(page)).toEqual(["1"]);
  });

  test("a below-minimum query shows the hint and clears prior results", async ({ page }) => {
    await openOverlay(page);

    await page.locator(INPUT).fill("ab");
    await expect(page.locator("[data-testid='search-result-0']")).toBeVisible();
    expect(await searchQueries(page)).toEqual(["ab"]);

    // Shrink to one character: the guard clears the rows already on screen and
    // shows the hint, without issuing a search for the short query.
    await page.locator(INPUT).fill("a");
    await expect(page.locator(STATUS)).toHaveText(/at least 2 characters/);
    await expect(page.locator(".search-result-item")).toHaveCount(0);
    expect(await searchQueries(page)).toEqual(["ab"]);
  });

  test("renders each result with channel, author and content", async ({ page }) => {
    await openOverlay(page);
    await page.locator(INPUT).fill("hello");

    const first = page.locator("[data-testid='search-result-0']");
    await expect(first).toBeVisible();
    await expect(first.locator(".search-result-channel")).toHaveText("#general");
    await expect(first.locator(".search-result-author")).toHaveText("testuser");
    await expect(first.locator(".search-result-content")).toHaveText("Hello world!");

    const second = page.locator("[data-testid='search-result-1']");
    await expect(second.locator(".search-result-channel")).toHaveText("#random");
    await expect(second.locator(".search-result-author")).toHaveText("otheruser");
    await expect(second.locator(".search-result-content")).toHaveText("Second result");
  });

  test("ArrowDown and ArrowUp move the active result with wrap-around", async ({ page }) => {
    await openOverlay(page);
    await page.locator(INPUT).fill("hello");

    const first = page.locator("[data-testid='search-result-0']");
    const second = page.locator("[data-testid='search-result-1']");
    await expect(first).toBeVisible();

    // Starts on the first result.
    await expect(first).toHaveClass(/search-result-item--active/);
    await expect(first).toHaveAttribute("aria-selected", "true");

    // Down moves to the second.
    await page.keyboard.press("ArrowDown");
    await expect(second).toHaveClass(/search-result-item--active/);
    await expect(first).not.toHaveClass(/search-result-item--active/);

    // Down again wraps to the first.
    await page.keyboard.press("ArrowDown");
    await expect(first).toHaveClass(/search-result-item--active/);

    // Up from the first wraps to the last.
    await page.keyboard.press("ArrowUp");
    await expect(second).toHaveClass(/search-result-item--active/);
  });

  test("Enter jumps to the active hit, highlights it and closes the overlay", async ({ page }) => {
    await openOverlay(page);
    await page.locator(INPUT).fill("hello");
    await expect(page.locator("[data-testid='search-result-0']")).toBeVisible();

    await page.keyboard.press("Enter");

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    // scrollToMessage flashes the target row for a moment.
    await expect(page.locator("[data-testid='message-101']")).toHaveClass(/highlight-flash/);
  });

  test("clicking a result jumps to that message", async ({ page }) => {
    await openOverlay(page);
    await page.locator(INPUT).fill("hello");

    const first = page.locator("[data-testid='search-result-0']");
    await expect(first).toBeVisible();
    await first.click();

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await expect(page.locator("[data-testid='message-101']")).toHaveClass(/highlight-flash/);
  });

  test("jumping to a hit in another channel switches channels and lands on it", async ({
    page,
  }) => {
    await openOverlay(page);
    await page.locator(INPUT).fill("hello");
    await expect(page.locator("[data-testid='search-result-1']")).toBeVisible();

    // The second hit lives in #random (channel 2): select it and jump.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("random");
    await expect(page.locator("[data-testid='channel-2']")).toHaveClass(/active/);
    // The hit is flashed by the jumper (scrollToMessage), not merely shown by
    // the channel switch — the assertion that distinguishes jump from switch.
    await expect(page.locator("[data-testid='message-201']")).toHaveClass(/highlight-flash/);
  });

  test("Escape closes the overlay", async ({ page }) => {
    await openOverlay(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test("clicking the backdrop closes the overlay", async ({ page }) => {
    await openOverlay(page);
    await page.locator(OVERLAY).click({ position: { x: 10, y: 10 } });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });
});

test.describe("Search overlay — empty results", () => {
  test("shows the no-results status", async ({ page }) => {
    await loginAndWait(page, { results: [] });
    await openOverlay(page);
    await page.locator(INPUT).fill("nothing");

    await expect(page.locator(STATUS)).toHaveText("No results found");
    await expect(page.locator(".search-result-item")).toHaveCount(0);
  });
});
