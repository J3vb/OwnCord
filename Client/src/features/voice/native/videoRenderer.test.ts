import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { NativeVideoRenderer, parseI420 } from "./videoRenderer";
import { nativeCounters } from "./counters";

/** One frame-socket message, as `video.rs`'s `pack_i420` writes it. */
function message(width: number, height: number, fill = 0): ArrayBuffer {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const buffer = new ArrayBuffer(8 + width * height + 2 * cw * ch);
  const view = new DataView(buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  new Uint8Array(buffer, 8).fill(fill);
  return buffer;
}

describe("parseI420", () => {
  it("splits the planes, rounding odd chroma sizes up", () => {
    const frame = parseI420(message(5, 3))!;
    expect([frame.width, frame.height]).toEqual([5, 3]);
    expect([frame.y.length, frame.u.length, frame.v.length]).toEqual([15, 6, 6]);
    expect(frame.v.byteOffset).toBe(8 + 15 + 6);
  });

  it("rejects short, empty and mis-sized messages", () => {
    expect(parseI420(new ArrayBuffer(4))).toBeNull();
    expect(parseI420(message(0, 2))).toBeNull();
    expect(parseI420(message(4, 2).slice(0, 12))).toBeNull();
    const extra = new Uint8Array(message(2, 2).byteLength + 1);
    extra.set(new Uint8Array(message(2, 2)));
    expect(parseI420(extra.buffer)).toBeNull();
  });
});

class FakeSocket {
  static last: FakeSocket;
  binaryType = "";
  deliver: ((e: { data: ArrayBuffer }) => void) | null = null;
  addEventListener(_type: "message", handler: (e: { data: ArrayBuffer }) => void) {
    this.deliver = handler;
  }
  closed = false;
  sent: ArrayBuffer[] = [];
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
}

describe("NativeVideoRenderer", () => {
  const stop = vi.fn();
  const gl = {
    uploads: [] as Array<[number, number]>,
    draws: 0,
    lost: 0,
  };
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    gl.uploads.length = 0;
    gl.draws = 0;
    gl.lost = 0;
    nativeCounters.videoRenderers = 0;
    const context = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      TEXTURE0: 100,
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      createProgram: () => ({}),
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      useProgram: () => {},
      pixelStorei: () => {},
      createTexture: () => ({}),
      activeTexture: () => {},
      bindTexture: () => {},
      texParameteri: () => {},
      getUniformLocation: () => ({}),
      uniform1i: () => {},
      texImage2D: (...args: unknown[]) => gl.uploads.push([args[3] as number, args[4] as number]),
      viewport: () => {},
      drawArrays: () => gl.draws++,
      getExtension: () => ({ loseContext: () => gl.lost++ }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as RenderingContext,
    );
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop }] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draws each frame from its socket as three planes and resizes to it", () => {
    const renderer = new NativeVideoRenderer("ws://127.0.0.1:9/tok/remote/TR_v");
    expect(FakeSocket.last.url).toBe("ws://127.0.0.1:9/tok/remote/TR_v");
    expect(FakeSocket.last.binaryType).toBe("arraybuffer");
    expect(nativeCounters.videoRenderers).toBe(1);
    FakeSocket.last.deliver!({ data: message(640, 360) });
    FakeSocket.last.deliver!({ data: new ArrayBuffer(3) });
    expect(gl.uploads).toEqual([
      [640, 360],
      [320, 180],
      [320, 180],
    ]);
    expect(gl.draws).toBe(1);
    renderer.dispose();
  });

  it("acknowledges each message once handled so the socket sends the next frame", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    const socket = FakeSocket.last;
    expect(socket.sent).toHaveLength(0);
    socket.deliver!({ data: message(4, 2) });
    expect(gl.draws).toBe(1);
    expect(socket.sent.map((d) => d.byteLength)).toEqual([0]);
    // A malformed frame is skipped but still acknowledged, or video stalls.
    socket.deliver!({ data: new ArrayBuffer(3) });
    expect(socket.sent).toHaveLength(2);
    renderer.dispose();
    socket.deliver!({ data: message(4, 2) });
    expect(socket.sent).toHaveLength(2);
  });

  it("dispose closes the socket, stops the track and releases the context once", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    const socket = FakeSocket.last;
    renderer.dispose();
    renderer.dispose();
    expect(socket.closed).toBe(true);
    // A frame already in flight is ignored once disposed.
    socket.deliver!({ data: message(2, 2) });
    expect(gl.draws).toBe(0);
    expect(stop).toHaveBeenCalled();
    expect(gl.lost).toBe(1);
    expect(nativeCounters.videoRenderers).toBe(0);
  });
});
