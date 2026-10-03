// Native camera on Linux: the capture runs in the Rust session
// (`src-tauri/src/native_voice/camera.rs`), so the webview never holds the
// captured pixels as a browser track and capture keeps running while the
// OwnCord window is hidden (WebKitGTK freezes a hidden page's <video> and
// stops requestVideoFrameCallback, which stalled the old webview pump).
// `NativeCameraTrack` stands in for the `LocalVideoTrack` that
// `createLocalVideoTrack` returns on the web path: its `mediaStreamTrack` is
// the local preview (the frame socket's `/camera` route, drawn by a
// `NativeVideoRenderer`), `stop()` stops the host capture, and `end()` raises
// the `ended` event the shared camera code listens for when the device is
// unplugged.
//
// Lifecycle (B7-11): the shared camera state owns the track and stops it on
// disable/leave; `NativeRoom` also stops it when it disconnects. stop() is
// idempotent.
import type { NativeVoiceCameraStarted } from "../../../platform/contracts/nativeVoice";
import { nativeCounters } from "./counters";
import { NativeVideoRenderer } from "./videoRenderer";

export class NativeCameraTrack {
  readonly kind = "video";
  readonly source = "camera";
  readonly capture: number;
  readonly width: number;
  readonly height: number;
  private readonly renderer: NativeVideoRenderer;
  private stopped = false;

  /** `previewUrl`: the frame socket's `/camera` route. `onStop` stops the
   *  host capture (and unpublishes). */
  constructor(
    started: NativeVoiceCameraStarted,
    previewUrl: string,
    private readonly onStop: (track: NativeCameraTrack) => void,
  ) {
    this.capture = started.capture;
    this.width = started.width;
    this.height = started.height;
    this.renderer = new NativeVideoRenderer(previewUrl);
    nativeCounters.cameraCaptures++;
  }

  get mediaStreamTrack(): MediaStreamTrack {
    return this.renderer.mediaStreamTrack;
  }

  /** The host capture ended on its own (device unplugged): do what a browser
   *  camera track does when the device goes away (readyState "ended", then
   *  the `ended` event), so the shared code disables the camera, even before
   *  it listens. */
  end(): void {
    if (this.stopped) return;
    this.mediaStreamTrack.stop();
    this.mediaStreamTrack.dispatchEvent(new Event("ended"));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    nativeCounters.cameraCaptures--;
    this.renderer.dispose();
    this.onStop(this);
  }
}
