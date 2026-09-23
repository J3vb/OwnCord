/**
 * OC-0453: leaving voice and rejoining straight away, on the same socket,
 * takes about as long as a first join.
 *
 * A widget disconnect closes the client's LiveKit session and sends
 * voice_leave at once. The server used to call LiveKit's RemoveParticipant on
 * the socket's read loop; for a participant closing its own session LiveKit
 * can answer only after its 3 s routing timeout, so the voice_join right
 * behind the leave waited 3-6 s. Each sample is timed from the click to
 * "Voice Connected" with bob's audio decoding. A stalled rejoin cannot finish under STALL_FLOOR_MS, and a normal
 * one finishes far below it. The leaves must still clean up: bob's room ends
 * with one alice after the rejoins and none after she leaves.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoice, mediaStats } from "../support/media";

test.use({ media: true });
test.setTimeout(180_000);

const REJOINS = 10;
/** LiveKit's routing timeout; a rejoin queued behind it takes at least this. */
const STALL_FLOOR_MS = 3_000;

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

/** Remote participant identities in bob's own LiveKit room. */
async function remoteIdentities(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const info = (
      window as unknown as {
        __owncord: { lkDebug: () => { remoteParticipants?: Array<{ identity: string }> } };
      }
    ).__owncord.lkDebug();
    return (info.remoteParticipants ?? []).map((p) => p.identity);
  });
}

test("an immediate rejoin on the same socket does not wait on the leave's LiveKit removal", async ({
  alice,
  bob,
}, info) => {
  await joinVoice(bob);
  await timeJoin(alice);

  const disconnect = alice.locator(".voice-widget.visible button[aria-label='Disconnect']");
  const samples: number[] = [];
  for (let i = 0; i < REJOINS; i++) {
    await disconnect.click();
    samples.push(await timeJoin(alice));
  }

  console.log(`voice-rejoin: ${JSON.stringify({ samplesMs: samples })}`);
  await info.attach("voice-rejoin", {
    body: JSON.stringify({ samplesMs: samples, stallFloorMs: STALL_FLOOR_MS }, null, 2),
    contentType: "application/json",
  });
  expect(
    samples.filter((ms) => ms >= STALL_FLOOR_MS),
    `rejoins that waited on the previous leave (samples ${samples.join(", ")} ms)`,
  ).toEqual([]);

  // Every earlier session was really removed: bob sees exactly one alice.
  await expect.poll(async () => (await remoteIdentities(bob)).length).toBe(1);
  await disconnect.click();
  await expect(alice.locator(".voice-widget")).not.toHaveClass(/visible/);
  await expect.poll(() => remoteIdentities(bob)).toEqual([]);
});
