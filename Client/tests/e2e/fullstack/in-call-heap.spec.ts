/**
 * The heap stays flat through a long idle call.
 *
 * Alice and Bob sit in a voice call with encrypted audio decoding and nobody
 * touching the app. After a warm-up the heap is sampled (after a forced GC)
 * at a fixed interval; the last sample may not be more than 10 % above the
 * first. The series is attached to the report.
 *
 * Nightly only (nightly-test-depth.yml, 60 minutes): the test skips unless
 * OWNCORD_CALL_SOAK_MIN is set.
 *
 * Env:
 *   OWNCORD_CALL_SOAK_MIN         minutes in the call after warm-up
 *   OWNCORD_CALL_SOAK_SAMPLE_MIN  minutes between samples (default 5)
 *   OWNCORD_CALL_SOAK_WARMUP_MIN  minutes before the first sample (default 5)
 */
import { test, expect } from "./fixtures";
import { expectDecodedMedia, joinVoice } from "../support/media";
import { sampleLifecycle } from "../support/lifecycle-probe";

const SOAK_MIN = Number(process.env.OWNCORD_CALL_SOAK_MIN ?? 0);
const SAMPLE_MIN = Number(process.env.OWNCORD_CALL_SOAK_SAMPLE_MIN ?? 5);
const WARMUP_MIN = Number(process.env.OWNCORD_CALL_SOAK_WARMUP_MIN ?? 5);
const HEAP_GROWTH_BAR = 0.1;

test.use({ media: true, trace: "off", video: "off" });
test.skip(SOAK_MIN <= 0, "nightly only: set OWNCORD_CALL_SOAK_MIN");

test("an hour idle in a call keeps the heap within 10 % of where it started", async ({
  alice,
  bob,
}, info) => {
  test.setTimeout((WARMUP_MIN + SOAK_MIN) * 60_000 + 300_000);
  const cdp = await alice.context().newCDPSession(alice);

  await joinVoice(bob);
  await joinVoice(alice);
  await expectDecodedMedia(alice);
  await alice.waitForTimeout(WARMUP_MIN * 60_000);

  const series: { minute: number; heapUsed: number }[] = [];
  const start = Date.now();
  for (let minute = 0; minute <= SOAK_MIN; minute += SAMPLE_MIN) {
    const wait = start + minute * 60_000 - Date.now();
    if (wait > 0) await alice.waitForTimeout(wait);
    const sample = await sampleLifecycle(alice, cdp, -1);
    series.push({ minute, heapUsed: sample.heapUsed });
  }
  await expectDecodedMedia(alice);

  const first = series[0]!.heapUsed;
  const last = series[series.length - 1]!.heapUsed;
  const growth = last / first - 1;
  const result = { series, growthPct: Math.round(growth * 1000) / 10 };
  console.log(`in-call-heap: ${JSON.stringify(result)}`);
  await info.attach("in-call-heap", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(
    growth,
    `heap grew ${result.growthPct} % over ${SOAK_MIN} min in a call (${first} to ${last} B)`,
  ).toBeLessThanOrEqual(HEAP_GROWTH_BAR);
});
