/**
 * Watching a stream, then reading a text channel (Discord-style): a click on a
 * text channel leaves the stream view at once, voice stays up, and the stream
 * keeps playing in a small mini-player the user can drag around the window.
 *
 * The mocked suite has no LiveKit, so the remote stream is a canvas capture
 * handed to the app's own remote-video callback, caught on its way in through
 * the dev server's module graph. The production preview serves only the
 * bundle, so there the test skips.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithVoice, emitWsMessage, navigateToMainPageReady } from "./helpers";

const VOICE_CHANNEL_ID = 10;
/** MOCK_MEMBERS_MULTI_ROLE: 3 is member1. */
const STREAMER_ID = 3;
const SHOTS = process.env.OWNCORD_SHOTS_DIR;

const gridSlot = (page: Page) => page.locator("[data-testid='video-grid-slot']");
const messagesSlot = (page: Page) => page.locator("[data-testid='messages-slot']");
const mini = (page: Page) => page.locator("[data-testid='stream-mini-player']");

type Win = Window & {
  __remoteVideo?: (userId: number, stream: MediaStream, isScreenshare: boolean) => void;
  __remoteVideoRemoved?: (userId: number, isScreenshare: boolean) => void;
};

function voiceState(camera: boolean) {
  return {
    type: "voice_state",
    payload: {
      user_id: STREAMER_ID,
      username: "member1",
      channel_id: VOICE_CHANNEL_ID,
      muted: false,
      deafened: false,
      speaking: false,
      camera,
      screenshare: false,
    },
  };
}

async function sentTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const log = (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { message?: string } }> }
    ).__invokeLog;
    return log
      .filter((e) => e.cmd === "ws_send")
      .map((e) => {
        try {
          return (JSON.parse(e.args?.message ?? "{}") as { type?: string }).type ?? "";
        } catch {
          return "";
        }
      });
  });
}

/** Sign in, watch member1's camera, and have its stream arrive. */
async function watchStream(page: Page): Promise<void> {
  await mockTauriFullSessionWithVoice(page);
  await page.goto("/");
  // Catch the remote-video callbacks MainPage registers on mount.
  const hooked = await page.evaluate(async (url) => {
    let mod;
    try {
      mod = await import(/* @vite-ignore */ url);
    } catch {
      return false;
    }
    const proto = mod.RemoteTracks.prototype;
    const setVideo = proto.setOnRemoteVideo;
    const setRemoved = proto.setOnRemoteVideoRemoved;
    proto.setOnRemoteVideo = function (cb: never) {
      (window as Win).__remoteVideo = cb;
      return setVideo.call(this, cb);
    };
    proto.setOnRemoteVideoRemoved = function (cb: never) {
      (window as Win).__remoteVideoRemoved = cb;
      return setRemoved.call(this, cb);
    };
    return true;
  }, "/src/features/voice/remoteTracks.ts");
  test.skip(!hooked, "needs the dev server's modules");
  await navigateToMainPageReady(page);

  await emitWsMessage(page, voiceState(true));
  const row = page.locator(`.voice-user-item[data-voice-uid='${STREAMER_ID}']`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
  await expect(gridSlot(page)).toBeVisible({ timeout: 5_000 });

  await page.evaluate((id) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    let n = 0;
    const draw = (): void => {
      ctx.fillStyle = `hsl(${n++ % 360} 80% 50%)`;
      ctx.fillRect(0, 0, 320, 180);
    };
    draw();
    window.setInterval(draw, 50);
    (window as Win).__remoteVideo!(id, canvas.captureStream(20), false);
  }, STREAMER_ID);
  await expect(
    gridSlot(page).locator(`.video-cell[data-user-id='${STREAMER_ID}'] video`),
  ).toHaveCount(1);
}

async function playing(page: Page): Promise<boolean> {
  return mini(page)
    .locator("video")
    .evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2);
}

