import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The packaged worklet model is a JavaScript module.
import { createSileroVad } from "../../public/silero-vad.js";

const modelPath = "public/silero-v5.1.2.bin";
const restedModelPath = "public/silero-v6.2.0-slim.bin";
const workletPath = "public/vad-worklet.js";

interface Score {
  frame: number;
  probability: number;
  peak: number;
}
interface TestPort {
  onmessage: ((event: { data: Score }) => void) | null;
  postMessage(message: Omit<Score, "probability"> & { threshold: number }): void;
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
  let threshold: number | undefined;
  const connection: TestPort = {
    onmessage: null,
    postMessage: (message) => {
      captured = { frame: message.frame, peak: message.peak };
      threshold = message.threshold;
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
    /** The threshold sent with the latest frame. */
    sentThreshold: () => threshold,
  };
}

const bytesOf = (path: string): ArrayBuffer => Uint8Array.from(readFileSync(path)).buffer;
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** The reference sentence 20 dB down, as PCM at 48 kHz. */
function quietSpeech(): Float32Array {
  const wave = readFileSync("tests/fixtures/audio/speech.wav");
  const samples = new Int16Array(wave.buffer, wave.byteOffset + 44, (wave.length - 44) / 2);
  return Float32Array.from(samples, (sample) => sample / 327680);
}

/** The same as 16 kHz model frames. */
function quietSpeechFrames(): Float32Array[] {
  const samples = quietSpeech();
  const frames: Float32Array[] = [];
  for (let start = 0; start + 512 * 3 <= samples.length; start += 512 * 3) {
    frames.push(Float32Array.from({ length: 512 }, (_, i) => samples[start + i * 3]!));
  }
  return frames;
}

describe("Silero speech gate", () => {
  it("rejects silence and recognizes quiet reference speech with the pinned model", () => {
    expect(sha256(modelPath)).toBe(
      "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    );
    const vad = createSileroVad(bytesOf(modelPath));
    expect(vad.score(new Float32Array(512))).toBeLessThan(0.1);

    vad.reset();
    const probabilities = quietSpeechFrames().map((frame) => vad.score(frame));
    expect(probabilities.filter((score) => score >= 0.8).length).toBeGreaterThan(10);
    // The scores v5.1.2 shipped with: the second model's support changed none.
    [0.013139, 0.656498, 0.903941, 0.950983, 0.984807].forEach((score, i) => {
      expect(probabilities[i]).toBeCloseTo(score, 5);
    });
  });

  it("scores the second model from its rest state, with the first model's STFT table", () => {
    expect(sha256(restedModelPath)).toBe(
      "536704196b47fb7495731fc0e0d87043b036828f9b963a357d22a1ff6c35ee6a",
    );
    // The file is stored without the table.
    expect(() => createSileroVad(bytesOf(restedModelPath))).toThrow("stft.forward_basis_buffer");
    const { stftBasis } = createSileroVad(bytesOf(modelPath));
    expect(() =>
      createSileroVad(bytesOf(restedModelPath), { stftBasis: stftBasis.subarray(1) }),
    ).toThrow("Invalid Silero STFT table");
    const vad = createSileroVad(bytesOf(restedModelPath), { restFrames: 7, stftBasis });
    expect(vad.score(new Float32Array(512))).toBeLessThan(0.1);

    vad.reset();
    const frames = quietSpeechFrames();
    const probabilities = frames.map((frame) => vad.score(frame));
    expect(probabilities.filter((score) => score >= 0.9).length).toBeGreaterThan(20);
    [0.027296, 0.679495, 0.847635, 0.970695, 0.986468].forEach((score, i) => {
      expect(probabilities[i]).toBeCloseTo(score, 5);
    });

    // reset() is the rest state again, and the rest state is seven frames of
    // silence after a cold start.
    vad.reset();
    expect(frames.map((frame) => vad.score(frame))).toEqual(probabilities);
    const cold = createSileroVad(bytesOf(restedModelPath), { stftBasis });
    for (let i = 0; i < 7; i++) cold.score(new Float32Array(512));
    expect(cold.score(frames[0])).toBe(probabilities[0]);
  });

  it("rejects a model version it has no framing for", () => {
    const bytes = bytesOf(modelPath);
    // The version follows the magic, the name's length and the name "silero-16k".
    new DataView(bytes).setInt32(18, 7, true);
    expect(() => createSileroVad(bytes)).toThrow("Unsupported Silero model version");
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

  it("sends the gate threshold with every frame", () => {
    const gate = createGate();
    gate.report(0.1);
    expect(gate.sentThreshold()).toBe(0.01);
    gate.control({ type: "threshold", threshold: 0.002 });
    gate.report(0.1);
    expect(gate.sentThreshold()).toBe(0.002);
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

  describe("worker", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("hears quiet speech after a second of silence with both real models", async () => {
      const messages: unknown[] = [];
      const scope = {
        onmessage: null as ((event: { data: { port: unknown } }) => void) | null,
        postMessage: (message: unknown) => messages.push(message),
      };
      vi.stubGlobal("self", scope);
      vi.stubGlobal("fetch", (url: URL) =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(bytesOf(fileURLToPath(url))),
        }),
      );
      // @ts-expect-error The packaged worker is a JavaScript module.
      await import("../../public/silero-vad-worker.js");
      const replies: Score[] = [];
      const port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: (reply: Score) => replies.push(reply),
        close() {},
      };
      scope.onmessage?.({ data: { port } });
      await vi.waitFor(() => expect(messages).toEqual([{ type: "ready" }]));

      const speech = quietSpeech();
      const silentFrames = 31;
      const speechFrames = Math.floor(speech.length / 1536);
      for (let frame = 0; frame < silentFrames + speechFrames; frame++) {
        const at = (frame - silentFrames) * 1536;
        const samples = at < 0 ? new Float32Array(1536) : speech.slice(at, at + 1536);
        port.onmessage?.({ data: { frame, samples, peak: 0.01, threshold: 0.01 } });
      }
      expect(messages).toHaveLength(1);
      const scores = replies.map((reply) => reply.probability);
      expect(Math.max(...scores.slice(0, silentFrames))).toBeLessThan(0.1);
      // A score of exactly 1 is the second model's verdict.
      expect(scores.slice(silentFrames).filter((score) => score === 1).length).toBeGreaterThan(20);
    });
  });
});
