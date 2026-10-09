import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real logger registers an app-lifetime window listener on every fresh import.
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const SENTINEL = { compiled: true } as unknown as WebAssembly.Module;

interface PostedInit {
  type: string;
  wasmModule?: unknown;
  wasmBytes?: unknown;
}

describe("createRNNoiseNode module cache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let compileMock: ReturnType<typeof vi.fn>;
  let posted: PostedInit[];
  const realCompile = WebAssembly.compile;
  const realFetch = globalThis.fetch;

  function makeContext(): AudioContext {
    return {
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AudioContext;
  }

  beforeEach(() => {
    vi.resetModules();
    posted = [];
    fetchMock = vi.fn(async () => new Response(new ArrayBuffer(8)));
    compileMock = vi.fn(async () => SENTINEL);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    WebAssembly.compile = compileMock as unknown as typeof WebAssembly.compile;
    class FakeAudioWorkletNode {
      readonly port: {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: PostedInit) => void;
      } = {
        onmessage: null,
        postMessage: (message) => {
          if (message.type !== "init") return;
          posted.push(message);
          queueMicrotask(() => this.port.onmessage?.({ data: { type: "ready" } } as MessageEvent));
        },
      };
      disconnect = vi.fn();
    }
    Object.assign(globalThis, { AudioWorkletNode: FakeAudioWorkletNode });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    WebAssembly.compile = realCompile;
    delete (globalThis as Record<string, unknown>).AudioWorkletNode;
  });

  it("fetches and compiles the wasm once across joins and posts the module", async () => {
    const { createRNNoiseNode } = await import("@lib/noise-suppression");
    const first = makeContext();
    const second = makeContext();

    await createRNNoiseNode(first);
    await createRNNoiseNode(second);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(first.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(second.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(2);
    for (const message of posted) {
      expect(message.wasmModule).toBe(SENTINEL);
      expect(message.wasmBytes).toBeUndefined();
    }
  });

  it("does not cache a failed fetch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { createRNNoiseNode } = await import("@lib/noise-suppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("network down");
    await createRNNoiseNode(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
  });
});
