/**
 * Mocked E2E: video grid chat↔grid toggle (audit batch N6, gap #8).
 *
 * The mocked suite runs without LiveKit, so it cannot create real tiles: the
 * grid only ever gets a cell from a live local camera/screenshare or a
 * TrackSubscribed callback. What the mocked harness CAN drive is the toggle
 * itself, which is the part the audit assigns here — the sidebar's
 * watch-stream click opens the grid over the chat column, switching to a text
 * channel closes it, and a peer who stops streaming closes it on its own.
 *
 * Assertions are on the rendered slot styles, on the sidebar rows that expose
 * the affordance, and on the outgoing `voice_join` frame the app actually sent
 * (`window.__invokeLog`, populated by the Tauri mock).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithVoice, emitWsMessage, navigateToMainPageReady } from "./helpers";

const VOICE_CHANNEL_ID = 10;
/** MOCK_MEMBERS_MULTI_ROLE ids: 2 moderator1, 3 member1, 4 member2. */
const CAMERA_USER_ID = 3;
const SCREEN_USER_ID = 2;
const NON_STREAM_USER_ID = 4;

const gridSlot = (page: Page) => page.locator("[data-testid='video-grid-slot']");
const messagesSlot = (page: Page) => page.locator("[data-testid='messages-slot']");
const inputSlot = (page: Page) => page.locator("[data-testid='input-slot']");

async function boot(page: Page): Promise<void> {
  await mockTauriFullSessionWithVoice(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
}

function voiceState(userId: number, flags: { camera?: boolean; screenshare?: boolean } = {}) {
  return {
    type: "voice_state",
    payload: {
      user_id: userId,
      username:
        userId === CAMERA_USER_ID
          ? "member1"
          : userId === SCREEN_USER_ID
            ? "moderator1"
            : "member2",
      channel_id: VOICE_CHANNEL_ID,
      muted: false,
      deafened: false,
      speaking: false,
      camera: flags.camera ?? false,
      screenshare: flags.screenshare ?? false,
    },
  };
}

/** The app records every IPC invoke; the outgoing WS frames are the `ws_send`s. */
async function sentFrames(
  page: Page,
): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
  return page.evaluate(() => {
    const log = (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { message?: string } }> }
    ).__invokeLog;
    const frames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    for (const entry of log) {
      if (entry.cmd !== "ws_send") continue;
      try {
        frames.push(JSON.parse(entry.args?.message ?? "{}"));
      } catch {
        // Not a JSON client frame; skip.
      }
    }
    return frames;
  });
}

async function waitForSent(page: Page, type: string): Promise<void> {
  await expect
    .poll(async () => (await sentFrames(page)).some((f) => f.type === type), { timeout: 5_000 })
    .toBe(true);
}

test.describe("video grid — chat/grid toggle", () => {
  test("watching a streaming peer opens the grid over the chat surface", async ({ page }) => {
    await boot(page);

    // Default: the grid slot is hidden and the chat column is showing.
    await expect(gridSlot(page)).toBeHidden();
    await expect(messagesSlot(page)).toBeVisible();

    await emitWsMessage(page, voiceState(CAMERA_USER_ID, { camera: true }));
    const row = page.locator(`.voice-user-item[data-voice-uid='${CAMERA_USER_ID}']`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.locator(".vu-status")).toBeVisible();

    await row.click();

    // Watching joins the channel (the row handler must not strand the user on
    // an empty grid) and swaps the chat column for the grid slot.
    await waitForSent(page, "voice_join");
    await expect(gridSlot(page)).toBeVisible({ timeout: 5_000 });
    await expect(messagesSlot(page)).toBeHidden();
    await expect(inputSlot(page)).toBeHidden();
  });

  test("switching to a text channel closes the grid and restores the chat surface", async ({
    page,
  }) => {
    await boot(page);

    await emitWsMessage(page, voiceState(CAMERA_USER_ID, { camera: true }));
    const row = page.locator(`.voice-user-item[data-voice-uid='${CAMERA_USER_ID}']`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click();
    await expect(gridSlot(page)).toBeVisible({ timeout: 5_000 });

    // Switch to a DIFFERENT text channel: general is already active, so
    // clicking it would fire no channel change and prove nothing.
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();

    await expect(gridSlot(page)).toBeHidden({ timeout: 5_000 });
    await expect(messagesSlot(page)).toBeVisible();
    await expect(inputSlot(page)).toBeVisible();
  });

  test("a peer who stops streaming closes the grid", async ({ page }) => {
    await boot(page);

    await emitWsMessage(page, voiceState(CAMERA_USER_ID, { camera: true }));
    const row = page.locator(`.voice-user-item[data-voice-uid='${CAMERA_USER_ID}']`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click();
    await expect(gridSlot(page)).toBeVisible({ timeout: 5_000 });

    // The peer leaves voice entirely — with no stream left there is nothing
    // for the grid to show, so it must close itself rather than sit empty.
    await emitWsMessage(page, {
      type: "voice_leave",
      payload: { user_id: CAMERA_USER_ID, channel_id: VOICE_CHANNEL_ID },
    });

    await expect(gridSlot(page)).toBeHidden({ timeout: 5_000 });
    await expect(messagesSlot(page)).toBeVisible();
  });

  test("a peer sharing their screen is watchable, and a non-streaming peer is not", async ({
    page,
  }) => {
    await boot(page);

    // Positive control: the screenshare row carries the LIVE badge and opens
    // the grid.
    await emitWsMessage(page, voiceState(SCREEN_USER_ID, { screenshare: true }));
    const screenRow = page.locator(`.voice-user-item[data-voice-uid='${SCREEN_USER_ID}']`);
    await expect(screenRow.locator(".vu-live-badge")).toBeVisible({ timeout: 5_000 });
    await screenRow.click();
    await expect(gridSlot(page)).toBeVisible({ timeout: 5_000 });

    // Leave the grid again, then prove a peer with no video is inert: the
    // watch handler is gated on camera/screenshare, so clicking must not
    // reopen the grid over the chat.
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();
    await expect(gridSlot(page)).toBeHidden({ timeout: 5_000 });

    await emitWsMessage(page, voiceState(NON_STREAM_USER_ID));
    const plainRow = page.locator(`.voice-user-item[data-voice-uid='${NON_STREAM_USER_ID}']`);
    await expect(plainRow).toBeVisible({ timeout: 5_000 });
    await plainRow.click();

    await expect(gridSlot(page)).toBeHidden();
    await expect(messagesSlot(page)).toBeVisible();
  });
});
