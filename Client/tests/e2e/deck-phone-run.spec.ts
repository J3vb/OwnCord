/**
 * Command Deck on a phone: the stored layout decides it, the bars at phone
 * sizes, and Mute and Leave living only in the status bar during a call.
 * Every other surface with its own copy (the call bar, the call view's bar,
 * the DM call panel) hides it, so exactly one of each reaches a tap.
 *
 * The Pixel 7 profiles run the Android app (the Tauri mock and an Android user
 * agent); the iPhone SE profile is a phone browser. All run on Chromium.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MEMBERS_MULTI_ROLE,
  MOCK_ROLES,
  MOCK_VOICE_STATE,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  connectVoiceSession,
  emitWsMessage,
  navigateToMainPage,
  openSettings,
  switchSettingsTab,
  voiceWsHandlers,
  parkLiveKitSocket,
} from "./helpers";
import { findUnnamedControls, focusIndicator } from "./support/accessibility";
import { attachScreenshot, expectNoPageScroll, undersizedTargets } from "./support/a11yHarness";
import {
  IPHONE_SE,
  PIXEL_7,
  PIXEL_7_LANDSCAPE,
  SMALL_PHONE,
  reachableCount,
  restartApp,
  startPhoneDeck,
  type PhoneProfile,
} from "./support/phone";
import {
  BAR_LEAVE,
  BAR_MUTE,
  LEAVE,
  MUTE,
  PHONE_DM as DM,
  boxOf,
  dmCallScene,
  enterCall,
  expectOneMuteAndLeave,
  openTree,
  setVoiceFlag,
  statusBar,
  swipeBuddiesOpen,
} from "./support/phoneCall";

const LAYOUT_KEY = "owncord:settings:screenLayout";

const FORUM = 9;
const THREAD = 50;
const POST = 51;

function thread(id: number, parentId: number, name: string): Record<string, unknown> {
  return {
    id,
    parent_id: parentId,
    name,
    owner_id: 1,
    starter_message_id: id === THREAD ? 101 : null,
    archived: false,
    locked: false,
    auto_archive_minutes: 4320,
    message_count: 3,
    last_message_at: "2026-03-15T10:05:00Z",
    created_at: "2026-03-15T10:00:00Z",
  };
}

const message = (id: number, channelId: number, content: string, extra = {}) => ({
  id,
  channel_id: channelId,
  user: { id: 1, username: "testuser", avatar: "" },
  content,
  timestamp: "2026-03-15T10:00:00Z",
  edited_at: null,
  attachments: [],
  reactions: [],
  reply_to: null,
  pinned: false,
  deleted: false,
  ...extra,
});

const FORUM_POST = {
  ...thread(POST, FORUM, "Dark mode for the phone"),
  post: {
    tag_ids: [],
    first_message: {
      id: 510,
      author_id: 1,
      preview: "Please add it.",
      has_attachments: false,
      deleted: false,
    },
  },
};

/** A voice server with a thread on #general's first message and a forum with one post. */
const SCENE = {
  httpRoutes: [
    ROUTE_HEALTH,
    ROUTE_LOGIN,
    { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
    {
      pattern: `/channels/${FORUM}/threads`,
      status: 200,
      body: { threads: [FORUM_POST], has_more: false, next_before: "" },
    },
    {
      pattern: `/channels/${THREAD}/messages`,
      status: 200,
      body: { messages: [message(500, THREAD, "In the thread")], has_more: false },
    },
    {
      pattern: `/channels/${POST}/messages`,
      status: 200,
      body: { messages: [message(510, POST, "Please add it.")], has_more: false },
    },
    {
      pattern: "/messages",
      status: 200,
      body: {
        messages: [message(101, 1, "Hello world!", { thread: thread(THREAD, 1, "Plans") })],
        has_more: false,
      },
    },
  ],
  simulateWsFlow: true,
  wsHandlers: voiceWsHandlers(),
  readyOverrides: {
    channels: [
      ...MOCK_CHANNELS_WITH_CATEGORIES,
      {
        id: FORUM,
        name: "feedback",
        type: "forum",
        position: 5,
        category: "Text Channels",
        topic: "",
        can_send: true,
        forum: { tags: [], require_tag: false, default_auto_archive_minutes: 4320 },
      },
    ],
    members: MOCK_MEMBERS_MULTI_ROLE,
    roles: MOCK_ROLES,
    voice_states: MOCK_VOICE_STATE,
    capabilities: { forums: true },
  },
};

/** A session with one DM whose call can be started and connected. */
const DM_SCENE = dmCallScene({
  members: [
    { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
    { id: 2, username: "otheruser", avatar: "", status: "online", role: "member" },
  ],
});

const topBar = (page: Page): Locator => page.locator(".deck-top-bar");

/** Both bars sit inside the viewport and nothing scrolls sideways. */
async function expectBarsFit(page: Page): Promise<void> {
  await expectNoPageScroll(page);
  const size = page.viewportSize()!;
  for (const bar of [topBar(page), statusBar(page)]) {
    const box = await boxOf(bar);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height + 0.5);
  }
}

for (const profile of [PIXEL_7, IPHONE_SE, SMALL_PHONE] as readonly PhoneProfile[]) {
  test.describe(`phone Command Deck, ${profile.name}`, () => {
    test.use(profile.use);

    test("runs with Developer mode on, and the bars fit and are named", async ({ page }) => {
      await startPhoneDeck(page);
      await expectBarsFit(page);
      const name = await boxOf(page.getByTestId("user-bar-name"));
      expect(name.width).toBeGreaterThanOrEqual(80);
      expect(
        await undersizedTargets(statusBar(page).locator("button"), { skipHidden: true }),
      ).toEqual([]);
      expect(await findUnnamedControls(topBar(page))).toEqual([]);
      expect(await findUnnamedControls(statusBar(page))).toEqual([]);
      // A keyboard user sees where focus is in the status bar.
      await page.getByTestId("ub-mute").focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("ub-mute")).toBeFocused();
      expect((await focusIndicator(page)).problems).toEqual([]);
    });

    test("runs Classic with Classic stored, and Deck with Deck stored, Developer mode off", async ({
      page,
    }) => {
      await startPhoneDeck(page, { developerMode: false, layout: "classic", seedOnce: true });
      await expect(statusBar(page)).toHaveCount(0);
      expect(await page.evaluate((k) => localStorage.getItem(k), LAYOUT_KEY)).toBe('"classic"');
      await page.evaluate((k) => localStorage.setItem(k, JSON.stringify("deck")), LAYOUT_KEY);
      await page.reload();
      await navigateToMainPage(page);
      await expect(page.locator("html")).toHaveClass(/layout-deck/);
      await expect(statusBar(page)).toHaveCount(1);
    });

    test("in a call, one Mute and one Leave, in the status bar, wherever you are", async ({
      page,
    }, testInfo) => {
      await startPhoneDeck(page, { voice: true, mock: SCENE });
      await enterCall(page);
      await expectBarsFit(page);
      expect(await findUnnamedControls(statusBar(page))).toEqual([]);
      expect(
        await undersizedTargets(statusBar(page).locator("button"), { skipHidden: true }),
      ).toEqual([]);
      // A normal call keeps "Secured" for screen readers only.
      const chip = statusBar(page).getByTestId("vw-secured");
      expect(await boxOf(chip).then((b) => b.width <= 1)).toBe(true);
      await expectOneMuteAndLeave(page, "the chat view");
      await attachScreenshot(testInfo, "in a call", page);

      // The call bar names the channel and opens the call view.
      const bar = page.getByTestId("phone-call-bar");
      await expect(bar.getByTestId("pcb-name")).toHaveText("Voice Chat");
      await bar.getByTestId("pcb-open").tap();
      await expect(page.getByTestId("video-grid")).toBeVisible();
      await expectOneMuteAndLeave(page, "the call view");
      await openTree(page);
      await page.getByTestId("channel-1").tap();
      await expect(page.getByTestId("video-grid")).toBeHidden();

      // A thread opened during the call: the call bar's column hides, the status bar stays.
      await page.locator(".msg-thread-chip, [data-testid^='thread-chip']").first().tap();
      await expect(page.getByTestId("thread-panel")).toBeVisible();
      await expectOneMuteAndLeave(page, "a thread");
      await page.getByTestId("thread-close").tap();
      await expect(page.getByTestId("thread-panel")).toBeHidden();
      await expectOneMuteAndLeave(page, "after the thread");

      // A forum post.
      await openTree(page);
      await page.getByTestId(`channel-${FORUM}`).tap();
      await page.getByTestId(`forum-post-${POST}`).tap();
      await expect(page.getByTestId("thread-panel")).toBeVisible();
      await expectOneMuteAndLeave(page, "a forum post");
      await page.getByTestId("thread-close").tap();

      // A content view (People).
      await openTree(page);
      await page.getByTestId("dm-people-entry").tap();
      await expect(page.getByTestId("feature-view")).toBeVisible();
      await expect(page.getByTestId("chat-area")).toBeHidden();
      await expectOneMuteAndLeave(page, "People");
    });

    test("in a DM call, one Mute and one Leave, in the status bar", async ({ page }) => {
      await parkLiveKitSocket(page);
      await startPhoneDeck(page, { mock: DM_SCENE });
      await openTree(page);
      await page.locator(`[data-testid=dm-entry][data-channel-id="${DM}"]`).tap();
      await page.getByTestId("call-btn").tap();
      await connectVoiceSession(page);
      await emitWsMessage(page, {
        type: "voice_state",
        payload: {
          user_id: 2,
          channel_id: DM,
          username: "otheruser",
          muted: false,
          deafened: false,
          speaking: false,
          camera: false,
          screenshare: false,
        },
      });
      const panel = page.getByTestId("dm-call-panel");
      await expect(panel).toHaveAttribute("data-state", "connected");
      await expect(panel.getByTestId("dcp-mute")).toBeHidden();
      await expectOneMuteAndLeave(page, "a DM call");
      expect(await findUnnamedControls(panel)).toEqual([]);
    });

    test("Clear all cache & restart keeps Command Deck", async ({ page }) => {
      await startPhoneDeck(page, { seedOnce: true });
      await openSettings(page);
      await switchSettingsTab(page, "Advanced");
      const clear = page
        .locator(".setting-row", { hasText: "Clear all cache & restart" })
        .locator("button.ac-btn");
      await clear.tap();
      await restartApp(page, () => clear.tap());
      await navigateToMainPage(page);
      await expect(page.locator("html")).toHaveClass(/layout-deck/);
      expect(await page.evaluate((k) => localStorage.getItem(k), LAYOUT_KEY)).toBe('"deck"');
    });

    test("the emoji sheet, a profile sheet and the call view open as on Classic phone", async ({
      page,
    }) => {
      await startPhoneDeck(page, { voice: true });
      const width = page.viewportSize()!.width;
      await page.locator(".emoji-btn").tap();
      const emoji = page.getByTestId("expression-sheet");
      await expect(emoji).toBeVisible();
      expect(Math.round((await boxOf(emoji)).width)).toBe(width);
      await page.keyboard.press("Escape");
      await expect(emoji).toBeHidden();

      await page.getByTestId("member-list-toggle").tap();
      await page.locator("#member-column .member-item").first().tap();
      const profileSheet = page.getByTestId("profile-sheet");
      await expect(profileSheet).toBeVisible();
      expect(Math.round((await boxOf(profileSheet)).width)).toBe(width);
      await page.keyboard.press("Escape");
      await expect(profileSheet).toBeHidden();

      await enterCall(page);
      await page.getByTestId("pcb-open").tap();
      await expect(page.getByTestId("video-grid")).toBeVisible();
      await expectNoPageScroll(page);
    });
  });
}

