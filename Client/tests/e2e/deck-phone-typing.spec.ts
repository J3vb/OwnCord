/**
 * Command Deck on a phone while you type (the Developer-mode preview). While
 * the message box has focus, out of a call the status bar's contents hide and
 * the bar keeps its bottom inset; in a call the status bar stays, and the call
 * bar and the tall widget panels hide. On its side your row sits beside the
 * call row, and while typing the top bar keeps only its inset and the chat
 * header goes. In every typing state the message box stays in view.
 *
 * Playwright cannot open a soft keyboard, so it is simulated: the box focused,
 * then the viewport 260 px shorter (upright) or 160 px tall (on its side).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  BASE_SESSION_ROUTES,
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MESSAGES,
  MOCK_VOICE_STATE,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  connectVoiceSession,
  dmChannel,
  joinVoiceChannelByName,
  parkLiveKitSocket,
  voiceJoinWithTokenHandlers,
  voiceWsHandlers,
} from "./helpers";
import { findUnnamedControls } from "./support/accessibility";
import { attachScreenshot, expectNoPageScroll } from "./support/a11yHarness";
import {
  PIXEL_7,
  PIXEL_7_LANDSCAPE,
  SMALL_PHONE,
  TAB_S4,
  startPhoneDeck,
  type PhoneDeckOptions,
} from "./support/phone";
import {
  BAR_LEAVE,
  boxOf,
  enterCall,
  expectOneMuteAndLeave,
  openTree,
  setVoiceFlag,
  statusBar,
} from "./support/phoneCall";

const KEYBOARD_PX = 260;
const GUNMETAL: PhoneDeckOptions = { voice: true, theme: "gunmetal" };

const chatBox = (page: Page): Locator => page.getByTestId("chat-area").getByTestId("msg-textarea");
const callBar = (page: Page): Locator => page.getByTestId("phone-call-bar");
const yourRow = (page: Page): Locator => statusBar(page).locator(".user-bar");
const messages = (page: Page): Locator => page.locator(".chat-area .messages-container");

/** Whether the page carries the typing class. */
const isTyping = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.body.classList.contains("composer-typing"));

/** The message box that has focus is fully in view, and nothing scrolls sideways. */
async function expectBoxInView(page: Page): Promise<void> {
  await expect(page.locator(".message-input-box:focus-within")).toBeInViewport({ ratio: 1 });
  await expectNoPageScroll(page);
}

/** Focuses `box` and shrinks the viewport as a soft keyboard would. */
async function typeIn(page: Page, box: Locator, height?: number): Promise<void> {
  await box.focus();
  await expect.poll(() => isTyping(page)).toBe(true);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: height ?? size.height - KEYBOARD_PX });
}

/** Back closes the keyboard and leaves focus in the box: the viewport grows back. */
async function closeKeyboard(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await expect.poll(() => isTyping(page)).toBe(true);
}

/** A tap on the chat takes focus out of the box. */
async function tapChat(page: Page): Promise<void> {
  await messages(page).tap({ position: { x: 20, y: 20 } });
  await expect.poll(() => isTyping(page)).toBe(false);
}

/** How many of the top bar's children are drawn. */
const topBarShown = (page: Page): Promise<number> =>
  page
    .locator(".deck-top-bar > *")
    .evaluateAll((els) => els.filter((e) => e.checkVisibility()).length);

async function bottomPadding(bar: Locator): Promise<string> {
  return bar.evaluate((el) => getComputedStyle(el).paddingBottom);
}

/** The status bar is there, its contents are hidden, and its bottom padding is `padding`. */
async function expectBarEmpty(page: Page, padding: string): Promise<void> {
  await expect(statusBar(page)).toHaveCount(1);
  await expect(yourRow(page)).toBeHidden();
  expect(await bottomPadding(statusBar(page))).toBe(padding);
  expect(await findUnnamedControls(statusBar(page))).toEqual([]);
}

/** In a call while typing: Mute and Leave in the status bar, the call bar gone, the box in view. */
async function expectCallWhileTyping(page: Page, where: string): Promise<void> {
  await expectOneMuteAndLeave(page, where);
  await expect(callBar(page)).toBeHidden();
  await expectBoxInView(page);
}

// As on a real phone: its WebView cannot share a screen, so the call row has
// no Share button (desktop Chromium, which runs the e2e, can).
async function dropScreenShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia");
  });
}

