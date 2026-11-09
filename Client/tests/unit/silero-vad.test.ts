import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaged worklet model is a JavaScript module.
import { createSileroVad } from "../../public/silero-vad.js";

const modelPath = "public/silero-v5.1.2.bin";
const workletPath = "public/vad-worklet.js";

interface Score {
  frame: number;
  probability: number;
  peak: number;
}
interface TestPort {
  onmessage: ((event: { data: Score }) => void) | null;
  postMessage(message: Omit<Score, "probability">): void;
  close(): void;
}
interface WorkletHarness {
  port: { onmessage(event: { data: unknown }): void; postMessage(message: unknown): void };
  process(inputs: Float32Array[][]): boolean;
}

function createGate() {
  const events: unknown[] = [];
  let Constructor: (new () => WorkletHarness) | undefined;
  runInNewContext(readFileSync(workletPath, "utf8"), {
    AudioWorkletProcessor: class {
      port = { postMessage: (message: unknown) => events.push(message) };
    },
    registerProcessor: (_name: string, ctor: new () => WorkletHarness) => {
      Constructor = ctor;
    },
  });
  if (Constructor === undefined) throw new Error("VAD worklet did not register");
  const gate = new Constructor();
  const control = (data: unknown) => gate.port.onmessage({ data });
  let captured: Omit<Score, "probability"> | undefined;
  const connection: TestPort = {
    onmessage: null,
    postMessage: ({ frame, peak }) => {
      captured = { frame, peak };
    },
    close() {},
  };
  control({ type: "config", threshold: 0.01, speechGate: true });
  control({ type: "silero", port: connection });
  control({ type: "sileroReady" });
  const levels = [new Float32Array(128).fill(0.04)];
  const confidence = [new Float32Array(128).fill(0.99)];
  const audio = () => gate.process([levels, confidence, levels]);
  return {
    control,
    audio,
    report(probability: number, level = 0.04) {
      levels[0]!.fill(level);
      for (let i = 0; i < 12; i++) audio();
      if (captured === undefined) throw new Error("Silero did not capture a frame");
      connection.onmessage?.({ data: { ...captured, probability } });
    },
    gates: () =>
      events
        .filter((event) => (event as { type?: string }).type === "gate")
        .map((event) => (event as { gated: boolean }).gated),
  };
}

describe("Silero speech gate", () => {
  it("rejects silence and recognizes quiet reference speech with the pinned model", () => {
    const model = readFileSync(modelPath);
    expect(createHash("sha256").update(model).digest("hex")).toBe(
      "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    );
    const bytes = Uint8Array.from(model).buffer;
    const vad = createSileroVad(bytes);
    expect(vad.score(new Float32Array(512))).toBeLessThan(0.1);

    const wave = readFileSync("tests/fixtures/audio/speech.wav");
    const samples = new Int16Array(wave.buffer, wave.byteOffset + 44, (wave.length - 44) / 2);
    const frame = new Float32Array(512);
    const probabilities: number[] = [];
    vad.reset();
    for (let start = 0; start + frame.length * 3 <= samples.length; start += frame.length * 3) {
      for (let i = 0; i < frame.length; i++) frame[i] = samples[start + i * 3]! / 327680;
      probabilities.push(vad.score(frame));
    }
    expect(probabilities.filter((score) => score >= 0.8).length).toBeGreaterThan(10);
  });

  it("opens on two consecutive chunks at the 0.35 threshold above the mic level", () => {
    const gate = createGate();
    gate.report(0.35);
    expect(gate.gates()).toEqual([true]);
    gate.report(0.34);
    gate.report(0.35);
    expect(gate.gates()).toEqual([true]);
    gate.report(0.35);
    expect(gate.gates()).toEqual([true, false]);
  });

  it("keeps the mic closed if speech falls below its level threshold", () => {
    const gate = createGate();
    gate.report(0.99, 0.001);
    gate.report(0.99, 0.001);
    expect(gate.gates()).toEqual([true]);
  });

  it("closes after 250 ms of silence plus 150 ms of tail and renews for resumed speech", () => {
    const gate = createGate();
    gate.report(0.35);
    gate.report(0.35);
    // Twelve 32 ms frames are 384 ms, still within the silence and tail.
    for (let i = 0; i < 12; i++) gate.report(0.34);
    expect(gate.gates()).toEqual([true, false]);
    gate.report(0.35);
    for (let i = 0; i < 12; i++) gate.report(0.34);
    expect(gate.gates()).toEqual([true, false]);
    gate.report(0.34);
    expect(gate.gates()).toEqual([true, false, true]);
  });

  it("uses the existing speech gate after the Silero worker fails", () => {
    const gate = createGate();
    gate.report(0.99);
    expect(gate.gates()).toEqual([true]);
    gate.control({ type: "silero", port: null });
    for (let i = 0; i < 12; i++) gate.audio();
    expect(gate.gates()).toEqual([true, false]);
  });
});
