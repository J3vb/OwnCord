// The voice gate against recorded audio: a mouse click must not open it at
// any sensitivity, and speech must open it inside the pipeline's lookahead so
// the start of a word is not cut off. Drives the real public/vad-worklet.js
// in the 128-sample render quanta the audio thread delivers.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FIXTURE_SAMPLE_RATE, placeInRoomTone, readAudioFixture } from "../helpers/wav";
import { vadThreshold } from "../../src/lib/voice/audioPipeline";
import { useFakeWorkletHost } from "../helpers/workletHost";

type Message = { type: string; gated?: boolean; value?: number };
type Processor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (m: Message) => void };
  process(inputs: Float32Array[][], outputs?: Float32Array[][]): boolean;
  _initWasm?(bytes: ArrayBuffer): Promise<void>;
};

const QUANTUM = 128;
const QUANTUM_MS = (QUANTUM / FIXTURE_SAMPLE_RATE) * 1000;
/** audioPipeline.ts GATE_LOOKAHEAD_S: how far the voice runs behind the gate. */
const LOOKAHEAD_MS = 50;

describe("voice gate on recorded audio", () => {
  let processorCtor: (new () => Processor) | null = null;
  const registered = new Map<string, new () => Processor>();

  useFakeWorkletHost<Processor>((name, ctor) => {
    registered.set(name, ctor);
    if (name === "vad-processor") processorCtor = ctor;
  });
  beforeEach(() => {
    registered.clear();
  });

  /** RNNoise's speech probability for each quantum of `input`, as its
   *  worklet's second output carries it to the gate's second input. */
  async function speechProbabilities(input: Float32Array): Promise<Float32Array[]> {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/rnnoise-worklet.js");
    const rnnoise = new (registered.get("rnnoise-processor")!)();
    const wasm = readFileSync("public/rnnoise.wasm");
    await rnnoise._initWasm!(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length));
    const out: Float32Array[] = [];
    for (let at = 0; at + QUANTUM <= input.length; at += QUANTUM) {
      const speech = new Float32Array(QUANTUM);
      rnnoise.process(
        [[input.subarray(at, at + QUANTUM)]],
        [[new Float32Array(QUANTUM)], [speech]],
      );
      out.push(speech);
    }
    return out;
  }

  /** Run `input` through the gate; every message with the ms it was posted
   *  at. With `speech`, RNNoise's verdict per quantum feeds the gate's second
   *  input and the speech rule is on, as automatic sensitivity runs it. */
  async function gate(sensitivity: number, input: Float32Array, speech?: Float32Array[]) {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/vad-worklet.js");
    const processor = new processorCtor!();
    const messages: Array<Message & { atMs: number }> = [];
    let quantum = 0;
    processor.port.postMessage = (m) => messages.push({ ...m, atMs: quantum * QUANTUM_MS });
    processor.port.onmessage({
      data: {
        type: "config",
        threshold: vadThreshold(sensitivity),
        speechGate: speech !== undefined,
      },
    });
    for (let at = 0; at + QUANTUM <= input.length; at += QUANTUM, quantum++) {
      const audio = [input.subarray(at, at + QUANTUM)];
      processor.process(speech === undefined ? [audio] : [audio, [speech[quantum]!]]);
    }
    return messages;
  }

  const opened = (messages: Array<Message & { atMs: number }>) =>
    messages.filter((m) => m.type === "gate" && m.gated === false);

  // The fixture is a close, dry click. `boost` 2.5 is that click at full scale,
  // which is what the browser's automatic gain control makes of it in a quiet
  // room.
  describe.each([1, 2.5])("a mouse click at x%f level", (boost) => {
    // Up to 50 (-40 dBFS): a gate set under the room tone's own level
    // (-51 dBFS, or 6 dB over it with the hysteresis) never closes.
    it.each([0, 20, 35, 45, 50])("does not open the gate at sensitivity %i", async (s) => {
      const click = readAudioFixture("mouse-click.wav").map((v) => v * boost);
      const messages = await gate(s, placeInRoomTone(click, 1.5, 2.5));

      // Closed by the room tone before the click, and never opened by it.
      expect(messages.some((m) => m.type === "gate" && m.gated === true)).toBe(true);
      expect(opened(messages)).toEqual([]);
    });
  });

  it.each([30, 40, 50])("opens for speech within the lookahead at sensitivity %i", async (s) => {
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

  describe("with RNNoise's verdict (the slider's sensitivity and the automatic one)", () => {
    // The gate levels automatic sensitivity reaches: -40 dBFS over a voice,
    // down to its -55 dBFS floor over suppressed silence.
    it.each([50, 60, 70, 75])(
      "a mouse click does not open the gate at sensitivity %i",
      async (s) => {
        const click = readAudioFixture("mouse-click.wav").map((v) => v * 2.5);
        const input = placeInRoomTone(click, 1.5, 2.5);
        const messages = await gate(s, input, await speechProbabilities(input));
        expect(messages.some((m) => m.type === "gate" && m.gated === true)).toBe(true);
        expect(opened(messages)).toEqual([]);
      },
    );

    it("a burst of clicks (typing) does not open the gate, where its level alone would", async () => {
      // Ten clicks 30 ms apart: enough sustained level to pass the attack.
      const click = readAudioFixture("mouse-click.wav").map((v) => v * 2.5);
      const gap = Math.round(0.03 * FIXTURE_SAMPLE_RATE);
      const typing = new Float32Array(gap * 10 + click.length);
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < click.length; j++)
          typing[i * gap + j] = (typing[i * gap + j] ?? 0) + click[j]!;
      }
      const input = placeInRoomTone(typing, 1.5, 2.5);

      expect(opened(await gate(50, input))).not.toEqual([]);
      expect(opened(await gate(50, input, await speechProbabilities(input)))).toEqual([]);
    });

    it.each([30, 40, 50])(
      "typing after speech does not hold the gate open at sensitivity %i, where its level alone would",
      async (s) => {
        // A sentence, then a few seconds of typing at full-scale clicks.
        const click = readAudioFixture("mouse-click.wav");
        const typing = new Float32Array(Math.round(3 * FIXTURE_SAMPLE_RATE));
        let seed = 5;
        for (let at = 0; at < typing.length - click.length;) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const gain = 2.5 * (0.4 + (seed / 0x100000000) * 0.8);
          for (let j = 0; j < click.length; j++) typing[at + j]! += click[j]! * gain;
          at += Math.round((0.06 + (seed / 0x100000000) * 0.16) * FIXTURE_SAMPLE_RATE);
        }
        const input = placeInRoomTone(readAudioFixture("speech.wav"), 1, 6);
        const typingAt = Math.round(2.2 * FIXTURE_SAMPLE_RATE);
        for (let i = 0; i < typing.length; i++) input[typingAt + i]! += typing[i]!;
        const typingEndMs = 5200;

        const isOpenAt = (messages: Array<Message & { atMs: number }>, ms: number) =>
          !(messages.filter((m) => m.type === "gate" && m.atMs <= ms).at(-1)?.gated ?? false);
        // The level alone: the clicks keep resetting the hold for as long as
        // the typing lasts.
        expect(isOpenAt(await gate(s, input), typingEndMs - 100)).toBe(true);

        // With the verdict the gate closes after the hold and stays shut.
        const messages = await gate(s, input, await speechProbabilities(input));
        const shutAt = messages.find((m) => m.type === "gate" && m.gated === true && m.atMs > 1000);
        expect(shutAt).toBeDefined();
        expect(shutAt!.atMs).toBeLessThan(2200 + 800);
        expect(opened(messages).filter((m) => m.atMs > shutAt!.atMs)).toEqual([]);
      },
    );

    it.each([50, 60, 75])("opens for speech within the lookahead at sensitivity %i", async (s) => {
      const speechAtMs = 1500;
      const input = placeInRoomTone(readAudioFixture("speech.wav"), speechAtMs / 1000, 3);
      const speech = await speechProbabilities(input);
      // The onset: the first quantum the level clears the gate and RNNoise
      // calls a voice. At -55 dBFS the room alone clears the level.
      let onsetMs = Number.NaN;
      for (let quantum = Math.ceil(speechAtMs / QUANTUM_MS); quantum < speech.length; quantum++) {
        const q = input.subarray(quantum * QUANTUM, (quantum + 1) * QUANTUM);
        const loud = Math.sqrt(q.reduce((sum, v) => sum + v * v, 0) / q.length) >= vadThreshold(s);
        if (loud && speech[quantum]![QUANTUM - 1]! >= 0.5) {
          onsetMs = quantum * QUANTUM_MS;
          break;
        }
      }

      const messages = await gate(s, input, speech);

      const firstOpen = opened(messages)[0];
      expect(firstOpen).toBeDefined();
      expect(firstOpen!.atMs - onsetMs).toBeLessThan(LOOKAHEAD_MS);
    });

    it("sensitivity 100 (no gate) stays open: the verdict alone never closes it", async () => {
      const input = placeInRoomTone(new Float32Array(0), 1, 2);
      const messages = await gate(100, input, await speechProbabilities(input));
      expect(messages.some((m) => m.type === "gate" && m.gated === true)).toBe(false);
    });

    it("the room tone closes the gate even at a sensitivity below its level", async () => {
      // -69 dBFS: the level alone would never close on a -51 dBFS room; the
      // verdict "not a voice" does.
      const input = placeInRoomTone(new Float32Array(0), 1, 2);
      const messages = await gate(99, input, await speechProbabilities(input));
      expect(messages.some((m) => m.type === "gate" && m.gated === true)).toBe(true);
    });
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
