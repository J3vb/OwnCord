/**
 * B7 exit gate: the client voice-join budget.
 *
 * Voice-join time is the wall clock from clicking a voice channel to the
 * widget reading "Voice Connected" with the peer's remote audio decoding on
 * this client — the same bar as `expectDecodedMedia` (a connected badge or
 * RTP bytes alone is not a join). It covers the whole client path: the
 * `voice_join` → `voice_token` round trip, the lazy LiveKit chunk, the room
 * connect, the E2EE key exchange, and the first decoded frames.
 *
 * Bob is already in the room and publishing, so every sample is a join into a
 * live call. Every sample is the first join on a fresh application socket
 * (disconnect, drop and restore the socket, join). A rejoin on the same socket
 * straight after a leave queues behind the server's LiveKit participant
 * removal, which can take seconds, and would measure that instead. The median is held to the budget in
 * Client/voice-join-budget.json; every sample is attached to the report. The
 * baseline is recorded in docs/plans/b7-0-client-baseline-2026-09-19.md.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoice, mediaStats } from "../support/media";

test.use({ media: true });
test.setTimeout(180_000);

const SAMPLES = 7;
const { budgetMs } = JSON.parse(
  readFileSync(new URL("../../../voice-join-budget.json", import.meta.url), "utf8"),
) as { budgetMs: number };

async function timeJoin(page: Page): Promise<number> {
  const connected = page.locator(".voice-widget.visible", { hasText: "Voice Connected" });
  const start = Date.now();
  await page.locator(".channel-item.voice", { hasText: "voice-one" }).click();
  await expect
    .poll(
      async () => {
        if ((await connected.count()) === 0) return false;
        const now = await mediaStats(page);
        return now.audioEnergy > 0 && now.audioSamples > 0;
      },
      { intervals: [50], timeout: 30_000 },
    )
    .toBe(true);
  return Date.now() - start;
}

test("voice join reaches decoded remote media within the budget", async ({
  alice,
  bob,
  aliceTransport,
}, info) => {
  await joinVoice(bob);

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) {
      await alice.locator(".voice-widget.visible button[aria-label='Disconnect']").click();
      await expect(alice.locator(".voice-widget")).not.toHaveClass(/visible/);
      // Drop and restore the application socket, as media.spec.ts's
      // reconnect test does: the next join runs on a new server connection.
      await aliceTransport.offline();
      await expect(alice.locator(".reconnecting-banner")).toBeVisible();
      aliceTransport.online();
      await expect(alice.locator(".reconnecting-banner")).not.toBeVisible();
    }
    // No open peer is still decoding, so any audio counted is this join's.
    await expect.poll(async () => (await mediaStats(alice)).audioSamples).toBe(0);
    samples.push(await timeJoin(alice));
  }

  const median = [...samples].sort((a, b) => a - b)[Math.floor(SAMPLES / 2)]!;
  const result = { samplesMs: samples, medianMs: median, budgetMs };
  console.log(`voice-join: ${JSON.stringify(result)}`);
  await info.attach("voice-join", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(median, `median voice join ${median} ms over budget ${budgetMs} ms`).toBeLessThanOrEqual(
    budgetMs,
  );
});
