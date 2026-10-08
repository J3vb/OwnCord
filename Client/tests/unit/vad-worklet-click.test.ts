// The voice gate against recorded audio: a mouse click must not open it at
// any sensitivity, and speech must open it inside the pipeline's lookahead so
// the start of a word is not cut off. Drives the real public/vad-worklet.js
// in the 128-sample render quanta the audio thread delivers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_SAMPLE_RATE, placeInRoomTone, readAudioFixture } from "../helpers/wav";
import { vadThreshold } from "../../src/lib/audioPipeline";

type Message = { type: string; gated?: boolean; value?: number };
type Processor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (m: Message) => void };
  process(inputs: Float32Array[][]): boolean;
};

const QUANTUM = 128;
const QUANTUM_MS = (QUANTUM / FIXTURE_SAMPLE_RATE) * 1000;
/** audioPipeline.ts GATE_LOOKAHEAD_S: how far the voice runs behind the gate. */
const LOOKAHEAD_MS = 50;

describe("voice gate on recorded audio", () => {
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
  });

  /** Run `input` through the gate; every message with the ms it was posted at. */
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

  const opened = (messages: Array<Message & { atMs: number }>) =>
    messages.filter((m) => m.type === "gate" && m.gated === false);

  // The fixture is a close, dry click. `boost` 2.5 is that click at full scale,
  // which is what the browser's automatic gain control makes of it in a quiet
  // room.
  describe.each([1, 2.5])("a mouse click at x%f level", (boost) => {
    it.each([0, 25, 50, 75, 90, 95])("does not open the gate at sensitivity %i", async (s) => {
      const click = readAudioFixture("mouse-click.wav").map((v) => v * boost);
      const messages = await gate(s, placeInRoomTone(click, 1.5, 2.5));

      // Closed by the room tone before the click, and never opened by it.
      expect(messages.some((m) => m.type === "gate" && m.gated === true)).toBe(true);
      expect(opened(messages)).toEqual([]);
    });
  });

  it.each([50, 75, 90])("opens for speech within the lookahead at sensitivity %i", async (s) => {
    const speechAtMs = 1500;
    const input = placeInRoomTone(readAudioFixture("speech.wav"), speechAtMs / 1000, 3);
    // Where the speech first reaches the threshold: the earliest the gate
    // could know about it.
    let onsetMs = Number.NaN;
    for (let at = (speechAtMs / 1000) * FIXTURE_SAMPLE_RATE; at < input.length; at += QUANTUM) {
      const q = input.subarray(at, at + QUANTUM);
      if (Math.sqrt(q.reduce((sum, v) => sum + v * v, 0) / q.length) >= vadThreshold(s)) {
        onsetMs = (at / FIXTURE_SAMPLE_RATE) * 1000;
        break;
      }
    }

    const messages = await gate(s, input);

    const firstOpen = opened(messages)[0];
    expect(firstOpen).toBeDefined();
    expect(firstOpen!.atMs - onsetMs).toBeLessThan(LOOKAHEAD_MS);
  });

  it("smooths the level over four quanta: one loud quantum reads at half its RMS", async () => {
    const input = new Float32Array(FIXTURE_SAMPLE_RATE).fill(0.01);
    input.fill(0.5, QUANTUM * 312, QUANTUM * 313);

    const messages = await gate(50, input);

    const readings = messages.filter((m) => m.type === "rms").map((m) => m.value!);
    expect(Math.max(...readings)).toBeCloseTo(0.25, 1);
  });

  it("reports the loudest smoothed level since its last report, not whichever came last", async () => {
    // A burst in a run of quiet quanta: the meter reading has to show what the
    // gate compared against, the ~10 ms (4 quanta) smoothed level.
    const input = new Float32Array(FIXTURE_SAMPLE_RATE).fill(0.01);
    input.fill(0.5, QUANTUM * 312, QUANTUM * 316);

    const messages = await gate(50, input);

    const readings = messages.filter((m) => m.type === "rms").map((m) => m.value!);
    expect(Math.max(...readings)).toBeCloseTo(0.5, 5);
  });
});
