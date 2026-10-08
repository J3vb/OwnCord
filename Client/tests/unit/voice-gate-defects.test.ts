// Failing-first tests for the voice input chain defects found in the
// owncord-voice-settings-debug scout (2026-10-08). Each `it` is one finding;
// all are expected to FAIL before the fix and pass once the finding is fixed.
// F4 (lookahead vs main-thread trip) is batch 2 and is not covered here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import { FIXTURE_SAMPLE_RATE, placeInRoomTone, readAudioFixture } from "../helpers/wav";
import { vadThreshold } from "../../src/lib/audioPipeline";
import { createMicProcessor } from "../../src/lib/micProcessor";
import {
  FakeAudioContext,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Message = { type: string; gated?: boolean; value?: number };
type Processor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (m: Message) => void };
  process(inputs: Float32Array[][]): boolean;
};
const QUANTUM = 128;
const QUANTUM_MS = (QUANTUM / FIXTURE_SAMPLE_RATE) * 1000;

describe("voice gate defects (vad-worklet.js + micProcessor.ts)", () => {
  let processorCtor: (new () => Processor) | null = null;
  beforeEach(() => {
    vi.resetModules();
    class FakeAudioWorkletProcessor {
      readonly port = { onmessage: null, postMessage: () => {} };
    }
    Object.assign(globalThis, {
      registerProcessor: (_name: string, ctor: new () => Processor) => {
        processorCtor = ctor;
      },
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
    });
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).registerProcessor;
    delete (globalThis as Record<string, unknown>).AudioWorkletProcessor;
    vi.unstubAllGlobals();
  });

  async function gate(sensitivity: number, input: Float32Array) {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/vad-worklet.js");
    const processor = new processorCtor!();
    const messages: Array<Message & { atMs: number }> = [];
    let quantum = 0;
    processor.port.postMessage = (m) => messages.push({ ...m, atMs: quantum * QUANTUM_MS });
    processor.port.onmessage({ data: { type: "config", threshold: vadThreshold(sensitivity) } });
    for (let at = 0; at + QUANTUM <= input.length; at += QUANTUM, quantum++) {
      processor.process([[input.subarray(at, at + QUANTUM)]]);
    }
    return messages;
  }
  /** Fraction of `[fromMs, toMs)` during which the gate was open. */
  function openFraction(messages: Array<Message & { atMs: number }>, fromMs: number, toMs: number) {
    let gated = false,
      openMs = 0,
      last = fromMs;
    for (const m of messages) {
      if (m.type !== "gate") continue;
      if (m.atMs > fromMs) {
        const upto = Math.min(m.atMs, toMs);
        if (!gated) openMs += upto - last;
        last = upto;
      }
      gated = m.gated!;
      if (m.atMs >= toMs) break;
    }
    if (last < toMs && !gated) openMs += toMs - last;
    return openMs / (toMs - fromMs);
  }
  const speech = () => readAudioFixture("speech.wav");
  const scaled = (x: Float32Array, k: number) => x.map((v) => v * k);
  /** micProcessor applies Input Volume ahead of the analyser the worklet reads,
   *  so the worklet sees the mic times the slider. */
  const afterInputVolume = (mic: Float32Array, volume: number) => scaled(mic, volume);

  it("F1: a quiet mic lifted by Input Volume 200 % still transmits at the default sensitivity", async () => {
    // A quiet headset mic: the clip's -24.5 dBFS at half amplitude (-30.5 dBFS),
    // with the slider at 200 %. Without the volume ahead of the tap the worklet
    // sees -30.5 dBFS and the gate stays shut (the smoothing alone opens it
    // 31 % of the time); the remedy for a quiet mic has to be the slider.
    const input = placeInRoomTone(afterInputVolume(scaled(speech(), 0.5), 2), 1, 3);
    const messages = await gate(50, input);
    // Measured before the fix: the gate never opens (0 % of the second) — the user is silent.
    expect(openFraction(messages, 1000, 2000)).toBeGreaterThan(0.8);
  });

  it("F2: the gate opens whenever the settings meter has shown the level above the handle for 100 ms", async () => {
    const input = placeInRoomTone(afterInputVolume(scaled(speech(), 0.5), 2), 1, 3);
    const messages = await gate(50, input);
    const threshold = vadThreshold(50);
    const readings = messages.filter((m) => m.type === "rms");
    // The meter reads the loudest quantum of each ~50 ms: it sits above the
    // handle for two consecutive reports (100 ms, green bar past the handle)...
    const above = readings.findIndex(
      (m, i) => i > 0 && m.value! >= threshold && readings[i - 1]!.value! >= threshold,
    );
    expect(above).toBeGreaterThan(-1);
    // ...so the gate must be open at some point in the 100 ms that follow:
    // the meter and the gate read one level. Measured before the fix: it is not.
    const at = readings[above]!.atMs;
    expect(openFraction(messages, at, at + 100)).toBeGreaterThan(0);
  });

  it("F3: the gate does not close inside a sentence at the fixture's own microphone level", async () => {
    // Three repeats of the clip with 250 ms pauses: one utterance of ~3.5 s.
    const clip = speech();
    const gap = Math.round(0.25 * FIXTURE_SAMPLE_RATE);
    const sentence = new Float32Array(clip.length * 3 + gap * 2);
    for (let r = 0; r < 3; r++) sentence.set(clip, r * (clip.length + gap));
    const input = placeInRoomTone(sentence, 1, 6);
    const messages = await gate(50, input);
    const closes = messages.filter(
      (m) =>
        m.type === "gate" &&
        m.gated === true &&
        m.atMs > 1100 &&
        m.atMs < 1000 + (sentence.length / FIXTURE_SAMPLE_RATE) * 1000,
    );
    // Measured before the fix: it closes twice mid-sentence (and reopens ~70 ms later): the chop.
    expect(closes).toEqual([]);
  });

  it("F5: the Input Volume slider applies ahead of the detector's tap, so it can lift a quiet mic over the gate", async () => {
    installFakeAudio();
    const processor = createMicProcessor();
    await processor.init({ kind: Track.Kind.Audio, track: fakeMediaStreamTrack("mic") } as never);
    const ctx = processor.context as unknown as FakeAudioContext;
    const [entry] = ctx.nodes.filter((n) => n.kind === "gain");
    processor.setInputGain(2);
    // The analyser hangs off `entry`; before the fix entry's gain is fixed at 1 and the
    // volume lives on the output GainNode behind the gate.
    expect(entry!.gain.value).toBe(2);
  });
});
