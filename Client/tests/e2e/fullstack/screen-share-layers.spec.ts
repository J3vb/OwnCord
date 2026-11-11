import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { expectDecodedMedia, joinVoice } from "../support/media";

test.use({ media: true });
test.setTimeout(180_000);

/** The share's video RTP streams that sent anything over `ms`: one per
 *  simulcast layer the encoder is producing. */
async function liveVideoLayers(page: Page, ms: number): Promise<number> {
  const read = () =>
    page.evaluate(async () => {
      const sent = new Map<string, number>();
      for (const peer of window.__ocMedia.peers) {
        if (peer.connectionState === "closed") continue;
        (await peer.getStats()).forEach((entry) => {
          if (entry.type === "outbound-rtp" && entry.kind === "video")
            sent.set(entry.id, entry.bytesSent ?? 0);
        });
      }
      return [...sent];
    });
  const before = new Map(await read());
  await page.waitForTimeout(ms);
  return (await read()).filter(([id, bytes]) => bytes > (before.get(id) ?? 0)).length;
}

async function shareWatchedAtHigh(alice: Page, bob: Page, backup: boolean): Promise<void> {
  await alice.evaluate((on) => {
    localStorage.setItem("owncord:settings:screenShareQuality", JSON.stringify("high"));
    if (on) localStorage.setItem("owncord:settings:screenShareBackupLayer", "true");
  }, backup);
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);
  const shareBtn = alice.locator(".voice-widget button[aria-label='Screenshare']");
  await shareBtn.click();
  await alice.getByTestId("screen-share-go-live").click();
  await expect(shareBtn).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  const aliceRow = bob.locator(".voice-user-item[data-voice-uid='1']");
  await expect(aliceRow.locator(".vu-live-badge")).toBeVisible({ timeout: 10_000 });
  await aliceRow.click();
  await expectDecodedMedia(bob, true);
}

test("a watched High share encodes one layer by default", async ({ alice, bob }) => {
  await shareWatchedAtHigh(alice, bob, false);
  await expect.poll(() => liveVideoLayers(alice, 2_000), { timeout: 20_000 }).toBe(1);
});

test("with the backup copy on, a watched High share also encodes the 720p layer", async ({
  alice,
  bob,
}) => {
  await shareWatchedAtHigh(alice, bob, true);
  await expect.poll(() => liveVideoLayers(alice, 2_000), { timeout: 20_000 }).toBe(2);
});

/** Bytes of remote audio (the sharer's microphone plus their stream's audio)
 *  that arrived over `ms`. */
async function streamAudioBytesOver(page: Page, ms: number): Promise<number> {
  const read = () =>
    page.evaluate(async () => {
      const bytes: number[] = [];
      for (const peer of window.__ocMedia.peers) {
        if (peer.connectionState === "closed") continue;
        for (const receiver of peer.getReceivers()) {
          if (receiver.track.kind !== "audio") continue;
          (await receiver.getStats()).forEach((entry) => {
            if (entry.type === "inbound-rtp") bytes.push(entry.bytesReceived ?? 0);
          });
        }
      }
      return bytes;
    });
  const before = await read();
  await page.waitForTimeout(ms);
  const after = await read();
  return after.reduce((sum, b, i) => sum + Math.max(0, b - (before[i] ?? 0)), 0);
}

test("muting a watched stream's audio stops it arriving, also after watching it again, and unmuting brings it back", async ({
  alice,
  bob,
}) => {
  await shareWatchedAtHigh(alice, bob, false);
  const tile = bob.locator(
    "[data-testid='video-grid'] .video-cell[data-stream-type='screenshare']",
  );
  const both = await streamAudioBytesOver(bob, 3_000);
  // Only the microphone keeps arriving while the stream's audio is paused at
  // the server, so the total falls by about the stream's share of it.
  const paused = () =>
    expect
      .poll(() => streamAudioBytesOver(bob, 3_000), { timeout: 15_000 })
      .toBeLessThan(both * 0.5);

  await tile.hover();
  await tile.locator(".tile-mute-btn").click();
  await paused();

  // Stop watching and watch again: the new subscription stays paused.
  await tile.hover();
  await tile.locator("[data-tile-control='stop']").click();
  await tile.locator("[data-tile-control='watch']").click();
  await expectDecodedMedia(bob, true);
  await paused();

  await tile.hover();
  await tile.locator(".tile-mute-btn").click();
  await expect
    .poll(() => streamAudioBytesOver(bob, 3_000), { timeout: 15_000 })
    .toBeGreaterThan(both * 0.8);
});
