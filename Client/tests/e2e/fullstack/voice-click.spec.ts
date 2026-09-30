/**
 * What a peer hears of a mouse click, through the real capture, processing,
 * encryption and SFU path. Alice's microphone is Chromium's file-backed fake
 * capture looping a recorded click over room noise
 * (tests/fixtures/audio/mouse-click.wav); bob's decoded inbound audio is the
 * measurement.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoice } from "../support/media";
import { openSettings, switchSettingsTab } from "../helpers";

const LOOP_SECONDS = 3;

/** The click one second into a 3 s loop of room noise at about -50 dBFS, as a
 *  48 kHz mono WAV: what Chromium's fake capture device plays on repeat. */
function writeClickLoop(): string {
  const click = readFileSync(resolve("tests/fixtures/audio/mouse-click.wav")).subarray(44);
  const samples = new Int16Array(48000 * LOOP_SECONDS);
  // One-pole low-passed noise from a fixed seed: steady, like a room.
  let seed = 1;
  let low = 0;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    low = 0.95 * low + (seed / 0x100000000 - 0.5);
    samples[i] = Math.round(low * 110);
  }
  for (let i = 0; i < click.length / 2; i++) samples[48000 + i]! += click.readInt16LE(i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  const path = join(mkdtempSync(join(tmpdir(), "owncord-click-")), "click-loop.wav");
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]));
  return path;
}

