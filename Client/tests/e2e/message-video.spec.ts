/**
 * Mocked E2E: video attachments play inline. An MP4 and a QuickTime .mov
 * (typed, and untyped as the server stored one before it knew QuickTime)
 * each become a <video> that loads a real picture once play is pressed; a
 * file the engine cannot decode falls back to the download chip.
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
  waitForWsReady,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
} from "./helpers";

const MP4 = readFileSync(resolve("tests/fixtures/video/clip.mp4"));
/** The same clip as an iPhone-style .mov: the ftyp major brand is "qt  ". */
const MOV = Buffer.from(MP4);
MOV.write("qt  ", 8, "ascii");
/** Bytes no demuxer accepts. */
const BROKEN = Buffer.alloc(2048, 0x5a);

const CLIPS = [
  { id: 301, file: "vid-mp4", filename: "clip.mp4", mime: "video/mp4", bytes: MP4 },
  { id: 302, file: "vid-mov", filename: "clip.mov", mime: "video/quicktime", bytes: MOV },
  {
    id: 303,
    file: "vid-old-mov",
    filename: "old.mov",
    mime: "application/octet-stream",
    bytes: MOV,
  },
  {
    id: 304,
    file: "vid-broken",
    filename: "broken.mov",
    mime: "video/quicktime",
    bytes: BROKEN,
  },
];

function videoMessage(clip: (typeof CLIPS)[number]) {
  return {
    id: clip.id,
    channel_id: 1,
    user: { id: 2, username: "otheruser", avatar: "" },
    content: "",
    timestamp: "2026-03-15T10:00:00Z",
    edited_at: null,
    attachments: [
      {
        id: clip.file,
        url: `/api/v1/files/${clip.file}`,
        filename: clip.filename,
        size: clip.bytes.length,
        mime: clip.mime,
      },
    ],
    reactions: [],
    reply_to: null,
    pinned: false,
    deleted: false,
  };
}

async function boot(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ROUTE_HEALTH,
        ROUTE_LOGIN,
        {
          pattern: "/messages",
          status: 200,
          body: { messages: CLIPS.map(videoMessage), has_more: false },
        },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        ...CLIPS.map((clip) => ({
          pattern: `/api/v1/files/${clip.file}`,
          status: 200,
          body: null,
          bodyBytes: Array.from(clip.bytes),
          contentType: clip.mime,
        })),
      ],
      simulateWsFlow: true,
    }),
  );
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

const row = (page: Page, id: number) => page.locator(`[data-testid='message-${id}']`);

test.describe("Video attachments", () => {
  for (const clip of CLIPS.slice(0, 3)) {
    test(`${clip.filename} (${clip.mime}) plays inline`, async ({ page }) => {
      await boot(page);
      const box = row(page, clip.id).locator(".msg-video");
      await expect(box).toBeVisible();
      await box.getByRole("button", { name: `Play ${clip.filename}` }).click();

      const video = box.locator("video");
      await expect(video).toHaveJSProperty("controls", true);
      await expect
        .poll(() =>
          video.evaluate((v: HTMLVideoElement) => ({
            error: v.error?.code ?? null,
            picture: v.readyState >= 2 && v.videoWidth > 0,
          })),
        )
        .toEqual({ error: null, picture: true });
      const rect = await video.boundingBox();
      expect(rect?.height ?? Infinity).toBeLessThanOrEqual(300);
    });
  }

  test("a clip the engine cannot decode becomes the download chip", async ({ page }) => {
    await boot(page);
    const message = row(page, 304);
    await message.getByRole("button", { name: "Play broken.mov" }).click();

    await expect(message.locator("video")).toHaveCount(0);
    await expect(message.locator(".msg-file-name")).toHaveText("broken.mov");
    await expect(message.getByRole("status")).toHaveText("Can't play this format");
    await expect(message.getByRole("button", { name: "Download broken.mov" })).toBeVisible();
  });
});
