// Enhanced Noise Suppression has to remove a mouse click, the way Discord's
// Krisp does. This drives the real public/rnnoise-worklet.js with the shipped
// public/rnnoise.wasm over a recorded click and a speech clip, in the
// 128-sample render quanta the audio thread delivers.
//
// The shipped WASM used to be @jitsi/rnnoise-wasm's dist/rnnoise.wasm, which
// is RNNoise's 2018 model: over ordinary room noise it took nothing off the
// click. The same package's sync build embeds the current model, which takes
// off 28 dB or more.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { FIXTURE_SAMPLE_RATE, placeInRoomTone, readAudioFixture, rms, toDb } from "../helpers/wav";

type Processor = {
  port: { postMessage: ReturnType<typeof vi.fn> };
  _initWasm(bytes: ArrayBuffer): Promise<void>;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

describe("RNNoise worklet on recorded audio", () => {
  let processorCtor: (new () => Processor) | null = null;

  beforeEach(() => {
    vi.resetModules();
    class FakeAudioWorkletProcessor {
      readonly port = { onmessage: null, postMessage: vi.fn() };
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

  async function denoise(input: Float32Array): Promise<Float32Array> {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/rnnoise-worklet.js");
    const processor = new processorCtor!();
    const wasm = readFileSync("public/rnnoise.wasm");
    await processor._initWasm(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length));
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "ready" });
    const output = new Float32Array(input.length);
    for (let at = 0; at + 128 <= input.length; at += 128) {
      const quantum = new Float32Array(128);
      processor.process([[input.subarray(at, at + 128)]], [[quantum]]);
      output.set(quantum, at);
    }
    return output;
  }

  // RNNoise works on 10 ms frames, so how much of a click survives depends on
  // where in a frame it lands; each offset has to clear the bar.
  it.each([0, 3, 7])(
    "takes over 25 dB off a mouse click landing %i ms into a frame",
    async (ms) => {
      const at = 1 + ms / 1000;
      const input = placeInRoomTone(readAudioFixture("mouse-click.wav"), at, 2);

      const output = await denoise(input);

      // 80 ms from the click: its 60 ms plus the worklet's buffering delay.
      const window = (samples: Float32Array) =>
        samples.subarray(at * FIXTURE_SAMPLE_RATE, (at + 0.08) * FIXTURE_SAMPLE_RATE);
      expect(toDb(rms(window(input))) - toDb(rms(window(output)))).toBeGreaterThan(25);
    },
  );

  it("keeps speech within 3 dB of its level", async () => {
    const input = placeInRoomTone(readAudioFixture("speech.wav"), 0.5, 2);

    const output = await denoise(input);

    expect(Math.abs(toDb(rms(output)) - toDb(rms(input)))).toBeLessThan(3);
  });

  it("ships the WASM that @jitsi/rnnoise-wasm's sync build embeds", () => {
    // public/rnnoise.wasm is vendored; this is where it comes from. To
    // refresh it after a package bump, write these decoded bytes to it and
    // update EXPORT_NAMES in public/rnnoise-worklet.js from the glue.
    const glue = readFileSync(
      createRequire(import.meta.url).resolve("@jitsi/rnnoise-wasm/dist/rnnoise-sync.js"),
      "utf8",
    );
    const embedded = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/.exec(glue)?.[1];

    expect(embedded).toBeDefined();
    expect(readFileSync("public/rnnoise.wasm").equals(Buffer.from(embedded!, "base64"))).toBe(true);
  });
});
