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
import { nativeCounters } from "./counters";
import { NativeVideoRenderer } from "./videoRenderer";

/** The host's rejection of a start whose portal dialog was cancelled or
 *  refused (`screen::CANCELLED`). */
// i18n-exempt: host rejection marker compared with includes(), never displayed
const CANCELLED = "screen capture was cancelled or refused";

/** The capture-option slice of livekit-client's `ScreenShareCaptureOptions`
 *  that the shared screen-share code sets. */
export interface ScreenCaptureRequest {
  resolution?: { width: number; height: number; frameRate?: number };
}

/** Map the web path's capture options onto the host's. An unset resolution
 *  is what `createLocalScreenTracks` turns into 1080p at 30 fps; a zero size
 *  is its "no cap". */
export function captureOptions(
  options: ScreenCaptureRequest | undefined,
): NativeVoiceScreenCapture {
  const resolution = options?.resolution ?? { width: 1920, height: 1080, frameRate: 30 };
  return {
    fps: resolution.frameRate ?? 30,
    maxWidth: resolution.width,
    maxHeight: resolution.height,
  };
}

/** A host start failure as the shared code classifies getDisplayMedia's:
 *  a cancelled or refused portal dialog is a `NotAllowedError`. */
export function startError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(CANCELLED) ? new DOMException(message, "NotAllowedError") : err;
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
   *  host capture. */
  constructor(
    started: NativeVoiceScreenStarted,
    previewUrl: string,
    private readonly onStop: (track: NativeScreenTrack) => void,
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
