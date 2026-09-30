// Screen share on Linux: the capture runs in the Rust session
// (`src-tauri/src/native_voice/screen.rs`), so the webview never holds the
// captured pixels as a browser track. `NativeScreenTrack` stands in for the
// `LocalVideoTrack` that `createLocalScreenTracks` returns on the web path:
// its `mediaStreamTrack` is the local preview (the frame socket's `/screen`
// route, drawn by a `NativeVideoRenderer`), `stop()` stops the host capture,
// and `end()` raises the `ended` event the shared screen-share code listens
// for when the OS stops a capture. Video only: the desktop capturer has no
// audio, so a Linux share publishes no screen-share audio track.
//
// Lifecycle (B7-11): the shared screen-share state owns the track and stops
// it on disable/leave; `NativeRoom` also stops it when it disconnects.
// stop() is idempotent.
import type {
  NativeVoiceScreenCapture,
  NativeVoiceScreenStarted,
} from "../../../platform/contracts/nativeVoice";
import { PICKER_DISMISSED } from "./platform";
import { nativeCounters } from "./counters";
import { NativeVideoRenderer } from "./videoRenderer";

/** The host's rejection of a start whose portal dialog was dismissed
 *  (`screen::CANCELLED`). */
// i18n-exempt: host rejection marker compared with includes(), never displayed
const CANCELLED = "screen capture was cancelled";

/** The capture-option slice of livekit-client's `ScreenShareCaptureOptions`
 *  that the shared screen-share code sets. */
export interface ScreenCaptureRequest {
  resolution?: { width: number; height: number; frameRate?: number };
}

/** Map the web path's capture options onto the host's. An unset resolution
 *  is what `createLocalScreenTracks` turns into 1080p at 30 fps; a zero size
 *  is its "no cap". */
export function captureOptions(options: ScreenCaptureRequest): NativeVoiceScreenCapture {
  const resolution = options.resolution ?? { width: 1920, height: 1080, frameRate: 30 };
  return {
    fps: resolution.frameRate ?? 30,
    maxWidth: resolution.width,
    maxHeight: resolution.height,
  };
}

/** The rejection a dismissed picker raises, as a dismissed browser picker's:
 *  the shared code keeps it silent. */
export function pickerDismissed(): DOMException {
  return new DOMException(PICKER_DISMISSED, "NotAllowedError");
}

/** A host start failure as the shared code classifies getDisplayMedia's: a
 *  dismissed portal dialog is a dismissed picker; any other failure (a
 *  capturer that failed, no first frame in time) stays an error it reports. */
export function startError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(CANCELLED) ? pickerDismissed() : err;
}

/** A device switch the host actually completed by falling back to the default
 *  (capture.rs/playout.rs report it as a rejection). The caller should treat
 *  it as success, not a switch failure (voice #19). */
export function isDeviceFallback(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("switched to the default");
}

/** The publish encoding the picker chose for this share. */
export interface ScreenPublishEncoding {
  readonly maxBitrate: number;
  readonly maxFramerate: number;
}

export class NativeScreenTrack {
  readonly kind = "video";
  readonly source = "screen_share";
  readonly capture: number;
  readonly width: number;
  readonly height: number;
  private readonly renderer: NativeVideoRenderer;
  private stopped = false;

  /** `previewUrl`: the frame socket's `/screen` route. `onStop` stops the
   *  host capture. `publishEncoding` is the per-share quality the picker
   *  chose. */
  constructor(
    started: NativeVoiceScreenStarted,
    previewUrl: string,
    private readonly onStop: (track: NativeScreenTrack) => void,
    readonly publishEncoding: ScreenPublishEncoding,
  ) {
    this.capture = started.capture;
    this.width = started.width;
    this.height = started.height;
    this.renderer = new NativeVideoRenderer(previewUrl);
    nativeCounters.screenTracks++;
  }

  get mediaStreamTrack(): MediaStreamTrack {
    return this.renderer.mediaStreamTrack;
  }

  /** The host capture ended on its own: do what a browser capture track
   *  does when the OS stops it (readyState "ended", then the `ended` event),
   *  so the shared code disables the share, even before it listens. */
  end(): void {
    if (this.stopped) return;
    this.mediaStreamTrack.stop();
    this.mediaStreamTrack.dispatchEvent(new Event("ended"));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    nativeCounters.screenTracks--;
    this.renderer.dispose();
    this.onStop(this);
  }
}