test.describe("stream mini-player", () => {
  test("a click on the channel already open leaves the stream view, voice stays up", async ({
    page,
  }) => {
    await watchStream(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-watching.png` });

    // general is the open channel under the grid: the click must still land.
    await page.locator(".channel-item:not(.voice)", { hasText: "general" }).click();

    await expect(gridSlot(page)).toBeHidden();
    await expect(messagesSlot(page)).toBeVisible();
    await expect(page.locator("[data-testid='voice-widget']")).toHaveClass(/visible/);
    expect(await sentTypes(page)).not.toContain("voice_leave");
  });

  test("the stream keeps playing in a mini-player that drags within the window", async ({
    page,
  }) => {
    await watchStream(page);
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();
    await expect(messagesSlot(page)).toBeVisible();

    await expect(mini(page)).toBeVisible();
    await expect(mini(page)).toContainText("member1");
    await expect.poll(() => playing(page)).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-mini-player.png` });

    // Dragged far past the top-left corner, it stops at the window's edge.
    const box = (await mini(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(-500, -500, { steps: 5 });
    await page.mouse.up();
    const moved = (await mini(page).boundingBox())!;
    expect(moved.x).toBeGreaterThanOrEqual(0);
    expect(moved.y).toBeGreaterThanOrEqual(0);
    expect(moved.x).toBeLessThan(box.x);
    expect(moved.y).toBeLessThan(box.y);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-mini-dragged.png` });

    // And past the bottom-right one.
    const viewport = page.viewportSize()!;
    await page.mouse.move(moved.x + moved.width / 2, moved.y + 12);
    await page.mouse.down();
    await page.mouse.move(viewport.width + 500, viewport.height + 500, { steps: 5 });
    await page.mouse.up();
    const far = (await mini(page).boundingBox())!;
    expect(far.x + far.width).toBeLessThanOrEqual(viewport.width);
    expect(far.y + far.height).toBeLessThanOrEqual(viewport.height);

    // The position holds for the session: the next mini-player opens there.
    await page.locator("[data-testid='stream-mini-return']").click();
    await expect(mini(page)).toHaveCount(0);
    await page.locator(".channel-item:not(.voice)", { hasText: "general" }).click();
    await expect(mini(page)).toBeVisible();
    const again = (await mini(page).boundingBox())!;
    expect(Math.round(again.x)).toBe(Math.round(far.x));
    expect(Math.round(again.y)).toBe(Math.round(far.y));
  });

  test("returning from the mini-player restores the stream view", async ({ page }) => {
    await watchStream(page);
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();
    await expect(mini(page)).toBeVisible();

    await mini(page).dblclick();

    await expect(mini(page)).toHaveCount(0);
    await expect(gridSlot(page)).toBeVisible();
    const tileVideo = gridSlot(page).locator(`.video-cell[data-user-id='${STREAMER_ID}'] video`);
    await expect(tileVideo).toHaveCount(1);
    await expect
      .poll(() => tileVideo.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2))
      .toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-returned.png` });
  });

  test("stop watching closes the mini-player and leaves the stream unwatched", async ({ page }) => {
    await watchStream(page);
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();
    await expect(mini(page)).toBeVisible();

    await mini(page).hover();
    await page.locator("[data-testid='stream-mini-stop']").click();

    await expect(mini(page)).toHaveCount(0);
    await expect(messagesSlot(page)).toBeVisible();
    await expect(
      gridSlot(page).locator(`.video-cell[data-user-id='${STREAMER_ID}'].video-cell--stopped`),
    ).toHaveCount(1);
  });

  test("pop out moves the stream from the mini-player into its window", async ({ page }) => {
    await watchStream(page);
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();
    await expect(mini(page)).toBeVisible();

    await mini(page).hover();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.locator("[data-testid='stream-mini-popout']").click(),
    ]);

    await expect(mini(page)).toHaveCount(0);
    const video = popup.locator(".video-popout video");
    await expect(video).toHaveCount(1);
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2))
      .toBe(true);
    await expect(messagesSlot(page)).toBeVisible();
  });

  test("the mini-player closes when the stream ends", async ({ page }) => {
    await watchStream(page);
    await page.locator(".channel-item:not(.voice)", { hasText: "random" }).click();
    await expect(mini(page)).toBeVisible();

    await page.evaluate((id) => (window as Win).__remoteVideoRemoved!(id, false), STREAMER_ID);
    await emitWsMessage(page, voiceState(false));

    await expect(mini(page)).toHaveCount(0);
    await expect(messagesSlot(page)).toBeVisible();
  });
});
