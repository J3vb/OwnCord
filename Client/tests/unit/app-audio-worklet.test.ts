// The app-audio worklet's jitter buffer (public/app-audio-worklet.js): plays
// from 40 ms, outputs silence on underrun until refilled to 40 ms, and never
// holds more than 200 ms (the oldest audio is dropped). Drives the real
// worklet file in 128-sample render quanta, as the vad-worklet tests do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Processor = {
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

const QUANTUM = 128;
const MS = 48; // frames per millisecond at 48 kHz

describe("app-audio worklet jitter buffer", () => {
  let ctor: (new () => Processor) | null = null;
  let registered = "";

  beforeEach(async () => {
    class FakeAudioWorkletProcessor {
      readonly port = { onmessage: null };
    }
    Object.assign(globalThis, {
      registerProcessor: (name: string, c: new () => Processor) => {
        registered = name;
        ctor = c;
      },
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
    });
    vi.resetModules();
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/app-audio-worklet.js");
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).registerProcessor;
    delete (globalThis as Record<string, unknown>).AudioWorkletProcessor;
  });

  /** A processor, with a feeder for ramped stereo audio (L = n, R = -n). */
  function rig() {
    const p = new ctor!();
    let next = 1;
    const feed = (frames: number): void => {
      const samples = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        samples[i * 2] = next;
        samples[i * 2 + 1] = -next;
        next++;
      }
      p.port.onmessage({ data: samples });
    };
    const quantum = (): { l: Float32Array; r: Float32Array } => {
      const l = new Float32Array(QUANTUM).fill(9);
      const r = new Float32Array(QUANTUM).fill(9);
      expect(p.process([], [[l, r]])).toBe(true);
      return { l, r };
    };
    return { p, feed, quantum };
  }

  const silent = (a: Float32Array): boolean => a.every((v) => v === 0);

  it("registers the processor the page constructs", () => {
    expect(registered).toBe("app-audio-processor");
  });

  it("outputs silence until 40 ms are buffered, then plays in order", () => {
    const { feed, quantum } = rig();
    feed(39 * MS);
    expect(silent(quantum().l)).toBe(true);
    feed(1 * MS);
    const out = quantum();
    expect(out.l[0]).toBe(1);
    expect(out.r[0]).toBe(-1);
    expect(out.l[QUANTUM - 1]).toBe(QUANTUM);
    const again = quantum();
    expect(again.l[0]).toBe(QUANTUM + 1);
  });

  it("outputs silence on underrun and waits for the target before playing again", () => {
    const { feed, quantum } = rig();
    feed(40 * MS); // 1920 frames
    let played = 0;
    while (!silent(quantum().l)) played++;
    // 15 full quanta (1920) fit; the 16th finds none left.
    expect(played).toBe(15);
    feed(10 * MS); // below the target: still silent
    expect(silent(quantum().l)).toBe(true);
    feed(30 * MS); // back to 40 ms
    expect(silent(quantum().l)).toBe(false);
  });

  it("drops the oldest audio beyond 200 ms", () => {
    const { feed, quantum } = rig();
    feed(150 * MS);
    feed(150 * MS); // 300 ms in, 200 ms kept: the first 100 ms are gone
    const out = quantum();
    expect(out.l[0]).toBe(100 * MS + 1);
  });

  it("drops part of a chunk, not only whole ones", () => {
    const { feed, quantum } = rig();
    feed(MS * 190);
    feed(MS * 20); // 210 ms: 10 ms over
    expect(quantum().l[0]).toBe(10 * MS + 1);
  });

  it("trims a buffer parked above twice the target for a second back to the target", () => {
    const { feed, quantum } = rig();
    feed(150 * MS); // 150 ms: above 80 ms, below the cap
    // One second of playback at constant 150 ms (feed what is played).
    let quanta = 0;
    while (quanta < 375) {
      quantum();
      feed(QUANTUM);
      quanta++;
    }
    // Trimmed to 40 ms at some point: the next audio is well ahead of the
    // un-trimmed stream (which would have kept ~150 ms of backlog).
    const after = quantum();
    expect(after.l[0]!).toBeGreaterThan(1 + 375 * QUANTUM);
  });

  it("does not trim a buffer at or under twice the target", () => {
    const { feed, quantum } = rig();
    feed(70 * MS);
    for (let q = 0; q < 400; q++) {
      quantum();
      feed(QUANTUM);
    }
    // Gapless: the stream position equals the frames played.
    expect(quantum().l[0]).toBe(400 * QUANTUM + 1);
  });

  it("keeps the stream gapless across message boundaries", () => {
    const { feed, quantum } = rig();
    for (let i = 0; i < 6; i++) feed(480); // 10 ms messages, 60 ms
    let expected = 1;
    for (let q = 0; q < 10; q++) {
      const { l, r } = quantum();
      for (let i = 0; i < QUANTUM; i++) {
        expect(l[i]).toBe(expected);
        expect(r[i]).toBe(-expected);
        expected++;
      }
    }
  });

  it("ignores anything that is not a Float32Array", () => {
    const { p, feed, quantum } = rig();
    p.port.onmessage({ data: "hello" });
    p.port.onmessage({ data: new ArrayBuffer(3840) });
    feed(40 * MS);
    expect(quantum().l[0]).toBe(1);
  });

  it("copes with a mono output by writing the left channel", () => {
    const { p, feed } = rig();
    feed(40 * MS);
    const l = new Float32Array(QUANTUM);
    expect(p.process([], [[l]])).toBe(true);
    expect(l[0]).toBe(1);
  });
});
