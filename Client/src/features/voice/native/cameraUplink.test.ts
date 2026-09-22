import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { CameraUplink, encodeFrame, uploadHeader } from "./cameraUplink";
import { nativeCounters } from "./counters";

/** A `VideoFrame` with a CPU layout, as WebKitGTK's capture hands one out. */
function fakeFrame(format: string | null, width: number, height: number) {
  const planes =
    format === "I420"
      ? [
          { offset: 0, stride: width },
          { offset: width * height, stride: width / 2 },
          { offset: width * height * 1.25, stride: width / 2 },
        ]
      : [{ offset: 0, stride: width * 4 }];
  const size = format === "I420" ? width * height * 1.5 : width * height * 4;
  return {
    format,
    codedWidth: width,
    codedHeight: height,
    visibleRect: { width, height },
    allocationSize: () => size,
    copyTo: (dest: Uint8Array) => {
      dest.fill(7);
      return Promise.resolve(planes);
    },
  } as unknown as VideoFrame;
}

const header = (buffer: ArrayBuffer) => [...new Uint32Array(buffer, 0, 9)];
/** Settle the pump's copy-and-send chain. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("camera upload messages", () => {
  it("writes format, size and up to three plane layouts", () => {
    expect([
      ...uploadHeader(3, 4, 2, [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 2 },
      ]),
    ]).toEqual([3, 4, 2, 0, 4, 8, 2, 0, 0]);
  });

  it("sends a frame in its own layout when the backend converts it", async () => {
    const rgba = await encodeFrame(fakeFrame("RGBA", 4, 2), () => {
      throw new Error("no fallback expected");
    });
    expect(header(rgba)).toEqual([1, 4, 2, 0, 16, 0, 0, 0, 0]);
    expect(rgba.byteLength).toBe(36 + 32);
    expect(new Uint8Array(rgba, 36).every((b) => b === 7)).toBe(true);

    const bgrx = await encodeFrame(fakeFrame("BGRX", 4, 2), () => new Uint8ClampedArray());
    expect(header(bgrx)[0]).toBe(2);
    const i420 = await encodeFrame(fakeFrame("I420", 4, 2), () => new Uint8ClampedArray());
    expect(header(i420)).toEqual([3, 4, 2, 0, 4, 8, 2, 10, 2]);
  });

  it("falls back to RGBA readback for a frame with no CPU layout", async () => {
    const fallback = vi.fn(() => new Uint8ClampedArray(4 * 2 * 4).fill(9));
    const msg = await encodeFrame(fakeFrame(null, 4, 2), fallback);
    expect(fallback).toHaveBeenCalledWith(4, 2);
    expect(header(msg)).toEqual([1, 4, 2, 0, 16, 0, 0, 0, 0]);
    expect(new Uint8Array(msg, 36).every((b) => b === 9)).toBe(true);
  });
});

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  sent: ArrayBuffer[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

describe("CameraUplink", () => {
  let frameCallback: ((now: number) => void) | null = null;
  const cancelled: number[] = [];
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("MediaStream", function MediaStream() {});
    vi.stubGlobal("VideoFrame", function VideoFrame() {
      return Object.assign(fakeFrame("RGBA", 2, 2), { close: () => {} });
    });
    frameCallback = null;
    cancelled.length = 0;
    nativeCounters.cameraUplinks = 0;
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
    proto.requestVideoFrameCallback = (cb: (now: number) => void) => {
      frameCallback = cb;
      return 42;
    };
    proto.cancelVideoFrameCallback = (id: number) => cancelled.push(id);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends frames no faster than the max framerate, and none while one is buffered", async () => {
    const uplink = new CameraUplink("ws://127.0.0.1:9/tok/camera", {} as MediaStreamTrack, 10);
    const socket = FakeSocket.last;
    expect(socket.url).toBe("ws://127.0.0.1:9/tok/camera");
    expect(nativeCounters.cameraUplinks).toBe(1);
    frameCallback!(1000);
    await flush();
    frameCallback!(1050); // under 100 ms: dropped
    await flush();
    expect(socket.sent).toHaveLength(1);
    socket.bufferedAmount = 10;
    frameCallback!(1200); // socket still busy: dropped
    await flush();
    socket.bufferedAmount = 0;
    frameCallback!(1300);
    await flush();
    expect(socket.sent).toHaveLength(2);
    expect(header(socket.sent[0]!)).toEqual([1, 2, 2, 0, 8, 0, 0, 0, 0]);
    uplink.dispose();
  });

  it("dispose cancels the frame callback and closes the socket once", async () => {
    const uplink = new CameraUplink("ws://x", {} as MediaStreamTrack, 30);
    const socket = FakeSocket.last;
    uplink.dispose();
    uplink.dispose();
    expect(cancelled).toEqual([42]);
    expect(socket.closed).toBe(true);
    expect(nativeCounters.cameraUplinks).toBe(0);
    frameCallback!(5000);
    await flush();
    expect(socket.sent).toHaveLength(0);
  });
});
