import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real logger registers an app-lifetime window listener on every fresh import.
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const WASM_LENGTH = 8;

interface PostedInit {
  message: { type: string; wasmBytes?: ArrayBuffer };
  transfer: unknown[] | undefined;
}

describe("createRNNoiseNode bytes cache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: PostedInit[];
  const realFetch = globalThis.fetch;

  function makeContext(): AudioContext {
    return {
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AudioContext;
  }

  beforeEach(() => {
    vi.resetModules();
    posted = [];
    fetchMock = vi.fn(async () => new Response(new Uint8Array(WASM_LENGTH).buffer));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    class FakeAudioWorkletNode {
      readonly port: {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: PostedInit["message"], transfer?: unknown[]) => void;
      } = {
        onmessage: null,
        postMessage: (message, transfer) => {
          if (message.type !== "init") return;
          posted.push({ message, transfer });
          queueMicrotask(() => this.port.onmessage?.({ data: { type: "ready" } } as MessageEvent));
        },
      };
      disconnect = vi.fn();
    }
    Object.assign(globalThis, { AudioWorkletNode: FakeAudioWorkletNode });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as Record<string, unknown>).AudioWorkletNode;
  });

  it("fetches the wasm once across joins and gives each node its own transferred copy", async () => {
    const { createRNNoiseNode } = await import("@lib/noise-suppression");
    const first = makeContext();
    const second = makeContext();

    await createRNNoiseNode(first);
    await createRNNoiseNode(second);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(second.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(2);
    const [one, two] = posted.map((entry) => entry.message.wasmBytes);
    expect(one).toBeInstanceOf(ArrayBuffer);
    expect(two).toBeInstanceOf(ArrayBuffer);
    expect(one!.byteLength).toBe(WASM_LENGTH);
    expect(two!.byteLength).toBe(WASM_LENGTH);
    expect(one).not.toBe(two);
    expect(posted[0]!.transfer).toEqual([one]);
    expect(posted[1]!.transfer).toEqual([two]);
  });

  it("does not cache a non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    const { createRNNoiseNode } = await import("@lib/noise-suppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("503");
    await createRNNoiseNode(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.wasmBytes!.byteLength).toBe(WASM_LENGTH);
  });

  it("does not cache a failed fetch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { createRNNoiseNode } = await import("@lib/noise-suppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("network down");
    await createRNNoiseNode(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(1);
  });
});
