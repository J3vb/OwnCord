import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REGISTERED_NAME = "rnnoise-processor";

describe("rnnoise-worklet", () => {
  let registerProcessorMock: ReturnType<typeof vi.fn>;
  let processorCtor:
    | (new () => {
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
        _process: ReturnType<typeof vi.fn> | null;
      })
    | null;

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
    processor._process = vi.fn();
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

    expect(processor._process).toHaveBeenCalledTimes(1);
    expect(processor._outReadPos).toBe(4);
    expect(processor._outSampleOffset).toBe(0);
  });

  it("initializes the shipped minified RNNoise WASM", async () => {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/rnnoise-worklet.js");
    const { readFileSync } = await import("node:fs");
    const wasmBytes = readFileSync("public/rnnoise.wasm");

    expect(processorCtor).not.toBeNull();
    const processor = new processorCtor!() as unknown as {
      _initWasm(bytes: ArrayBuffer): Promise<void>;
      _ready: boolean;
      _process: unknown;
    };
    const port = (processor as unknown as { port: { postMessage: ReturnType<typeof vi.fn> } }).port;

    await processor._initWasm(wasmBytes.buffer.slice(0) as ArrayBuffer);

    // The shipped artifact exports minified Emscripten names; a ready
    // processor proves the export map resolved rnnoise_* / malloc / free.
    expect(port.postMessage).toHaveBeenCalledWith({ type: "ready" });
    expect(processor._ready).toBe(true);
    expect(typeof processor._process).toBe("function");
  });

  it("reports the missing exports when the WASM is not the shipped RNNoise build", async () => {
    // @ts-expect-error — worklet script has no module exports
    await import("../../public/rnnoise-worklet.js");

    expect(processorCtor).not.toBeNull();
    const processor = new processorCtor!() as unknown as {
      _initWasm(bytes: ArrayBuffer): Promise<void>;
      _ready: boolean;
    };
    const port = (processor as unknown as { port: { postMessage: ReturnType<typeof vi.fn> } }).port;
    const emptyModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await processor._initWasm(emptyModule.buffer);

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: expect.stringContaining(
        "WASM module missing required RNNoise exports: memory (c), __wasm_call_ctors (d), rnnoise_create (f)",
      ),
    });
    expect(processor._ready).toBe(false);
  });
});
