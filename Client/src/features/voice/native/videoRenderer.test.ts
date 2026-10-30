import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError }),
}));

import { NativeVideoRenderer, parseI420 } from "./videoRenderer";
import { nativeCounters } from "./counters";
import { syncVideoSurface, videoSurfaceOf } from "../../../lib/voice/videoSurface";

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
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = "";
  deliver: ((e: { data: ArrayBuffer }) => void) | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, handler: (e: { data: ArrayBuffer }) => void) {
    if (type === "message") this.deliver = handler;
    else (this.listeners[type] ??= []).push(handler as () => void);
  }
  emitClose() {
    this.closed = true;
    for (const cb of this.listeners["close"] ?? []) cb();
  }
  closed = false;
  sent: ArrayBuffer[] = [];
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const texCalls = (unit: number): unknown[][] => [
  ["activeTexture", 100 + unit],
  ["bindTexture", 6],
  ["texParameteri", 6, 7, 11],
  ["texParameteri", 6, 8, 11],
  ["texParameteri", 6, 9, 12],
  ["texParameteri", 6, 10, 12],
];

describe("NativeVideoRenderer", () => {
  const stop = vi.fn();
  /** The frame rate each `captureStream` call asked for. */
  const captures: Array<number | undefined> = [];
  const gl = {
    uploads: [] as Array<[number, number]>,
    draws: 0,
    lost: 0,
    programs: 0,
    /** Every GL call that sets state, in order, as [name, ...args]. */
    log: [] as unknown[][],
    compileOk: true,
    linkOk: true,
    shaderInfo: null as string | null,
    programInfo: null as string | null,
  };
  const note =
    <R>(name: string, ret?: R) =>
    (...args: unknown[]): R | undefined => {
      gl.log.push([name, ...args]);
      return ret;
    };
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.instances = [];
    gl.uploads.length = 0;
    gl.draws = 0;
    gl.lost = 0;
    gl.programs = 0;
    gl.log.length = 0;
    gl.compileOk = true;
    gl.linkOk = true;
    gl.shaderInfo = null;
    gl.programInfo = null;
    logError.mockClear();
    nativeCounters.videoRenderers = 0;
    const context = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      UNPACK_ALIGNMENT: 5,
      TEXTURE_2D: 6,
      TEXTURE_MIN_FILTER: 7,
      TEXTURE_MAG_FILTER: 8,
      TEXTURE_WRAP_S: 9,
      TEXTURE_WRAP_T: 10,
      LINEAR: 11,
      CLAMP_TO_EDGE: 12,
      TEXTURE0: 100,
      createShader: (type: number) => ({ type }),
      shaderSource: (shader: unknown, source: string) =>
        gl.log.push(["shaderSource", shader, source]),
      compileShader: note("compileShader"),
      getShaderParameter: (_s: unknown, what: number) => (what === 3 ? gl.compileOk : undefined),
      getShaderInfoLog: () => gl.shaderInfo,
      createProgram: () => (gl.programs++, { program: gl.programs }),
      attachShader: (_p: unknown, shader: { type: number }) =>
        gl.log.push(["attachShader", shader.type]),
      linkProgram: note("linkProgram"),
      getProgramParameter: (_p: unknown, what: number) => (what === 4 ? gl.linkOk : undefined),
      getProgramInfoLog: () => gl.programInfo,
      useProgram: note("useProgram"),
      pixelStorei: note("pixelStorei"),
      createTexture: () => ({}),
      activeTexture: note("activeTexture"),
      bindTexture: (target: number) => gl.log.push(["bindTexture", target]),
      texParameteri: note("texParameteri"),
      getUniformLocation: (_p: unknown, name: string) => ({ name }),
      uniform1i: (loc: { name: string }, unit: number) =>
        gl.log.push(["uniform1i", loc.name, unit]),
      texImage2D: (...args: unknown[]) => gl.uploads.push([args[3] as number, args[4] as number]),
      viewport: note("viewport"),
      drawArrays: (...args: unknown[]) => (gl.log.push(["drawArrays", ...args]), gl.draws++),
      getExtension: (name: string) =>
        name === "WEBGL_lose_context" ? { loseContext: () => gl.lost++ } : null,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as RenderingContext,
    );
    captures.length = 0;
    (
      HTMLCanvasElement.prototype as unknown as { captureStream: (fps?: number) => unknown }
    ).captureStream = (fps?: number) => {
      captures.push(fps);
      return { getVideoTracks: () => [{ stop }] };
    };
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

  it("is the picture of its track, which captures no frames", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    // WebKitGTK's canvas capture freezes after the first frames on some GPU
    // stacks: the tile shows the canvas instead of anything captured.
    expect(captures).toEqual([0]);
    const tile = document.createElement("div");
    const video = document.createElement("video");
    video.srcObject = {
      getVideoTracks: () => [renderer.mediaStreamTrack],
    } as unknown as MediaStream;
    tile.appendChild(video);
    expect(videoSurfaceOf(video)).toBe(renderer.canvas);
    syncVideoSurface(video);
    expect(video.nextSibling).toBe(renderer.canvas);
    expect(renderer.canvas.className).toBe("video-surface");
    // Disposed, the canvas leaves the tile with it.
    renderer.dispose();
    expect(renderer.canvas.parentNode).toBeNull();
  });

  it("has no size before its first frame, and sets up again after a lost context", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    expect([renderer.canvas.width, renderer.canvas.height]).toEqual([0, 0]);
    expect(gl.programs).toBe(1);
    const lost = new Event("webglcontextlost", { cancelable: true });
    renderer.canvas.dispatchEvent(lost);
    // Without preventDefault WebKit never restores the context.
    expect(lost.defaultPrevented).toBe(true);
    renderer.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(gl.programs).toBe(2);
    FakeSocket.last.deliver!({ data: message(4, 2) });
    expect(gl.draws).toBe(1);
    renderer.dispose();
  });

  it("reopens the loopback socket after the host closes it (voice #13)", () => {
    vi.useFakeTimers();
    try {
      const renderer = new NativeVideoRenderer("ws://x/remote/sid");
      const first = FakeSocket.last;
      first.emitClose();
      vi.advanceTimersByTime(999);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(FakeSocket.last).not.toBe(first);
      // The new socket draws again.
      FakeSocket.last.deliver!({ data: message(4, 2) });
      expect(gl.draws).toBe(1);
      renderer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a host close to its owner instead of reopening, until disposed", () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      const renderer = new NativeVideoRenderer("ws://x/camera", onClosed);
      FakeSocket.last.emitClose();
      expect(onClosed).toHaveBeenCalledTimes(1);
      renderer.dispose();
      FakeSocket.last.emitClose();
      vi.advanceTimersByTime(1100);
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets the context up with its program, shaders and three bound textures", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
    });
    const sources = gl.log.filter((c) => c[0] === "shaderSource");
    expect(sources.map((c) => (c[1] as { type: number }).type)).toEqual([1, 2]);
    expect(sources[0]![2]).toContain("gl_VertexID");
    expect(sources[1]![2]).toContain("texture(y, uv)");
    expect(gl.log.filter((c) => c[0] !== "shaderSource")).toEqual([
      ["compileShader", { type: 1 }],
      ["attachShader", 1],
      ["compileShader", { type: 2 }],
      ["attachShader", 2],
      ["linkProgram", { program: 1 }],
      ["useProgram", { program: 1 }],
      ["pixelStorei", 5, 1],
      ...texCalls(0),
      ["uniform1i", "y", 0],
      ...texCalls(1),
      ["uniform1i", "u", 1],
      ...texCalls(2),
      ["uniform1i", "v", 2],
    ]);
    expect(logError).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("draws into texture units 0 to 2 over the whole frame", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    gl.log.length = 0;
    FakeSocket.last.deliver!({ data: message(6, 4) });
    expect(gl.log).toEqual([
      ["activeTexture", 100],
      ["activeTexture", 101],
      ["activeTexture", 102],
      ["viewport", 0, 0, 6, 4],
      ["drawArrays", undefined, 0, 4],
    ]);
    renderer.dispose();
  });

  it("resizes the canvas when either side of the frame changes, and only then", () => {
    const widthSet = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
    const heightSet = vi.spyOn(HTMLCanvasElement.prototype, "height", "set");
    const renderer = new NativeVideoRenderer("ws://x");
    const size = () => [renderer.canvas.width, renderer.canvas.height];
    const socket = FakeSocket.last;
    socket.deliver!({ data: message(4, 2) });
    expect(size()).toEqual([4, 2]);
    // A new width alone, then a new height alone.
    socket.deliver!({ data: message(6, 2) });
    expect(size()).toEqual([6, 2]);
    socket.deliver!({ data: message(6, 4) });
    expect(size()).toEqual([6, 4]);
    // The same size again leaves the canvas (and its picture) alone.
    widthSet.mockClear();
    heightSet.mockClear();
    socket.deliver!({ data: message(6, 4) });
    expect(widthSet).not.toHaveBeenCalled();
    expect(heightSet).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("rejects a message whose height is zero", () => {
    expect(parseI420(message(4, 0))).toBeNull();
  });

  it("does not acknowledge a frame that arrives after the socket left the open state", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    const socket = FakeSocket.last;
    socket.readyState = 3;
    socket.deliver!({ data: message(4, 2) });
    expect(gl.draws).toBe(1);
    expect(socket.sent).toHaveLength(0);
    renderer.dispose();
  });

  it("releases the context through the lose-context extension", () => {
    const renderer = new NativeVideoRenderer("ws://x");
    renderer.dispose();
    expect(gl.lost).toBe(1);
  });

  it.each([
    ["the shader's own log", "bad shader", "bad shader", "shader"],
    ["a generic text when it has no log", null, "shader compile failed", "shader"],
    ["the program's own log", "bad link", "bad link", "program"],
    ["a generic text when it has no log", null, "program link failed", "program"],
  ])("keeps the call going and logs %s when setup fails", (_name, info, text, stage) => {
    if (stage === "shader") {
      gl.compileOk = false;
      gl.shaderInfo = info;
    } else {
      gl.linkOk = false;
      gl.programInfo = info;
    }
    const renderer = new NativeVideoRenderer("ws://x");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toBe("native video renderer setup failed");
    expect((logError.mock.calls[0]![1] as Error).message).toBe(text);
    // The socket is open and a frame is received without throwing.
    expect(() => FakeSocket.last.deliver!({ data: message(4, 2) })).not.toThrow();
    renderer.dispose();
  });

  it("logs that WebGL2 is unavailable and leaves the tile black", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const renderer = new NativeVideoRenderer("ws://x");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toBe("native video renderer setup failed");
    expect((logError.mock.calls[0]![1] as Error).message).toBe("WebGL2 unavailable");
    FakeSocket.last.deliver!({ data: message(4, 2) });
    expect(gl.draws).toBe(0);
    expect(FakeSocket.last.sent).toHaveLength(1);
    renderer.dispose();
  });

  describe("reconnecting", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reopens once a second after the host closes it, however many closes arrive", () => {
      const renderer = new NativeVideoRenderer("ws://x/remote/sid");
      const first = FakeSocket.last;
      first.emitClose();
      first.emitClose();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(999);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      // The reopened socket can drop and be reopened in turn.
      FakeSocket.last.emitClose();
      vi.advanceTimersByTime(1000);
      expect(FakeSocket.instances).toHaveLength(3);
      renderer.dispose();
    });

    it("schedules nothing for a socket that closes after dispose", () => {
      const renderer = new NativeVideoRenderer("ws://x/remote/sid");
      const socket = FakeSocket.last;
      renderer.dispose();
      socket.emitClose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it("cancels a reopen that is waiting when it is disposed", () => {
      const renderer = new NativeVideoRenderer("ws://x/remote/sid");
      FakeSocket.last.emitClose();
      expect(vi.getTimerCount()).toBe(1);
      renderer.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(FakeSocket.instances).toHaveLength(1);
    });
  });
});
