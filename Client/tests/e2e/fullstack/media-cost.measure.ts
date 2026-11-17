// What a call and a screen share cost, against the real server and LiveKit:
// per RTP stream bitrate, frame rate and encode/decode time, plus each page's
// main-thread share. A measuring tool, not a gate: the name keeps it out of
// the fullstack run, and `npm run test:e2e:media-cost` runs it. Each window
// is appended as one JSON line to test-results/media-cost.jsonl.
//
//   OWNCORD_MEASURE_QUALITY  screen share quality (default "high")
//   OWNCORD_MEASURE_FPS      screen share frame rate (default 30)
//   OWNCORD_MEASURE_WINDOW_MS  length of each measured window (default 30000)
//   OWNCORD_MEASURE_BACKUP   "1" turns the share's backup copy on
import type { Page } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fromClientRoot } from "../config/clientRoot";
import { expectDecodedMedia, joinVoice } from "../support/media";
import { snapshot, watchDisplayCapture, windowRates } from "../support/stream-performance";
import { test, expect } from "./fixtures";

const OUT = fromClientRoot("test-results/media-cost.jsonl");
const QUALITY = process.env.OWNCORD_MEASURE_QUALITY ?? "high";
const FPS = Number(process.env.OWNCORD_MEASURE_FPS ?? 30);
const WINDOW_MS = Number(process.env.OWNCORD_MEASURE_WINDOW_MS ?? 30_000);
const BACKUP = process.env.OWNCORD_MEASURE_BACKUP === "1";

test.use({ media: true });
test.setTimeout(5 * WINDOW_MS + 180_000);

async function measure(label: string, pages: Record<string, Page>): Promise<void> {
  const names = Object.keys(pages);
  const cdps = await Promise.all(names.map((n) => pages[n]!.context().newCDPSession(pages[n]!)));
  await Promise.all(cdps.map((c) => c.send("Performance.enable")));
  const before = await Promise.all(names.map((n, i) => snapshot(pages[n]!, cdps[i]!)));
  await pages[names[0]!]!.waitForTimeout(WINDOW_MS);
  const after = await Promise.all(names.map((n, i) => snapshot(pages[n]!, cdps[i]!)));
  const row: Record<string, unknown> = { label, quality: QUALITY, fps: FPS, backup: BACKUP };
  names.forEach((n, i) => (row[n] = windowRates(before[i]!, after[i]!)));
  await Promise.all(cdps.map((c) => c.detach()));
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
  test.info().annotations.push({ type: "media-cost", description: JSON.stringify(row) });
}

test(`media cost of a call and a ${QUALITY} ${FPS} fps screen share`, async ({ alice, bob }) => {
  mkdirSync(dirname(OUT), { recursive: true });
  await alice.evaluate(
    ([quality, fps, backup]) => {
      localStorage.setItem("owncord:settings:screenShareQuality", JSON.stringify(quality));
      localStorage.setItem("owncord:settings:screenShareFps", JSON.stringify(fps));
      localStorage.setItem("owncord:settings:screenShareBackupLayer", JSON.stringify(backup));
    },
    [QUALITY, FPS, BACKUP] as const,
  );
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);
  await measure("idle call", { alice, bob });

  await watchDisplayCapture(alice);
  const shareBtn = alice.locator(".voice-widget button[aria-label='Screenshare']");
  await shareBtn.click();
  await alice.getByTestId("screen-share-go-live").click();
  await expect(shareBtn).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await measure("share, nobody watching", { alice, bob });

  const aliceRow = bob.locator(".voice-user-item[data-voice-uid='1']");
  await expect(aliceRow.locator(".vu-live-badge")).toBeVisible({ timeout: 10_000 });
  await aliceRow.click();
  await expectDecodedMedia(bob, true);
  await measure("share, watched", { alice, bob });

  const tile = bob.locator(
    "[data-testid='video-grid'] .video-cell[data-stream-type='screenshare']",
  );
  await tile.hover();
  await tile.locator(".tile-mute-btn").click();
  await measure("share, watched, its sound muted", { alice, bob });
});
