// The sensitivity gate in a real AudioContext: the call's own mic processor
// (RNNoise in its worklet, its verdict on the detector's second input) and
// the detector, over recorded speech followed by typing. The unit tests drive
// the worklets by hand; this proves the graph wires the verdict through.
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { Track } from "livekit-client";
import { createMicProcessor, type MicProcessor } from "../../src/lib/voice/micProcessor";
import { speechDetectionOf, startVadDetector } from "../../src/lib/voice/audioPipeline";
import { vadThreshold } from "../../src/lib/voice/gateScale";
import speechUrl from "../fixtures/audio/speech.wav?url";
import clickUrl from "../fixtures/audio/mouse-click.wav?url";

const RATE = 48000;
const SPEECH_AT_S = 1;
const TYPING_FROM_S = 2.2;
const TYPING_TO_S = 5.2;
const SCENE_S = 6;

async function readWav(url: string): Promise<Float32Array<ArrayBuffer>> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const pcm = new Int16Array(bytes.buffer, 44, (bytes.length - 44) / 2);
  return Float32Array.from(pcm, (v) => v / 32768);
}

/** Room tone, one sentence, then typing at full-scale clicks. Seeded. */
async function speechThenTyping(): Promise<Float32Array<ArrayBuffer>> {
  const [speech, click] = await Promise.all([readWav(speechUrl), readWav(clickUrl)]);
  const out = new Float32Array(SCENE_S * RATE);
  let seed = 1;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < out.length; i++) out[i] = (next() - 0.5) * 0.01;
  const mix = (clip: Float32Array, atS: number, gain: number): void => {
    const at = Math.round(atS * RATE);
    for (let i = 0; i < clip.length && at + i < out.length; i++) out[at + i]! += clip[i]! * gain;
  };
  mix(speech, SPEECH_AT_S, 1);
  for (let t = TYPING_FROM_S; t < TYPING_TO_S; t += 0.06 + next() * 0.16) {
    mix(click, t, 2.5 * (0.4 + next() * 0.8));
  }
  return out;
}

describe("sensitivity gate (real AudioContext)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  it("at the slider's sensitivity, typing after speech does not hold the gate open", async () => {
    const samples = await speechThenTyping();
    // A real click, as in the app: autoplay policy resumes an AudioContext
    // only after a user gesture.
    const button = document.createElement("button");
    button.textContent = "Join voice";
    document.body.appendChild(button);
    await userEvent.click(button);
    button.remove();
    const feed = new AudioContext({ sampleRate: RATE });
    cleanup.push(() => feed.close());
    const input = feed.createMediaStreamDestination();
    const processor: MicProcessor = createMicProcessor();
    cleanup.push(() => processor.destroy());
    await processor.init({
      kind: Track.Kind.Audio,
      track: input.stream.getAudioTracks()[0]!,
    } as never);
    await Promise.all([processor.context.resume(), feed.resume()]);

    const events: Array<{ atMs: number; open: boolean }> = [];
    let startedAt = 0;
    const detector = startVadDetector(
      processor.context,
      processor.analyser!,
      vadThreshold(40),
      {
        // Only the scene's verdicts: the detector settles on silence first.
        onGate: (gated) => {
          if (startedAt > 0) events.push({ atMs: performance.now() - startedAt, open: !gated });
        },
      },
      undefined,
      speechDetectionOf(processor),
    );
    cleanup.push(() => detector.stop());
    // RNNoise is running for the verdict before the scene starts, and the
    // start-up grace and hold are over.
    await expect.poll(() => processor.speechDetection, { timeout: 5000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const buffer = feed.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples, 0);
    const source = feed.createBufferSource();
    source.buffer = buffer;
    source.connect(input);
    startedAt = performance.now();
    source.start();
    await new Promise((resolve) => setTimeout(resolve, SCENE_S * 1000));

    // The sentence opens the gate; it shuts after the hold although the
    // typing goes on, and the typing never reopens it.
    const speechOpen = events.find((e) => e.open && e.atMs >= SPEECH_AT_S * 1000);
    expect(speechOpen).toBeDefined();
    const shut = events.find((e) => !e.open && e.atMs > speechOpen!.atMs);
    expect(shut).toBeDefined();
    expect(shut!.atMs).toBeLessThan((TYPING_FROM_S + 1.3) * 1000);
    expect(events.filter((e) => e.open && e.atMs > shut!.atMs)).toEqual([]);
  }, 30_000);
});