const THREAD_ID = 50;
const [FIRST] = MOCK_MESSAGES.messages;
/** A voice server whose first message in #general has a thread. */
const THREAD_SCENE = {
  httpRoutes: [
    ROUTE_HEALTH,
    ROUTE_LOGIN,
    {
      pattern: `/channels/${THREAD_ID}/messages`,
      status: 200,
      body: {
        has_more: false,
        messages: [{ ...FIRST, id: 500, channel_id: THREAD_ID, content: "Thread reply" }],
      },
    },
    {
      pattern: "/messages",
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            ...FIRST,
            thread: {
              id: THREAD_ID,
              name: "Plans",
              parent_id: 1,
              starter_message_id: FIRST!.id,
              owner_id: 1,
              message_count: 1,
              locked: false,
              archived: false,
              auto_archive_minutes: 4320,
              created_at: FIRST!.timestamp,
              last_message_at: FIRST!.timestamp,
            },
          },
        ],
      },
    },
  ],
  simulateWsFlow: true,
  wsHandlers: voiceWsHandlers(),
  readyOverrides: { channels: MOCK_CHANNELS_WITH_CATEGORIES, voice_states: MOCK_VOICE_STATE },
};

const DM_ID = 100;
const DM_LIST = [dmChannel(DM_ID, { id: 2, username: "otheruser" })];
/** One DM whose call can be started. */
const DM_CALL_SCENE = {
  httpRoutes: [
    ...BASE_SESSION_ROUTES,
    { pattern: "GET /api/v1/dms", status: 200, body: { dm_channels: DM_LIST } },
  ],
  simulateWsFlow: true,
  wsHandlers: voiceJoinWithTokenHandlers(),
  readyOverrides: { dm_channels: DM_LIST },
};

