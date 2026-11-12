// The media baseline, against the real server and LiveKit: how long a viewer
// waits from clicking Watch to the first decoded and presented frame (and to
// the first one at full size), what a steady call and a watched share cost on
// both ends (per-layer sender stats; receiver frame rate, freezes, loss and
// jitter; microphone and screen audio apart; main thread and heap), and what
// stays alive after both leave. A measuring tool, not a gate: the name keeps
// it out of the fullstack run, and `npm run test:e2e:stream-perf` runs it.
// Rows go to test-results/perf/stream-performance.jsonl; summarize them with
// `node scripts/analyze-perf.mjs`.
//
//   OWNCORD_PERF_TRIALS     watch-start trials per run (default 10)
//   OWNCORD_PERF_WINDOW_MS  length of each steady-state window (default 60000)
//   OWNCORD_PERF_ARM, OWNCORD_PERF_SEED  see support/perf-run.ts
//   OWNCORD_MEASURE_QUALITY, OWNCORD_MEASURE_FPS, OWNCORD_MEASURE_BACKUP  as media-cost
import type { Page } from "@playwright/test";
import { expectDecodedMedia, joinVoice, mediaStats } from "../support/media";
import {
  PERF_SEED,
  PERF_TRIALS,
  round,
  startPerfRun,
  type Metrics,
  type PerfRun,
} from "../support/perf-run";
import {
  armWatchTiming,
  frameSampler,
  inboundAudioIds,
  leftovers,
  readRtp,
  slowestSecondFps,
  snapshot,
  windowRates,
  watchDisplayCapture,
  type StreamRate,
} from "../support/stream-performance";
import { test, expect } from "./fixtures";

const QUALITY = process.env.OWNCORD_MEASURE_QUALITY ?? "high";
const FPS = Number(process.env.OWNCORD_MEASURE_FPS ?? 30);
const BACKUP = process.env.OWNCORD_MEASURE_BACKUP === "1";
const WINDOW_MS = Number(process.env.OWNCORD_PERF_WINDOW_MS ?? 60_000);
/** A window whose counters reset is measured again, at most this many times. */
const WINDOW_ATTEMPTS = 3;

test.use({ media: true });
test.setTimeout(3 * WINDOW_ATTEMPTS * WINDOW_MS + PERF_TRIALS * 30_000 + 240_000);

const STREAM_FIELDS = [
  "kbps",
  "fps",
  "codecMsPerFrame",
  "lossPct",
  "jitterMs",
  "freezes",
  "freezeSecs",
  "framesDropped",
] as const;

/** Flattens one page's window into numeric metrics and text labels. */
function flatten(
  page: string,
  rates: ReturnType<typeof windowRates>,
  metrics: Metrics,
  info: Record<string, string>,
) {
  metrics[`${page}.mainThreadPct`] = rates.mainThreadPct;
  metrics[`${page}.heapMB`] = rates.heapMB;
  const seen = new Map<string, number>();
  for (const s of rates.streams) {
    const base = [page, s.dir, s.kind, s.source, s.rid].filter(Boolean).join(".");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const key = count === 0 ? base : `${base}#${count + 1}`;
    for (const field of STREAM_FIELDS) {
      const value = s[field as keyof StreamRate];
      if (typeof value === "number") metrics[`${key}.${field}`] = value;
    }
    for (const label of ["size", "impl", "limitedBy"] as const)
      if (s[label]) info[`${key}.${label}`] = s[label]!;
  }
}

/**
 * One steady-state window over both pages. A window in which a counter
 * reset (a sender or receiver was replaced) is recorded as discarded and
 * measured again.
 */
async function steady(
  run: PerfRun,
  scenario: string,
  pages: Record<string, Page>,
  micIn?: Record<string, Set<string>>,
) {
  const names = Object.keys(pages);
  const cdps = await Promise.all(names.map((n) => pages[n]!.context().newCDPSession(pages[n]!)));
  await Promise.all(cdps.map((c) => c.send("Performance.enable")));
  try {
    for (let attempt = 0; attempt < WINDOW_ATTEMPTS; attempt++) {
      const frames = names.map((n) => frameSampler(pages[n]!));
      const before = await Promise.all(names.map((n, i) => snapshot(pages[n]!, cdps[i]!)));
      frames.forEach((f) => f.start());
      await pages[names[0]!]!.waitForTimeout(WINDOW_MS);
      const after = await Promise.all(names.map((n, i) => snapshot(pages[n]!, cdps[i]!)));
      await Promise.all(frames.map((f) => f.stop()));
      const rates = names.map((_, i) => windowRates(before[i]!, after[i]!, micIn?.[names[i]!]));
      const reasons = rates.flatMap((r) => r.reasons);
      if (reasons.length > 0) {
        run.trial({
          scenario,
          trial: attempt,
          status: "discarded",
          reason: `counter reset: ${reasons.join(", ")}`,
        });
        continue;
      }
      const metrics: Metrics = {};
      const info: Record<string, string> = {};
      names.forEach((n, i) => {
        flatten(n, rates[i]!, metrics, info);
        const slowest = slowestSecondFps(frames[i]!.samples());
        if (rates[i]!.streams.some((s) => s.dir === "in" && s.kind === "video"))
          metrics[`${n}.in.video.slowestSecondFps`] = slowest;
      });
      run.trial({ scenario, trial: attempt, status: "ok", metrics, info });
      return;
    }
  } finally {
    await Promise.all(cdps.map((c) => c.detach()));
  }
}

