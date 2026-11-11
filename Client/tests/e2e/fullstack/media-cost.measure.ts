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
import type { CDPSession, Page } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fromClientRoot } from "../config/clientRoot";
import { expectDecodedMedia, joinVoice } from "../support/media";
import { test, expect } from "./fixtures";

const OUT = fromClientRoot("test-results/media-cost.jsonl");
const QUALITY = process.env.OWNCORD_MEASURE_QUALITY ?? "high";
const FPS = Number(process.env.OWNCORD_MEASURE_FPS ?? 30);
const WINDOW_MS = Number(process.env.OWNCORD_MEASURE_WINDOW_MS ?? 30_000);
const BACKUP = process.env.OWNCORD_MEASURE_BACKUP === "1";

test.use({ media: true });
test.setTimeout(5 * WINDOW_MS + 180_000);

interface RtpEntry {
  readonly id: string;
  readonly dir: "out" | "in";
  readonly kind: string;
  readonly rid?: string;
  readonly bytes: number;
  readonly frames: number;
  /** Seconds spent encoding (out) or decoding (in). */
  readonly codecSecs: number;
  readonly width?: number;
  readonly height?: number;
  readonly impl?: string;
  readonly limitedBy?: string;
}

interface Snapshot {
  readonly atMs: number;
  readonly rtp: readonly RtpEntry[];
  readonly taskSecs: number;
  readonly heapBytes: number;
}

async function rtpEntries(page: Page): Promise<RtpEntry[]> {
  return page.evaluate(async () => {
    const entries: RtpEntry[] = [];
    const reports = await Promise.all(
      window.__ocMedia.peers.filter((p) => p.connectionState !== "closed").map((p) => p.getStats()),
    );
    for (const report of reports) {
      report.forEach((e: Record<string, unknown>) => {
        const out = e.type === "outbound-rtp";
        if (!out && e.type !== "inbound-rtp") return;
        const num = (key: string) => (typeof e[key] === "number" ? (e[key] as number) : 0);
        const str = (key: string) => (typeof e[key] === "string" ? (e[key] as string) : undefined);
        entries.push({
          id: String(e.id),
          dir: out ? "out" : "in",
          kind: str("kind") ?? "",
          rid: str("rid"),
          bytes: num(out ? "bytesSent" : "bytesReceived"),
          frames: num(out ? "framesEncoded" : "framesDecoded"),
          codecSecs: num(out ? "totalEncodeTime" : "totalDecodeTime"),
          width: str("kind") === "video" ? num("frameWidth") : undefined,
          height: str("kind") === "video" ? num("frameHeight") : undefined,
          impl: str(out ? "encoderImplementation" : "decoderImplementation"),
          limitedBy: str("qualityLimitationReason"),
        });
      });
    }
    return entries;
  });
}

async function snapshot(page: Page, cdp: CDPSession): Promise<Snapshot> {
  const rtp = await rtpEntries(page);
  const { metrics } = await cdp.send("Performance.getMetrics");
  const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    atMs: Date.now(),
    rtp,
    taskSecs: metric("TaskDuration"),
    heapBytes: metric("JSHeapUsedSize"),
  };
}

/** The streams that moved between two snapshots, as rates. */
function rates(before: Snapshot, after: Snapshot) {
  const secs = (after.atMs - before.atMs) / 1000;
  const streams = after.rtp.flatMap((e) => {
    const prev = before.rtp.find((p) => p.id === e.id);
    const bytes = e.bytes - (prev?.bytes ?? 0);
    const frames = e.frames - (prev?.frames ?? 0);
    if (bytes <= 0 && frames <= 0) return [];
    return [
      {
        dir: e.dir,
        kind: e.kind,
        rid: e.rid,
        size: e.width === undefined ? undefined : `${e.width}x${e.height}`,
        impl: e.impl,
        limitedBy: e.limitedBy,
        kbps: Math.round((bytes * 8) / secs / 1000),
        fps: Number((frames / secs).toFixed(1)),
        codecMsPerSec: Number((((e.codecSecs - (prev?.codecSecs ?? 0)) * 1000) / secs).toFixed(1)),
      },
    ];
  });
  return {
    secs: Number(secs.toFixed(1)),
    mainThreadPct: Number((((after.taskSecs - before.taskSecs) / secs) * 100).toFixed(2)),
    heapMB: Number((after.heapBytes / 1e6).toFixed(1)),
    streams,
  };
}

async function measure(label: string, pages: Record<string, Page>): Promise<void> {
  const names = Object.keys(pages);
  const cdps = await Promise.all(names.map((n) => pages[n]!.context().newCDPSession(pages[n]!)));
  await Promise.all(cdps.map((c) => c.send("Performance.enable")));
  const before = await Promise.all(names.map((n, i) => snapshot(pages[n]!, cdps[i]!)));
  await pages[names[0]!]!.waitForTimeout(WINDOW_MS);
  const after = await Promise.all(names.map((n, i) => snapshot(pages[n]!, cdps[i]!)));
  const row: Record<string, unknown> = { label, quality: QUALITY, fps: FPS, backup: BACKUP };
  names.forEach((n, i) => (row[n] = rates(before[i]!, after[i]!)));
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