test.describe("phone Command Deck while typing, 360 x 640", () => {
  test.use(SMALL_PHONE.use);
  test.beforeEach(async ({ page }) => dropScreenShare(page));

  test("out of a call, the status bar's contents hide while the box has focus", async ({
    page,
  }, testInfo) => {
    await startPhoneDeck(page, GUNMETAL);
    await attachScreenshot(testInfo, "360 x 640 at rest", page);
    const padding = await bottomPadding(statusBar(page));
    await expect(yourRow(page)).toBeVisible();

    await chatBox(page).focus();
    await expectBarEmpty(page, padding);
    await expectBoxInView(page);
    // Send is in the box: tapping it keeps the class.
    await chatBox(page).fill("hello");
    await page.getByTestId("chat-area").getByTestId("send-btn").focus();
    await expect.poll(() => isTyping(page)).toBe(true);
    await expectBarEmpty(page, padding);

    await chatBox(page).focus();
    await typeIn(page, chatBox(page));
    await expectBarEmpty(page, padding);
    await expectBoxInView(page);
    await attachScreenshot(testInfo, "360 x 380 typing, out of a call", page);

    await page.setViewportSize({ width: 360, height: 640 });
    await tapChat(page);
    await expect(yourRow(page)).toBeVisible();
  });

  test("box focused, keyboard closed: out of a call the bar stays empty, in a call Mute and Leave stay", async ({
    page,
  }) => {
    const size = { width: 360, height: 640 };
    await startPhoneDeck(page, GUNMETAL);
    const padding = await bottomPadding(statusBar(page));
    await typeIn(page, chatBox(page));
    await closeKeyboard(page, size);
    await expectBarEmpty(page, padding);
    await expectBoxInView(page);
    await tapChat(page);

    await enterCall(page);
    await expect(callBar(page)).toBeVisible();
    await typeIn(page, chatBox(page));
    await closeKeyboard(page, size);
    await expectCallWhileTyping(page, "keyboard closed by Back");
    await tapChat(page);
    await expect(callBar(page)).toBeVisible();
  });

  test("typing in a call keeps Mute and Leave, hides the call bar and the stats pane", async ({
    page,
  }, testInfo) => {
    const size = { width: 360, height: 640 };
    await startPhoneDeck(page, GUNMETAL);
    await enterCall(page);
    await attachScreenshot(testInfo, "360 x 640 in a call", page);
    await typeIn(page, chatBox(page));
    await expectCallWhileTyping(page, "typing in a call");
    // Top bar 36, chat header 48, typing row 24, box 70, status bar 122: about 66.
    expect((await boxOf(messages(page))).height).toBeGreaterThanOrEqual(56);
    await attachScreenshot(testInfo, "360 x 380 typing, in a call", page);

    await page.setViewportSize(size);
    await tapChat(page);
    const stats = statusBar(page).locator(".vw-stats.visible");
    await statusBar(page).locator(".vw-signal").tap();
    await expect(stats).toBeVisible();
    await typeIn(page, chatBox(page));
    await expect(stats).toBeHidden();
    await expect(page.locator(BAR_LEAVE)).toBeInViewport({ ratio: 1 });
    await expect(statusBar(page).locator(".vw-header")).toBeInViewport({ ratio: 1 });
    await expectCallWhileTyping(page, "typing, stats pane open");
  });

  test("typing in a listen-only call keeps Grant mic, 44 px tall", async ({ page }) => {
    await startPhoneDeck(page, GUNMETAL);
    await enterCall(page);
    test.skip(
      !(await setVoiceFlag(page, "setListenOnly")),
      "listen-only cannot be faked in the production build",
    );
    await statusBar(page).locator(".vw-signal").tap();
    await typeIn(page, chatBox(page));
    const grant = statusBar(page).locator(".vw-grant-mic");
    await expect(grant).toBeVisible();
    expect((await boxOf(grant)).height).toBeGreaterThanOrEqual(44);
    await expect(statusBar(page).locator(".vw-mic-notice")).toBeHidden();
    await expect(statusBar(page).locator(".vw-stats")).toBeHidden();
    await expectBoxInView(page);
  });

  test("typing in a degraded call keeps Unsecured in view", async ({ page }, testInfo) => {
    await startPhoneDeck(page, GUNMETAL);
    await enterCall(page);
    test.skip(
      !(await setVoiceFlag(page, "setEncryptionDegraded")),
      "a degraded call cannot be faked in the production build",
    );
    await typeIn(page, chatBox(page));
    const chip = statusBar(page).getByTestId("vw-secured");
    await expect(chip).toHaveText("Unsecured");
    await expect(chip).toBeInViewport({ ratio: 1 });
    await expectBoxInView(page);
    await attachScreenshot(testInfo, "360 x 380 typing, in a degraded call", page);
  });

  test("typing in a thread during a call, then the thread closing with focus in it", async ({
    page,
  }) => {
    await startPhoneDeck(page, { ...GUNMETAL, mock: THREAD_SCENE });
    await enterCall(page);
    await page.locator(".msg-thread-chip, [data-testid^='thread-chip']").first().tap();
    const panel = page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    const threadBox = panel.getByTestId("msg-textarea");
    await typeIn(page, threadBox);
    await expectCallWhileTyping(page, "typing in a thread");

    await page.setViewportSize({ width: 360, height: 640 });
    // Closed without moving focus, as a channel change would: no focusout.
    await panel.getByTestId("thread-close").dispatchEvent("click");
    await expect(panel).toBeHidden();
    await tapChat(page);
    await expectOneMuteAndLeave(page, "after the thread");
    await expect(callBar(page)).toBeVisible();
  });

  test("typing in a DM call keeps Mute and Leave", async ({ page }) => {
    await parkLiveKitSocket(page);
    await startPhoneDeck(page, { theme: "gunmetal", mock: DM_CALL_SCENE });
    await openTree(page);
    await page.locator(`[data-testid=dm-entry][data-channel-id="${DM_ID}"]`).tap();
    await page.getByTestId("call-btn").tap();
    await connectVoiceSession(page);
    // The call view fills the chat while it rings; collapsed, the box shows.
    await page.getByTestId("dcp-collapse").tap();
    await expect(statusBar(page).locator(".voice-widget.visible")).toBeVisible();
    await typeIn(page, chatBox(page));
    await expectOneMuteAndLeave(page, "typing in a DM call");
    await expectBoxInView(page);
  });
});

test.describe("phone Command Deck while typing, Pixel 7", () => {
  test.use(PIXEL_7.use);

  test("typing in a call at 412 x 579 keeps Mute and Leave", async ({ page }, testInfo) => {
    await startPhoneDeck(page, GUNMETAL);
    await attachScreenshot(testInfo, "412 x 839 at rest", page);
    await enterCall(page);
    await typeIn(page, chatBox(page));
    expect(page.viewportSize()).toEqual({ width: 412, height: 579 });
    await expectCallWhileTyping(page, "412 x 579");
  });
});