/** The widest frame the sharer's encoder is producing, once it produces one. */
async function sentWidth(page: Page): Promise<number> {
  let width = 0;
  await expect
    .poll(
      async () => {
        const rtp = await readRtp(page);
        width = Math.max(
          0,
          ...rtp.filter((e) => e.dir === "out" && e.kind === "video").map((e) => e.width ?? 0),
        );
        return width;
      },
      { timeout: 20_000, message: "the share must be encoding before watch timing starts" },
    )
    .toBeGreaterThan(0);
  return width;
}

/** Video bytes arriving at `page` over `ms`. */
async function videoBytesOver(page: Page, ms: number): Promise<number> {
  const before = (await mediaStats(page)).videoBytes;
  await page.waitForTimeout(ms);
  return (await mediaStats(page)).videoBytes - before;
}

async function watchTrial(
  run: PerfRun,
  bob: Page,
  trial: number,
  width: number,
  click: () => Promise<void>,
) {
  const { done } = await armWatchTiming(bob, width);
  await click();
  const t = await done;
  const complete = t.decodedMs !== null && t.presentedMs !== null;
  run.trial({
    scenario: "watch-start",
    trial,
    status: complete ? "ok" : "failed",
    reason: complete ? undefined : "no decoded and presented frame within 20 s",
    metrics: {
      decodedMs: t.decodedMs,
      decodedAtSizeMs: t.decodedAtSizeMs,
      presentedMs: t.presentedMs,
      presentedAtSizeMs: t.presentedAtSizeMs,
      decodedWidth: t.width,
      targetWidth: width,
    },
  });
}

test(`stream performance baseline: ${QUALITY} ${FPS} fps share`, async ({
  alice,
  bob,
  browser,
}) => {
  const run = startPerfRun("stream-performance", browser, {
    quality: QUALITY,
    fps: FPS,
    backup: BACKUP,
    windowMs: WINDOW_MS,
    trials: PERF_TRIALS,
    source: "chromium fake capture",
  });
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
  await expectDecodedMedia(bob);
  await steady(run, "idle-call", { alice, bob });

  // Inbound audio that exists before the share is the microphone.
  const micIn = { alice: await inboundAudioIds(alice), bob: await inboundAudioIds(bob) };
  await watchDisplayCapture(alice);
  const shareBtn = alice.locator(".voice-widget button[aria-label='Screenshare']");
  await shareBtn.click();
  await alice.getByTestId("screen-share-go-live").click();
  await expect(shareBtn).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  const width = await sentWidth(alice);

  const aliceRow = bob.locator(".voice-user-item[data-voice-uid='1']");
  await expect(aliceRow.locator(".vu-live-badge")).toBeVisible({ timeout: 10_000 });
  await watchTrial(run, bob, 0, width, () => aliceRow.click());
  const tile = bob.locator(
    "[data-testid='video-grid'] .video-cell[data-stream-type='screenshare']",
  );
  for (let trial = 1; trial < PERF_TRIALS; trial++) {
    await tile.hover();
    await tile.locator("[data-tile-control='stop']").click();
    await expect(tile.locator("[data-tile-control='watch']")).toBeVisible();
    // The clock starts only once nothing arrives any more, so a frame still
    // in flight from the last subscription cannot end the next trial early.
    await expect.poll(() => videoBytesOver(bob, 1_000), { timeout: 15_000 }).toBe(0);
    await watchTrial(run, bob, trial, width, () =>
      tile.locator("[data-tile-control='watch']").click(),
    );
  }
  await expectDecodedMedia(bob, true);
  await steady(run, "share-watched", { alice, bob }, micIn);

  await tile.hover();
  await tile.locator(".tile-mute-btn").click();
  await steady(run, "share-watched-audio-muted", { alice, bob }, micIn);

  for (const page of [alice, bob])
    await page.locator(".voice-widget.visible button[aria-label='Disconnect']").click();
  for (const page of [alice, bob])
    await expect(page.locator(".voice-widget.visible")).toHaveCount(0);
  await alice.waitForTimeout(5_000);
  const left = { alice: await leftovers(alice), bob: await leftovers(bob) };
  const metrics: Metrics = {};
  for (const [name, counts] of Object.entries(left))
    for (const [k, v] of Object.entries(counts)) metrics[`${name}.${k}`] = round(v, 0);
  run.trial({ scenario: "teardown-leftovers", trial: 0, status: "ok", metrics });

  // What this lane cannot see is written down as unverified, so a summary of
  // these rows never reads as covering it.
  for (const [scenario, reason] of [
    ["native-counters", "the Tauri/Rust voice backend is not in the browser lane"],
    [
      "hardware-encoder",
      "headless Chromium uses software codecs; GPU encoders need a Windows/Linux machine",
    ],
    ["network-shaping", "loopback only; shaped links need a namespace or gateway"],
    ["sfu-restart-reconnect", "SFU restart timing is not measured yet"],
  ] as const)
    run.trial({ scenario, trial: 0, status: "unverified", reason });

  test.info().annotations.push({ type: "perf-run", description: `${run.id} seed ${PERF_SEED}` });
});
