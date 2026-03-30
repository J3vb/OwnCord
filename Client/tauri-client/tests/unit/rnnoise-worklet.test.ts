import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REGISTERED_NAME = "rnnoise-processor";

describe("rnnoise-worklet", () => {
  let registerProcessorMock: ReturnType<typeof vi.fn>;
  let processorCtor: (new () => {
    _processFrame(): void;
    _outAvailable: number;
    _outReadPos: number;
    _outWritePos: number;
    _outSampleOffset: number;
    _inputPtr: number;
    _outputPtr: number;
    _state: number;
    _inputRing: Float32Array;
    _outBuffer: Float32Array;
    _heapF32: Float32Array | null;
    _instance: { exports: { rnnoise_process_frame: ReturnType<typeof vi.fn> } } | null;
  }) | null;

  beforeEach(() => {
    vi.resetModules();
    processorCtor = null;
    registerProcessorMock = vi.fn((name: string, ctor: unknown) => {
      if (name === REGISTERED_NAME) {
        processorCtor = ctor as typeof processorCtor;
      }
    });
    class FakeAudioWorkletProcessor {
      readonly port = {
        onmessage: null,
        postMessage: vi.fn(),
      };
    }
    Object.assign(globalThis, {
      registerProcessor: registerProcessorMock,
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).registerProcessor;
    delete (globalThis as Record<string, unknown>).AudioWorkletProcessor;
  });

  it("registers the RNNoise processor once", async () => {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/rnnoise-worklet.js");

    expect(registerProcessorMock).toHaveBeenCalledTimes(1);
    expect(registerProcessorMock).toHaveBeenCalledWith(REGISTERED_NAME, expect.any(Function));
  });

  it("resets the output sample offset when overwriting the oldest buffered frame", async () => {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/rnnoise-worklet.js");

    expect(processorCtor).not.toBeNull();
    const processor = new processorCtor!();
    processor._instance = {
      exports: {
        rnnoise_process_frame: vi.fn(),
      },
    };
    processor._heapF32 = new Float32Array(960);
    processor._state = 1;
    processor._inputPtr = 0;
    processor._outputPtr = 480 * 4;
    processor._inputRing.fill(0.5);
    processor._outAvailable = 50;
    processor._outReadPos = 3;
    processor._outWritePos = 4;
    processor._outSampleOffset = 123;

    processor._processFrame();

    expect(processor._outReadPos).toBe(4);
    expect(processor._outSampleOffset).toBe(0);
  });
});