test.describe("phone Command Deck while typing, on its side", () => {
  test.use(PIXEL_7_LANDSCAPE.use);

  test("in a call at 863 x 360, your row sits beside the call row", async ({ page }, testInfo) => {
    await startPhoneDeck(page, GUNMETAL);
    await enterCall(page);
    const row = await boxOf(yourRow(page));
    const call = await boxOf(statusBar(page).locator(".voice-widget"));
    // Their boxes overlap vertically: one line, side by side.
    expect(row.y).toBeLessThan(call.y + call.height);
    expect(call.y).toBeLessThan(row.y + row.height);
    // With the call bar (72) and your row beside the call row: about 32.
    expect((await boxOf(messages(page))).height).toBeGreaterThanOrEqual(24);
    await expectOneMuteAndLeave(page, "863 x 360");
    await attachScreenshot(testInfo, "863 x 360 in a call", page);
  });

  test("typing in a call at 863 x 160 hides the top bar's buttons and the chat header", async ({
    page,
  }, testInfo) => {
    await startPhoneDeck(page, GUNMETAL);
    await enterCall(page);
    const header = page.getByTestId("chat-header");
    const shown = await topBarShown(page);
    expect(shown).toBeGreaterThan(0);
    await typeIn(page, chatBox(page), 160);
    await expect.poll(() => topBarShown(page)).toBe(0);
    await expect(header).toBeHidden();
    await expectOneMuteAndLeave(page, "863 x 160");
    await expectBoxInView(page);
    await attachScreenshot(testInfo, "863 x 160 typing, in a call", page);

    await page.setViewportSize({ width: 863, height: 360 });
    await tapChat(page);
    await expect.poll(() => topBarShown(page)).toBe(shown);
    await expect(header).toBeVisible();
    await expect(callBar(page)).toBeVisible();
  });
});

test.describe("desktop Command Deck in a short window", () => {
  test("with a mouse at 640 x 400, your row stays 240 px or less, left of the widget", async ({
    page,
  }) => {
    await startPhoneDeck(page, { voice: true });
    await joinVoiceChannelByName(page);
    await page.evaluate(() =>
      (
        window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
      ).__owncord.setVoiceStatus("connected"),
    );
    await page.setViewportSize({ width: 640, height: 400 });
    const row = await boxOf(yourRow(page));
    const widget = await boxOf(statusBar(page).locator(".voice-widget.visible"));
    expect(row.width).toBeLessThanOrEqual(240);
    expect(row.x + row.width).toBeLessThanOrEqual(widget.x);
  });
});

test.describe("a touch tablet entering the phone layout while typing", () => {
  test.use(TAB_S4.use);

  test("1138 x 712 to 1138 x 400 and back keeps focus and text, and hides nothing at the end", async ({
    page,
  }) => {
    const wide = { width: 1138, height: 712 };
    await page.setViewportSize(wide);
    await startPhoneDeck(page, { voice: true });
    const drawer = page.locator("[data-testid='unified-sidebar']");
    const shown = await topBarShown(page);
    await chatBox(page).focus();
    await chatBox(page).fill("draft");
    expect(await isTyping(page)).toBe(false);
    await expectBoxInView(page);

    await page.setViewportSize({ width: 1138, height: 400 });
    await expect.poll(() => isTyping(page)).toBe(true);
    await expect(chatBox(page)).toBeFocused();
    await expect(chatBox(page)).toHaveValue("draft");
    await expect(drawer).not.toHaveClass(/drawer-open/);
    await expectBoxInView(page);

    await page.setViewportSize(wide);
    await expect.poll(() => isTyping(page)).toBe(false);
    await expect(chatBox(page)).toBeFocused();
    await expect(chatBox(page)).toHaveValue("draft");
    await expect(drawer).not.toHaveClass(/drawer-open/);
    await expectBoxInView(page);
    await expect(yourRow(page)).toBeVisible();
    await expect(page.getByTestId("chat-header")).toBeVisible();
    await expect.poll(() => topBarShown(page)).toBe(shown);
  });
});
