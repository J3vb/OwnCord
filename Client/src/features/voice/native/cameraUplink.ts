// The local camera on Linux: the webview captures it (`getUserMedia` works
// in WebKitGTK; only WebRTC is missing), so device choice, permissions and
// the self-view preview are the same `LocalVideoTrack` the web path uses.
// This pump copies each captured frame up the session's loopback frame
// socket to the native camera source, which encodes, encrypts and publishes
// it (`src-tauri/src/native_voice/video.rs` parses the message format).
//
// Frames are dropped, never queued: one copy in flight at a time, nothing
// sent while the socket still has unsent bytes, and no faster than the
// publish options' max framerate.
//
// Lifecycle (B7-11): owned by `NativeRoom`'s camera publication and disposed
// on unpublish or disconnect; dispose cancels the frame callback, detaches
// the stream and closes the socket.
import { createLogger } from "../../../lib/logger";
import { nativeCounters } from "./counters";

const log = createLogger("nativeCamera");

/** Upload formats the backend converts, keyed by `VideoFrame.format`. */
const FORMATS: Record<string, number> = { RGBA: 1, RGBX: 1, BGRA: 2, BGRX: 2, I420: 3, NV12: 4 };
const HEADER_BYTES = 9 * 4;

/** Header: format, width, height, then offset/stride of up to three planes
 *  (offsets relative to the pixel data after the header), all u32 LE. */
export function uploadHeader(
  format: number,
  width: number,
  height: number,
  planes: ReadonlyArray<{ offset: number; stride: number }>,
): Uint32Array {
  const header = new Uint32Array(HEADER_BYTES / 4);
  header.set([format, width, height]);
  planes.slice(0, 3).forEach((p, i) => header.set([p.offset, p.stride], 3 + i * 2));
  return header;
}

/** One camera frame as an upload message: the frame's own pixel layout when
 *  the backend converts it, otherwise RGBA drawn through `fallback`. */
export async function encodeFrame(
  frame: VideoFrame,
  fallback: (width: number, height: number) => Uint8ClampedArray,
): Promise<ArrayBuffer> {
  const { width, height } = frame.visibleRect ?? {
    width: frame.codedWidth,
    height: frame.codedHeight,
  };
  const format = frame.format === null ? undefined : FORMATS[frame.format];
  if (format !== undefined) {
    const buffer = new ArrayBuffer(HEADER_BYTES + frame.allocationSize());
    const layout = await frame.copyTo(new Uint8Array(buffer, HEADER_BYTES));
    new Uint32Array(buffer, 0, HEADER_BYTES / 4).set(uploadHeader(format, width, height, layout));
    return buffer;
  }
  const rgba = fallback(width, height);
  const buffer = new ArrayBuffer(HEADER_BYTES + rgba.byteLength);
  new Uint32Array(buffer, 0, HEADER_BYTES / 4).set(
    uploadHeader(FORMATS.RGBA!, width, height, [{ offset: 0, stride: width * 4 }]),
  );
  new Uint8Array(buffer, HEADER_BYTES).set(rgba);
  return buffer;
}

export class CameraUplink {
  private readonly socket: WebSocket;
  private readonly video = document.createElement("video");
  private canvas: CanvasRenderingContext2D | null = null;
  private callback = 0;
  private lastSent = -Infinity;
  private busy = false;
  private disposed = false;

  /** `url`: the frame socket's `/camera` route. */
  constructor(
    url: string,
    track: MediaStreamTrack,
    private readonly maxFramerate: number,
  ) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = new MediaStream([track]);
    this.video.play().catch((err: unknown) => log.warn("camera pump did not start", err));
    this.callback = this.video.requestVideoFrameCallback(this.onFrame);
    nativeCounters.cameraUplinks++;
  }

  private readonly onFrame = (now: number): void => {
    if (this.disposed) return;
    this.callback = this.video.requestVideoFrameCallback(this.onFrame);
    if (
      this.busy ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 0 ||
      now - this.lastSent < 1000 / this.maxFramerate - 2
    )
      return;
    this.lastSent = now;
    this.busy = true;
    void this.send()
      .catch((err: unknown) => log.warn("camera frame dropped", err))
      .finally(() => {
        this.busy = false;
      });
  };

  private async send(): Promise<void> {
    const frame = new VideoFrame(this.video);
    try {
      const message = await encodeFrame(frame, (w, h) => this.drawRgba(w, h));
      if (!this.disposed && this.socket.readyState === WebSocket.OPEN) this.socket.send(message);
    } finally {
      frame.close();
    }
  }

  /** Opaque frames (no CPU layout) are read back through a 2D canvas. */
  private drawRgba(width: number, height: number): Uint8ClampedArray {
    if (this.canvas === null) {
      this.canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      // i18n-exempt: internal canvas guard, never rendered
      if (this.canvas === null) throw new Error("no 2D canvas for the camera pump");
    }
    const c = this.canvas.canvas;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    this.canvas.drawImage(this.video, 0, 0, width, height);
    return this.canvas.getImageData(0, 0, width, height).data;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    nativeCounters.cameraUplinks--;
    this.video.cancelVideoFrameCallback(this.callback);
    this.video.srcObject = null;
    this.socket.close();
  }
}
