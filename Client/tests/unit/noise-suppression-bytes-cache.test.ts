import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real logger registers an app-lifetime window listener on every fresh import.
const loggers = vi.hoisted(() => ({
  names: [] as string[],
  info: vi.fn(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: (name: string) => {
    loggers.names.push(name);
    return { debug: vi.fn(), info: loggers.info, warn: vi.fn(), error: vi.fn() };
  },
}));

const WASM_LENGTH = 8;

interface PostedInit {
  message: { type: string; wasmBytes?: ArrayBuffer };
  transfer: unknown[] | undefined;
}

describe("createRNNoiseNode bytes cache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: PostedInit[];
  let workletReplies: Array<{ type: string; message?: string }>;
  const realFetch = globalThis.fetch;

  function makeContext(): AudioContext {
    return {
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AudioContext;
  }

  beforeEach(() => {
    vi.resetModules();
    posted = [];
    workletReplies = [];
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
          const reply = workletReplies.shift() ?? { type: "ready" };
          queueMicrotask(() => this.port.onmessage?.({ data: reply } as MessageEvent));
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
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");
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
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("503");
    await createRNNoiseNode(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.wasmBytes!.byteLength).toBe(WASM_LENGTH);
  });

  it("does not cache a failed fetch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("network down");
    await createRNNoiseNode(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(1);
  });

  it("drops the cached bytes when the worklet rejects them, so the next join refetches", async () => {
    workletReplies.push({ type: "error", message: "compile failed" });
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("compile failed");
    await createRNNoiseNode(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

type WorkletReply = { type: string; message?: string };

describe("createRNNoiseNode worklet wiring", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let constructed: Array<{ context: unknown; name: string; options: unknown }>;
  let ports: FakePort[];
  /** Replies the next created node sends back, in order, for its init message. */
  let scripted: WorkletReply[][];
  /** When true, init replies are held until `release` is called. */
  let hold: boolean;

  interface FakePort {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    pending: WorkletReply[];
    release(): void;
  }

  function makeContext(): AudioContext & { addModule: ReturnType<typeof vi.fn> } {
    const addModule = vi.fn().mockResolvedValue(undefined);
    return { audioWorklet: { addModule }, addModule } as unknown as AudioContext & {
      addModule: ReturnType<typeof vi.fn>;
    };
  }

  beforeEach(() => {
    vi.resetModules();
    loggers.names.length = 0;
    loggers.info.mockClear();
    constructed = [];
    ports = [];
    scripted = [];
    hold = false;
    fetchMock = vi.fn(async () => new Response(new Uint8Array(WASM_LENGTH).buffer));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    class FakeAudioWorkletNode {
      readonly port: FakePort;
      disconnect = vi.fn();
      constructor(context: unknown, name: string, options: unknown) {
        constructed.push({ context, name, options });
        const port: FakePort = {
          onmessage: null,
          pending: [],
          postMessage: vi.fn((message: { type: string }) => {
            if (message.type !== "init") return;
            port.pending = scripted.shift() ?? [{ type: "ready" }];
            if (!hold) port.release();
          }),
          release: () => {
            const replies = port.pending;
            port.pending = [];
            queueMicrotask(() => {
              for (const data of replies) port.onmessage?.({ data } as MessageEvent);
            });
          },
        };
        this.port = port;
        ports.push(port);
      }
    }
    Object.assign(globalThis, { AudioWorkletNode: FakeAudioWorkletNode });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as Record<string, unknown>).AudioWorkletNode;
  });

  it("loads the worklet module and the wasm from the public asset paths", async () => {
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");
    const context = makeContext();

    await createRNNoiseNode(context);

    expect(context.addModule).toHaveBeenCalledWith("/rnnoise-worklet.js");
    expect(fetchMock).toHaveBeenCalledWith("/rnnoise.wasm");
  });

  it("builds a mono-in, audio-and-speech-out rnnoise-processor node on the given context", async () => {
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");
    const context = makeContext();

    await createRNNoiseNode(context);

    expect(constructed).toEqual([
      {
        context,
        name: "rnnoise-processor",
        options: { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [1, 1] },
      },
    ]);
  });

  it("ignores worklet messages that are neither ready nor error", async () => {
    scripted.push([{ type: "progress" }, { type: "ready" }]);
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    await expect(createRNNoiseNode(makeContext())).resolves.toHaveProperty("node");
  });

  it("rejects with the worklet's error message", async () => {
    scripted.push([{ type: "error", message: "bad wasm" }]);
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    await expect(createRNNoiseNode(makeContext())).rejects.toThrow("bad wasm");
  });

  it("logs when it becomes active and when it is destroyed", async () => {
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    const rn = await createRNNoiseNode(makeContext());
    expect(loggers.names).toContain("noise-suppression");
    expect(loggers.info).toHaveBeenCalledWith("RNNoise AudioWorklet processing active");

    rn.destroy();
    expect(loggers.info).toHaveBeenCalledWith("RNNoise AudioWorklet node destroyed");
  });

  it("tells the worklet to destroy and disconnects the node on destroy", async () => {
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    const rn = await createRNNoiseNode(makeContext());
    rn.destroy();

    expect(ports[0]!.postMessage).toHaveBeenLastCalledWith({ type: "destroy" });
    expect(
      (rn.node as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps good bytes cached when an earlier join's worklet rejects after a refetch", async () => {
    hold = true;
    // Consumed in post order: first join fails, second fails late, third succeeds.
    scripted.push(
      [{ type: "error", message: "first" }],
      [{ type: "error", message: "late" }],
      [{ type: "ready" }],
    );
    const { createRNNoiseNode } = await import("@lib/voice/noiseSuppression");

    // Two joins share one fetch; both are waiting on their worklet.
    const first = createRNNoiseNode(makeContext());
    const second = createRNNoiseNode(makeContext());
    await vi.waitFor(() => expect(ports).toHaveLength(2));

    ports[0]!.release();
    await expect(first).rejects.toThrow("first");

    // The first failure dropped the bytes, so this join refetches and succeeds.
    const third = createRNNoiseNode(makeContext());
    await vi.waitFor(() => expect(ports).toHaveLength(3));
    ports[2]!.release();
    await third;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The late failure of the second join must not discard the newer bytes.
    ports[1]!.release();
    await expect(second).rejects.toThrow("late");
    hold = false;
    await createRNNoiseNode(makeContext());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