test.describe("phone Command Deck at 360 x 640", () => {
  test.use(SMALL_PHONE.use);

  // As on a real phone: its WebView cannot share a screen, so the call row has
  // no Share button (desktop Chromium, which runs the e2e, can).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia");
    });
  });

  test("in a call the messages keep 240 px, and the stats pane leaves Leave and the header in view", async ({
    page,
  }) => {
    await startPhoneDeck(page, { voice: true });
    await enterCall(page);
    const list = await boxOf(page.locator(".messages-container").first());
    expect(list.height).toBeGreaterThanOrEqual(240);

    const expectCallRowInView = async (where: string): Promise<void> => {
      expect(await reachableCount(page, LEAVE), `Leave, ${where}`).toBe(1);
      await expect(statusBar(page).locator(".vw-header"), where).toBeInViewport({ ratio: 1 });
    };
    await statusBar(page).locator(".vw-signal").tap();
    await expect(statusBar(page).locator(".vw-stats.visible")).toBeVisible();
    await expectCallRowInView("stats pane open");

    // A soft keyboard, simulated: the box focused and the viewport 260 px shorter.
    await page.locator(".message-input-wrap textarea").focus();
    await page.setViewportSize({ width: 360, height: 380 });
    await expectCallRowInView("stats pane open, keyboard up");
    await expectNoPageScroll(page);
  });

  test("if the voice widget never loads, the call bar keeps Mute and Leave", async ({ page }) => {
    await page.route(/\/VoiceWidget[^/]*\.(ts|js)(\?|$)/, (route) => route.abort());
    await startPhoneDeck(page, { voice: true });
    await openTree(page);
    await page.locator(".channel-item.voice", { hasText: "Voice Chat" }).tap();
    await page.getByTestId("join-sheet-join").tap();
    await expect(page.locator("html")).not.toHaveClass(/voice-widget-up/);
    await expect.poll(() => reachableCount(page, LEAVE), "Leave without the widget").toBe(1);
    await expect
      .poll(() => reachableCount(page, MUTE), "Mute without the widget")
      .toBeGreaterThan(0);
    await expect(statusBar(page).locator(".voice-widget")).toHaveCount(0);
  });

  test("a degraded call shows Unsecured in the status bar", async ({ page }) => {
    await startPhoneDeck(page, { voice: true });
    await enterCall(page);
    test.skip(
      !(await setVoiceFlag(page, "setEncryptionDegraded")),
      "a degraded call cannot be faked in the production build",
    );
    const chip = statusBar(page).getByTestId("vw-secured");
    await expect(chip).toHaveText("Unsecured");
    await expect(chip).toBeInViewport({ ratio: 1 });
    await expectNoPageScroll(page);
  });
});

