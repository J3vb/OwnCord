// src/lib/voice/appAudioTrack.ts: the host's loopback socket -> worklet -> track,
// with the WebSocket and the Web Audio graph mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeSocket {
  url: string;
  binaryType: string;
  close: ReturnType<typeof vi.fn>;
  emit(type: string, init?: unknown): void;
}
let sockets: FakeSocket[];
let ctx: {
  audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  createMediaStreamDestination: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  options: unknown;
};
let port: { postMessage: ReturnType<typeof vi.fn> };
let node: {
  port: typeof port;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  args: unknown[];
};
let outTrack: { stop: ReturnType<typeof vi.fn> };
let destination: {
  channelCount: number;
  stream: { getTracks(): unknown[]; getAudioTracks(): unknown[] };
};

beforeEach(() => {
  sockets = [];
  outTrack = { stop: vi.fn() };
  destination = {
    channelCount: 0,
    stream: { getTracks: () => [outTrack], getAudioTracks: () => [outTrack] },
  };
  port = { postMessage: vi.fn() };
  node = { port, connect: vi.fn(), disconnect: vi.fn(), args: [] };
  ctx = {
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamDestination: vi.fn(() => destination),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    options: undefined,
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor(options: unknown) {
        ctx.options = options;
        return ctx;
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      constructor(...args: unknown[]) {
        node.args = args;
        return node;
      }
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      binaryType = "";
      close = vi.fn();
      private listeners = new Map<string, Set<(e: unknown) => void>>();
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener(type: string, cb: (e: unknown) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
      }
      removeEventListener(type: string, cb: (e: unknown) => void) {
        this.listeners.get(type)?.delete(cb);
      }
      emit(type: string, init: unknown = {}) {
        for (const cb of [...(this.listeners.get(type) ?? [])]) cb(init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { openAppAudio } = await import("../../src/lib/voice/appAudioTrack");

/** Open and complete the socket handshake. */
async function open(url = "ws://127.0.0.1:7/t/app-audio") {
  const opening = openAppAudio(url);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.emit("open");
  return opening;
}

describe("openAppAudio", () => {
  it("builds a 48 kHz stereo graph from the worklet and returns the destination track", async () => {
    const handle = await open();

    expect(ctx.options).toEqual({ sampleRate: 48000 });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith("/app-audio-worklet.js");
    expect(node.args[0]).toBe(ctx);
    expect(node.args[1]).toBe("app-audio-processor");
    expect(node.args[2]).toMatchObject({ numberOfInputs: 0, outputChannelCount: [2] });
    expect(destination.channelCount).toBe(2);
    expect(node.connect).toHaveBeenCalledWith(destination);
    expect(sockets[0]!.url).toBe("ws://127.0.0.1:7/t/app-audio");
    expect(sockets[0]!.binaryType).toBe("arraybuffer");
    expect(ctx.resume).toHaveBeenCalled();
    expect(handle.track).toBe(outTrack);
  });

  it("forwards each 3,840-byte frame to the worklet, transferred, and drops other sizes", async () => {
    await open();
    const frame = new ArrayBuffer(3840);
    sockets[0]!.emit("message", { data: frame });
    sockets[0]!.emit("message", { data: new ArrayBuffer(3839) });
    sockets[0]!.emit("message", { data: "text" });

    expect(port.postMessage).toHaveBeenCalledTimes(1);
    const [sent, transfer] = port.postMessage.mock.calls[0]!;
    expect(sent).toBeInstanceOf(Float32Array);
    expect((sent as Float32Array).length).toBe(960);
    expect(transfer).toEqual([frame]);
  });

  it("closes the socket, graph, context and track, and is idempotent", async () => {
    const handle = await open();

    handle.close();
    handle.close();

    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(outTrack.stop).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    sockets[0]!.emit("message", { data: new ArrayBuffer(3840) });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("rejects and releases everything when the socket fails to open", async () => {
    const opening = openAppAudio("ws://127.0.0.1:7/t/app-audio");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.emit("error");

    await expect(opening).rejects.toThrow();
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
    expect(outTrack.stop).toHaveBeenCalled();
  });

  it("rejects when the socket never opens", async () => {
    vi.useFakeTimers();
    const opening = openAppAudio("ws://127.0.0.1:7/t/app-audio");
    const assertion = expect(opening).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(3100);

    await assertion;
    expect(ctx.close).toHaveBeenCalled();
  });

  it("rejects and closes the context when the worklet cannot load", async () => {
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error("blocked"));

    await expect(openAppAudio("ws://127.0.0.1:7/t/app-audio")).rejects.toThrow("blocked");
    expect(sockets).toHaveLength(0);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("does not wait for a resume that never settles", async () => {
    vi.useFakeTimers();
    ctx.resume.mockReturnValueOnce(new Promise(() => {}));
    const opening = openAppAudio("ws://127.0.0.1:7/t/app-audio");
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit("open");
    await vi.advanceTimersByTimeAsync(600);

    expect((await opening).track).toBe(outTrack);
  });

  it("still opens when the context cannot resume", async () => {
    ctx.resume.mockRejectedValueOnce(new Error("autoplay"));
    const handle = await open();
    expect(handle.track).toBe(outTrack);
  });
});
