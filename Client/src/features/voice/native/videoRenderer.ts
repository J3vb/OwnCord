// Remote video on Linux: one native track's decoded frames, read from the
// session's loopback frame socket (`src-tauri/src/native_voice/video.rs`)
// and drawn with a WebGL2 I420->RGB shader. Frames never cross Tauri IPC,
// whose JSON path cannot carry 720p at a usable rate on WebKitGTK.
//
// The canvas is exposed as a `MediaStreamTrack` (`canvas.captureStream()`),
// so the video grid, stream previews and track lifecycle keep consuming
// MediaStreams exactly as they do for browser LiveKit tracks.
//
// Lifecycle (B7-11): the owner (`NativeRoom`) disposes it when the track is
// unsubscribed or the room disconnects; dispose closes the socket, stops the
// captured track and releases the GL context. The frame server also closes
// every socket when the native session ends.
import { createLogger } from "../../../lib/logger";
import { nativeCounters } from "./counters";

const log = createLogger("nativeVideo");

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// BT.601 limited range, what libwebrtc's software decoders emit.
const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D y, u, v;
out vec4 color;
void main() {
  float Y = 1.1643 * (texture(y, uv).r - 0.0625);
  float U = texture(u, uv).r - 0.5;
  float V = texture(v, uv).r - 0.5;
  color = vec4(Y + 1.5958 * V, Y - 0.39173 * U - 0.8129 * V, Y + 2.017 * U, 1.0);
}`;

export interface I420Frame {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/** Split one frame-socket message: width and height (u32 LE), then the Y, U
 *  and V planes tightly packed. Null when the message is malformed. */
export function parseI420(data: ArrayBuffer): I420Frame | null {
  if (data.byteLength < 8) return null;
  const header = new DataView(data, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const ySize = width * height;
  const cSize = cw * ch;
  if (width === 0 || height === 0 || data.byteLength !== 8 + ySize + 2 * cSize) return null;
  return {
    width,
    height,
    y: new Uint8Array(data, 8, ySize),
    u: new Uint8Array(data, 8 + ySize, cSize),
    v: new Uint8Array(data, 8 + ySize + cSize, cSize),
  };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

/** Program plus three single-channel textures bound to units 0-2. */
function setup(gl: WebGL2RenderingContext): WebGLTexture[] {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  gl.useProgram(program);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return ["y", "u", "v"].map((name, unit) => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    return texture;
  });
}

export class NativeVideoRenderer {
  readonly mediaStreamTrack: MediaStreamTrack;
  private readonly canvas = document.createElement("canvas");
  private readonly gl: WebGL2RenderingContext | null;
  private readonly socket: WebSocket;
  private disposed = false;

  /** `url`: the frame socket's `/remote/<sid>` route for one track. */
  constructor(url: string) {
    this.gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false });
    try {
      if (this.gl === null) throw new Error("WebGL2 unavailable");
      setup(this.gl);
    } catch (err) {
      // The tile stays black; everything else (audio, the call) carries on.
      log.error("native video renderer setup failed", err);
    }
    this.mediaStreamTrack = this.canvas.captureStream().getVideoTracks()[0]!;
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (e: MessageEvent<ArrayBuffer>) => this.draw(e.data));
    nativeCounters.videoRenderers++;
  }

  private draw(data: ArrayBuffer): void {
    const frame = parseI420(data);
    const gl = this.gl;
    if (frame === null || gl === null || this.disposed) return;
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    const cw = Math.ceil(frame.width / 2);
    const ch = Math.ceil(frame.height / 2);
    const planes: Array<[Uint8Array, number, number]> = [
      [frame.y, frame.width, frame.height],
      [frame.u, cw, ch],
      [frame.v, cw, ch],
    ];
    planes.forEach(([plane, w, h], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, plane);
    });
    gl.viewport(0, 0, frame.width, frame.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    nativeCounters.videoRenderers--;
    this.socket.close();
    this.mediaStreamTrack.stop();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