test.describe("phone Command Deck across 899/900 px", () => {
  test.use(PIXEL_7.use);

  test("resizing keeps Mute and Leave reachable in the status bar", async ({ page }) => {
    await startPhoneDeck(page, { voice: true });
    await enterCall(page);
    await expectOneMuteAndLeave(page, "412 px");
    await page.setViewportSize({ width: 900, height: 839 });
    await expect.poll(() => reachableCount(page, BAR_MUTE)).toBe(1);
    await expect.poll(() => reachableCount(page, BAR_LEAVE)).toBe(1);
    await expectNoPageScroll(page);
    await page.setViewportSize({ width: 899, height: 839 });
    await expectOneMuteAndLeave(page, "899 px");
    await expectNoPageScroll(page);
  });
});

test.describe("phone Command Deck on its side", () => {
  test.use(PIXEL_7_LANDSCAPE.use);

  test("in a call at 863 x 360, one Mute and one Leave, and nothing scrolls sideways", async ({
    page,
  }, testInfo) => {
    await startPhoneDeck(page, { voice: true });
    await attachScreenshot(testInfo, "at rest", page);
    await enterCall(page);
    await expectOneMuteAndLeave(page, "863 x 360");
    await expectNoPageScroll(page);
    await attachScreenshot(testInfo, "in a call", page);
  });
});

test.describe("phone Command Deck, Buddies in a call", () => {
  test.use(PIXEL_7.use);

  test("Buddies swiped open while the message box has focus keeps Mute, Leave and the focus", async ({
    page,
  }) => {
    await startPhoneDeck(page, { voice: true });
    await enterCall(page);
    const box = page.locator(".message-input-wrap textarea");
    await box.focus();
    await swipeBuddiesOpen(page);
    await expect(page.locator("#member-column")).toBeVisible();
    await expect(box).toBeFocused();
    await expect.poll(() => reachableCount(page, MUTE)).toBe(1);
    await expect.poll(() => reachableCount(page, LEAVE)).toBe(1);
    const column = await boxOf(page.locator("#member-column"));
    const bar = await boxOf(statusBar(page));
    expect(column.y + column.height).toBeLessThanOrEqual(bar.y + 0.5);
  });
});
