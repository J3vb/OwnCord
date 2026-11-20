/**
 * The speaking ring a listener sees for someone else, through the real server
 * and SFU. A deafened listener is subscribed to no microphone, so the SFU's
 * own speaker detection never reaches them: a ring that lights there can only
 * be the one the speaker's app reports for itself (voice_speak), relayed by
 * the OwnCord server. Alice's microphone is Chromium's file-backed fake
 * capture looping one second of speech and three of silence
 * (tests/fixtures/audio/speech.wav).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures";
import { fakeMicArgs, joinVoice, setPrefs } from "../support/media";

const SILENCE_SECONDS = 3;

/** The speech fixture followed by silence, as one 48 kHz mono WAV. */
function writeSpeechLoop(): string {
  const speech = readFileSync(resolve("tests/fixtures/audio/speech.wav"));
  const silence = Buffer.alloc(48000 * 2 * SILENCE_SECONDS);
  const header = Buffer.from(speech.subarray(0, 44));
  const data = Buffer.concat([speech.subarray(44), silence]);
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.writeUInt32LE(data.byteLength, 40);
  const path = join(mkdtempSync(join(tmpdir(), "owncord-ring-")), "speech-loop.wav");
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

test.use({
  media: true,
  launchOptions: {
    args: fakeMicArgs(writeSpeechLoop()),
  },
});
test.setTimeout(120_000);

test("a deafened listener sees the ring of someone who speaks", async ({ alice, bob }) => {
  // A fixed threshold, so the gate's verdict does not depend on a model's.
  await setPrefs(alice, { autoInputSensitivity: false, voiceSensitivity: 50 });
  await joinVoice(bob);
  await joinVoice(alice);
  const ownRing = alice.locator(".voice-user-item.speaking", { hasText: "alice" });
  const ringBobSees = bob.locator(".voice-user-item.speaking", { hasText: "alice" });
  await expect(ownRing).toBeVisible({ timeout: 15_000 });

  await bob.getByTestId("ub-deafen").click();
  await expect(bob.getByTestId("ub-deafen")).toHaveAttribute("aria-pressed", "true");

  // Dark in the silence, then lit by the next second of speech: the ring
  // follows the speaker rather than staying as it was when bob deafened.
  await expect(ringBobSees).toBeHidden({ timeout: 15_000 });
  await expect(ringBobSees).toBeVisible({ timeout: 15_000 });
  await expect(ringBobSees).toBeHidden({ timeout: 15_000 });
});