test.use({
  media: true,
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-audio-capture=${writeClickLoop()}`,
    ],
  },
});
test.setTimeout(180_000);

async function setPrefs(page: Page, prefs: Record<string, unknown>): Promise<void> {
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries))
      localStorage.setItem(`owncord:settings:${key}`, JSON.stringify(value));
  }, prefs);
}

/**
 * The loudest ~200 ms of decoded inbound audio over two loops of the fixture,
 * in dBFS, from the receiver's own energy counters. -120 is digital silence.
 */
async function loudestHeardDb(page: Page): Promise<number> {
  return page.evaluate(
    async (ms) => {
      const samples: Array<[energy: number, seconds: number]> = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        let energy = 0;
        let seconds = 0;
        for (const peer of window.__ocMedia.peers) {
          if (peer.connectionState === "closed") continue;
          (await peer.getStats()).forEach((entry) => {
            if (entry.type !== "inbound-rtp" || entry.kind !== "audio") return;
            energy += entry.totalAudioEnergy ?? 0;
            seconds += entry.totalSamplesDuration ?? 0;
          });
        }
        samples.push([energy, seconds]);
        await new Promise((r) => setTimeout(r, 20));
      }
      let loudest = 0;
      for (let i = 10; i < samples.length; i++) {
        const [e0, t0] = samples[i - 10]!;
        const [e1, t1] = samples[i]!;
        if (t1 - t0 > 0.05)
          loudest = Math.max(loudest, Math.sqrt(Math.max(0, e1 - e0) / (t1 - t0)));
      }
      return loudest <= 0 ? -120 : Math.round(200 * Math.log10(loudest)) / 10;
    },
    LOOP_SECONDS * 2000 + 200,
  );
}

/** The live capture tracks the page opened, newest last. */
const liveCapture = (page: Page) =>
  page.evaluate(() =>
    window.__ocMedia.tracks
      .filter((track) => track.kind === "audio" && track.readyState === "live")
      .map((track) => ({ label: track.label, settings: track.getSettings() })),
  );

const NO_BROWSER_PROCESSING = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** Let the gate's 500 ms start-up grace and 200 ms close time pass. */
const SETTLE_MS = 2500;

async function leaveVoice(page: Page): Promise<void> {
  await page.locator(".voice-widget.visible button[aria-label='Disconnect']").click();
  await expect(page.locator(".voice-widget.visible")).toHaveCount(0);
}

test("a mouse click does not open the voice gate, before or after the SDK republishes the microphone", async ({
  alice,
  bob,
}, info) => {
  await joinVoice(bob);

  // Reference: no gate, no processing. The click is plainly audible.
  await setPrefs(alice, { ...NO_BROWSER_PROCESSING, voiceSensitivity: 100 });
  await joinVoice(alice);
  await alice.waitForTimeout(SETTLE_MS);
  const ungated = await loudestHeardDb(bob);
  await leaveVoice(alice);

  await setPrefs(alice, { voiceSensitivity: 50 });
  await joinVoice(alice);
  await alice.waitForTimeout(SETTLE_MS);
  const gated = await loudestHeardDb(bob);

  // livekit-client's full reconnect builds new peer connections and
  // republishes the microphone on a new sender. That sender used to carry the
  // raw capture track, past the input-volume and sensitivity chain, for the
  // rest of the call.
  const peersBefore = await alice.evaluate(() => {
    for (const peer of window.__ocMedia.peers) peer.close();
    return window.__ocMedia.peers.length;
  });
  await expect
    .poll(
      () =>
        alice.evaluate(
          (before) =>
            window.__ocMedia.peers
              .slice(before)
              .some((peer) =>
                peer
                  .getSenders()
                  .some((s) => s.track?.kind === "audio" && s.track.readyState === "live"),
              ),
          peersBefore,
        ),
      { timeout: 45_000 },
    )
    .toBe(true);
  await alice.waitForTimeout(SETTLE_MS);
  const afterRepublish = await loudestHeardDb(bob);

  const levels = { ungated, gated, afterRepublish };
  console.log(`voice-click gate: ${JSON.stringify(levels)}`);
  await info.attach("voice-click-gate", {
    body: JSON.stringify(levels, null, 2),
    contentType: "application/json",
  });
  expect(ungated, "the reference click must be audible").toBeGreaterThan(-35);
  expect(gated, "click heard through a closed gate").toBeLessThan(-60);
  expect(afterRepublish, "click heard after the microphone was republished").toBeLessThan(-60);
});

test("Enhanced Noise Suppression removes the click with the gate off", async ({
  alice,
  bob,
}, info) => {
  await joinVoice(bob);
  const heard: Record<string, number> = {};
  for (const enhanced of [false, true]) {
    await setPrefs(alice, {
      ...NO_BROWSER_PROCESSING,
      voiceSensitivity: 100,
      enhancedNoiseSuppression: enhanced,
    });
    await joinVoice(alice);
    await alice.waitForTimeout(SETTLE_MS);
    heard[enhanced ? "enhanced" : "off"] = await loudestHeardDb(bob);
    await leaveVoice(alice);
  }

  console.log(`voice-click suppression: ${JSON.stringify(heard)}`);
  await info.attach("voice-click-suppression", {
    body: JSON.stringify(heard, null, 2),
    contentType: "application/json",
  });
  expect(heard.off, "the reference click must be audible").toBeGreaterThan(-35);
  // The 2018 RNNoise model this used to ship left it at about -59 dBFS here;
  // the current model leaves -86 dBFS or less.
  expect(heard.enhanced, "click heard through Enhanced Noise Suppression").toBeLessThan(-70);
});

test("a processing toggle applies to the live microphone and keeps the chosen input device", async ({
  alice,
}) => {
  await joinVoice(alice);
  await openSettings(alice);
  await switchSettingsTab(alice, "Voice & Audio");
  const input = alice.locator("select[aria-label='Input Device']");
  await expect(input.locator("option", { hasText: "Fake Audio Input 1" })).toHaveCount(1);
  await input.selectOption({ label: "Fake Audio Input 1" });
  // The call's microphone and the settings meter's, both on the chosen device.
  const onChosenDevice = async () =>
    (await liveCapture(alice)).map((track) => track.label).join(", ");
  await expect.poll(onChosenDevice).toBe("Fake Audio Input 1, Fake Audio Input 1");

  await alice.locator("[role='switch'][aria-label='Noise Suppression']").click();

  // Restarting the track for the toggle used to reopen the system default.
  await expect
    .poll(async () =>
      (await liveCapture(alice)).map((track) => [track.label, track.settings.noiseSuppression]),
    )
    .toEqual([
      ["Fake Audio Input 1", false],
      ["Fake Audio Input 1", false],
    ]);
});
