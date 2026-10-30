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
// Lifecycle: the shared camera state owns the track and stops it on
// disable/leave; `NativeRoom` also stops it when it disconnects. stop() is
// idempotent.
import type {
  NativeVoiceCameraCapture,
  NativeVoiceCameraStarted,
} from "../../../platform/contracts/nativeVoice";
import { nativeCounters } from "./counters";
import { NativeVideoRenderer } from "./videoRenderer";

export class NativeCameraTrack {
  readonly kind = "video";
  readonly source = "camera";
  capture: number;
  width: number;
  height: number;
  /** The device id the capture runs on (what `setDeviceId` compares to). */
  device: string;
  private readonly renderer: NativeVideoRenderer;
  private stopped = false;

  /** `previewUrl`: the frame socket's `/camera` route. `onStop` stops the
   *  host capture (and unpublishes). */
  constructor(
    started: NativeVoiceCameraStarted,
    previewUrl: string,
    private readonly onStop: (track: NativeCameraTrack) => void,
    device: string,
    /** The capture pacing and size cap a device change starts its capture with. */
    readonly captureRequest: NativeVoiceCameraCapture,
    private readonly onChangeDevice: (
      track: NativeCameraTrack,
      deviceId: string,
    ) => Promise<boolean>,
  ) {
    this.device = device;
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

  /** Use camera `deviceId` under the same publication: the host starts a
   *  capture of it beside the live one and swaps once it has a frame. The
   *  preview socket carries on, so the renderer and its track stay. Rejects
   *  with `CameraSwitchUnavailable` when the host cannot (the camera is still
   *  on its old device); `mediaControl` then restarts it. */
  setDeviceId(deviceId: string): Promise<boolean> {
    return this.onChangeDevice(this, deviceId);
  }

  /** The host moved this camera onto capture `started`. */
  retarget(started: NativeVoiceCameraStarted): void {
    this.capture = started.capture;
    this.width = started.width;
    this.height = started.height;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    nativeCounters.cameraCaptures--;
    this.renderer.dispose();
    this.onStop(this);
  }
}
