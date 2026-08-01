import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import {
  buildTauriMockScript,
  mockTauriFullSession,
  navigateToMainPage,
  navigateToMainPageReady,
  emitWsMessage,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
} from "./helpers";

// ---------------------------------------------------------------------------
// Custom mocks — this spec needs ready payloads the shared helpers don't
// build (an nsfw channel, a pre-seeded mention_count), so it constructs them
// inline with buildTauriMockScript, mirroring mockTauriFullSession.
// ---------------------------------------------------------------------------

/** MOCK_CHANNELS with #general (id 1) flagged nsfw. Channel 1 stays the
 *  default-active channel, so login alone exercises "opening" the gated
 *  channel — no extra click needed to trigger the mount. */
const NSFW_CHANNELS = [
  { id: 1, name: "general", type: "text", position: 0, category: null, nsfw: true },
  { id: 2, name: "random", type: "text", position: 1, category: null },
];

/** MOCK_CHANNELS with #random (id 2) pre-seeded with a mention count, to
 *  cover the ready-payload render path independent of any WS traffic. */
const MENTION_SEEDED_CHANNELS = [
  { id: 1, name: "general", type: "text", position: 0, category: null },
  { id: 2, name: "random", type: "text", position: 1, category: null, mention_count: 3 },
];

async function mockTauriSessionWithChannels(page: Page, channels: unknown[]): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        {
          pattern: "/api/v1/auth/login",
          status: 200,
          body: { token: "mock-session-token-abc123", requires_2fa: false },
        },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      ],
      simulateWsFlow: true,
      readyOverrides: { channels },
    }),
  );
}

// ---------------------------------------------------------------------------
// 1) NSFW age-gate
// ---------------------------------------------------------------------------

test.describe("@parity NSFW age-gate", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriSessionWithChannels(page, NSFW_CHANNELS);
    await page.goto("/");
  });

  test("opening the nsfw channel shows the gate over the message area", async ({ page }) => {
    // Channel 1 (nsfw) is auto-selected as the default active channel, so the
    // gate mounts as part of ordinary login — no extra navigation needed.
    await navigateToMainPage(page);

    const gate = page.locator("[data-testid='nsfw-gate']");
    await expect(gate).toBeVisible({ timeout: 10_000 });
    await expect(gate).toContainText("general");
  });

  test("continuing past the gate reveals the message area", async ({ page }) => {
    await navigateToMainPage(page);

    const gate = page.locator("[data-testid='nsfw-gate']");
    await expect(gate).toBeVisible({ timeout: 10_000 });

    await page.locator("[data-testid='nsfw-gate-continue']").click();

    await expect(gate).not.toBeVisible();
    await expect(page.locator("[data-testid='message-101']")).toBeVisible({ timeout: 5_000 });
  });

  test("opening a normal channel shows no gate", async ({ page }) => {
    await navigateToMainPage(page);

    // Dismiss the gate on the default (nsfw) channel first so the click below
    // is unambiguously about channel 2, not a leftover overlay from channel 1.
    await page.locator("[data-testid='nsfw-gate-continue']").click();
    await expect(page.locator("[data-testid='nsfw-gate']")).not.toBeVisible();

    await page.locator("[data-testid='channel-2']").click();

    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("random");
    await expect(page.locator("[data-testid='nsfw-gate']")).not.toBeVisible();
    await expect(page.locator(".messages-container")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2) Mention badge
// ---------------------------------------------------------------------------

test.describe("@parity mention badge", () => {
  test("a channel with mention_count>0 in the ready payload renders the mention badge", async ({
    page,
  }) => {
    await mockTauriSessionWithChannels(page, MENTION_SEEDED_CHANNELS);
    await page.goto("/");
    await navigateToMainPageReady(page);

    const channelTwo = page.locator("[data-testid='channel-2']");
    await expect(channelTwo).toHaveClass(/mentioned/);

    const badge = page.locator("[data-testid='channel-mentions-2']");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("3");
  });

  test("an incoming @-mention on a non-active channel bumps its badge", async ({ page }) => {
    // Plain MOCK_CHANNELS (1 general, 2 random). Channel 1 is active by
    // default, so a mention delivered to channel 2 exercises the live WS path
    // through dispatcher's highlightsCurrentUser -> incrementMention.
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);

    const channelTwo = page.locator("[data-testid='channel-2']");
    await expect(channelTwo).not.toHaveClass(/mentioned/);

    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 900,
        channel_id: 2,
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "@testuser check this out",
        timestamp: new Date().toISOString(),
        edited_at: null,
        attachments: [],
        reactions: [],
        reply_to: null,
        pinned: false,
        deleted: false,
        mentions: [1],
      },
    });

    await expect(channelTwo).toHaveClass(/mentioned/, { timeout: 5_000 });
    const badge = page.locator("[data-testid='channel-mentions-2']");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");
  });
});

// ---------------------------------------------------------------------------
// 3) Per-channel mute
// ---------------------------------------------------------------------------

test.describe("@parity per-channel mute", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("right-clicking a text channel opens a context menu with a Mute item", async ({ page }) => {
    const channelOne = page.locator("[data-testid='channel-1']");
    await channelOne.click({ button: "right" });

    const menu = page.locator("[data-testid='channel-context-menu']");
    await expect(menu).toBeVisible({ timeout: 5_000 });

    const muteItem = page.locator("[data-testid='ctx-mute-channel']");
    await expect(muteItem).toBeVisible();
    await expect(muteItem).toHaveText("Mute Channel");
  });

  test("clicking Mute toggles the channel's muted state and persists it", async ({ page }) => {
    const channelOne = page.locator("[data-testid='channel-1']");
    await channelOne.click({ button: "right" });
    await page.locator("[data-testid='ctx-mute-channel']").click();

    // The sidebar redraws on CHANNEL_MUTE_CHANGED, so re-query by testid.
    await expect(page.locator("[data-testid='channel-1']")).toHaveClass(/muted/, {
      timeout: 5_000,
    });

    // Persistence: the mute lives in localStorage under the settings prefix,
    // independent of any store/WS round-trip (see @lib/channel-mutes).
    const stored = await page.evaluate(() =>
      localStorage.getItem("owncord:settings:mutedChannels"),
    );
    expect(JSON.parse(stored ?? "[]")).toContain(1);

    // Re-opening the menu reflects the flipped state.
    await page.locator("[data-testid='channel-1']").click({ button: "right" });
    const muteItem = page.locator("[data-testid='ctx-mute-channel']");
    await expect(muteItem).toHaveText("Unmute Channel");

    // Toggle back off and confirm both the DOM class and storage clear.
    await muteItem.click();
    await expect(page.locator("[data-testid='channel-1']")).not.toHaveClass(/muted/, {
      timeout: 5_000,
    });
    const storedAfter = await page.evaluate(() =>
      localStorage.getItem("owncord:settings:mutedChannels"),
    );
    expect(JSON.parse(storedAfter ?? "[]")).not.toContain(1);
  });
});
