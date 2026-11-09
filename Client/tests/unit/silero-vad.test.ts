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
  postMessage(message: { frame: number }): void;
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
  let currentFrame = -1;
  const connection: TestPort = {
    onmessage: null,
    postMessage: ({ frame }) => {
      currentFrame = frame;
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
    report(probability: number) {
      for (let i = 0; i < 12; i++) audio();
      connection.onmessage?.({ data: { frame: currentFrame, probability, peak: 0.04 } });
    },
    open: () =>
      events.filter(
        (event) =>
          (event as { type?: string; gated?: boolean }).type === "gate" &&
          (event as { gated?: boolean }).gated === false,
      ),
  };
}

describe("Silero test build", () => {
  it("rejects silence and recognizes quiet reference speech with the pinned model", () => {
    const bytes = Uint8Array.from(readFileSync(modelPath)).buffer;
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

  it("requires three consecutive Silero frames even when level and RNNoise qualify", () => {
    const gate = createGate();
    for (const probability of [0.99, 0.99, 0.25, 0.99, 0.99]) gate.report(probability);
    expect(gate.open()).toHaveLength(0);
    gate.report(0.99);
    expect(gate.open()).toHaveLength(1);
  });

  it("uses the existing speech gate after the Silero worker fails", () => {
    const gate = createGate();
    gate.report(0.99);
    expect(gate.open()).toHaveLength(0);
    gate.control({ type: "silero", port: null });
    for (let i = 0; i < 12; i++) gate.audio();
    expect(gate.open()).toHaveLength(1);
  });
});
