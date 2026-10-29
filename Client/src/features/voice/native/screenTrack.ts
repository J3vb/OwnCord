// Screen share on Linux: the capture runs in the Rust session
// (`src-tauri/src/native_voice/screen.rs`), so the webview never holds the
// captured pixels as a browser track. `NativeScreenTrack` stands in for the
// `LocalVideoTrack` that `createLocalScreenTracks` returns on the web path:
// its `mediaStreamTrack` is the local preview (the frame socket's `/screen`
// route, drawn by a `NativeVideoRenderer`), `stop()` stops the host capture,
// and `end()` raises the `ended` event the shared screen-share code listens
// for when the OS stops a capture. The share's audio is a separate track
// (`screenAudioTrack.ts`) that the host captures from the other applications'
// sound streams and publishes beside this video.
//
// Lifecycle: the shared screen-share state owns the track and stops
// it on disable/leave; `NativeRoom` also stops it when it disconnects.
// stop() is idempotent.
import type {
  NativeVoiceScreenCapture,
  NativeVoiceScreenStarted,
  NativeVoiceSenderLayer,
  NativeVoiceStats,
} from "../../../platform/contracts/nativeVoice";
import type { PublishCodec } from "../videoCodec";
import type { StreamQuality } from "@lib/screenShare";
import { PICKER_DISMISSED, PORTAL_NOT_STARTED } from "./platform";
import { nativeCounters } from "./counters";
import { NativeVideoRenderer } from "./videoRenderer";

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
 *  portal capture that never started is a `NotAllowedError` the shared code
 *  answers with a soft notice; any other failure (a capturer that failed, no
 *  first frame in time) stays an error it reports. */
export function startError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(PORTAL_NOT_STARTED)
    ? new DOMException(PORTAL_NOT_STARTED, "NotAllowedError")
    : err;
}

/** A device switch the host actually completed by falling back to the default
 *  (capture.rs/playout.rs report it as a rejection). The caller should treat
 *  it as success, not a switch failure (voice #19). */
export function isDeviceFallback(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("switched to the default");
}

/** A live quality change the host did not complete: `refused` changed nothing
 *  and the share goes on; `publish` means the republish failed, so the share's
 *  video is no longer published and the caller ends the share. */
export class ScreenQualityError extends Error {
  constructor(
    readonly stage: "refused" | "publish",
    message: string,
  ) {
    super(message);
    this.name = "ScreenQualityError";
  }
}

/** The publish encoding the picker chose for this share. */
export interface ScreenPublishEncoding {
  readonly maxBitrate: number;
  readonly maxFramerate: number;
  readonly simulcast: boolean;
}

/** What a track carries after a live quality change: the choice and the
 *  capture and encoding it maps to (`shareSettings`). */
export interface ScreenQualitySettings {
  readonly quality: StreamQuality;
  readonly fps: number;
  readonly capture: NativeVoiceScreenCapture;
  readonly encoding: ScreenPublishEncoding;
}

export class NativeScreenTrack {
  readonly kind = "video";
  readonly source = "screen_share";
  /** The host capture going out; a Change source moves it (`retarget`). */
  capture: number;
  width: number;
  height: number;
  private readonly renderer: NativeVideoRenderer;
  private stopped = false;

  /** `previewUrl`: the frame socket's `/screen` route. `onStop` stops the
   *  host capture. `publishEncoding` is the per-share quality the picker
   *  chose and `captureRequest` its capture pacing and size; a Change source
   *  (`onChangeSource`) keeps both, and a live quality change
   *  (`onSetQuality`) replaces them (`retargetQuality`). */
  constructor(
    started: NativeVoiceScreenStarted,
    previewUrl: string,
    private readonly onStop: (track: NativeScreenTrack) => void,
    public publishEncoding: ScreenPublishEncoding,
    public captureRequest: NativeVoiceScreenCapture,
    /** The quality and frame-rate choice behind both; the stream card's
     *  Quality menu shows `quality`. */
    public quality: StreamQuality,
    public fps: number,
    private readonly onChangeSource: (track: NativeScreenTrack) => Promise<void>,
    private readonly onSetQuality: (
      track: NativeScreenTrack,
      quality: StreamQuality,
      fps: number,
      published: PublishCodec,
    ) => Promise<void>,
    private readonly senderStats: () => Promise<NativeVoiceStats | null> = () =>
      Promise.resolve(null),
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

  /** The share's encoder layers (shareSenderStats.ts's native seam). Rejects
   *  when the host has no sample, so the tile keeps "sender stats unavailable"
   *  instead of an empty readout. */
  async getSenderStats(): Promise<readonly NativeVoiceSenderLayer[]> {
    const layers = (await this.senderStats())?.localVideo.screen_share;
    if (this.stopped || layers === undefined || layers.length === 0) {
      // i18n-exempt: internal, caught by VideoGrid's poll
      throw new Error("native share stats unavailable");
    }
    return layers;
  }

  /** The host capture ended on its own: do what a browser capture track
   *  does when the OS stops it (readyState "ended", then the `ended` event),
   *  so the shared code disables the share, even before it listens. */
  end(): void {
    if (this.stopped) return;
    this.mediaStreamTrack.stop();
    this.mediaStreamTrack.dispatchEvent(new Event("ended"));
  }

  /** Share another screen or window under the same publication: the picker
   *  opens and the host swaps the capture once the new one runs. Rejects
   *  with a `NotAllowedError` when the pick is cancelled; the old source
   *  keeps going on any rejection. */
  changeSource(): Promise<void> {
    return this.onChangeSource(this);
  }

  /** Run this share at `quality` and `fps` without stopping it: the host
   *  re-sizes the running capture and republishes it, which gives viewers a
   *  new publication. `published` is the codec the share goes out with now.
   *  Rejects with a `ScreenQualityError` and leaves the share as it was
   *  (stage "refused") or unpublished (stage "publish"). */
  setQuality(quality: StreamQuality, fps: number, published: PublishCodec): Promise<void> {
    return this.onSetQuality(this, quality, fps, published);
  }

  /** The host republished this share at `settings`, delivering `size`. The
   *  encoding and capture request a codec republish and a Change source
   *  reuse follow. */
  retargetQuality(size: { width: number; height: number }, settings: ScreenQualitySettings): void {
    this.width = size.width;
    this.height = size.height;
    this.quality = settings.quality;
    this.fps = settings.fps;
    this.captureRequest = settings.capture;
    this.publishEncoding = settings.encoding;
  }

  /** The host moved this share onto capture `started`. The preview socket
   *  carries on, so the renderer and its track stay. */
  retarget(started: NativeVoiceScreenStarted): void {
    this.capture = started.capture;
    this.width = started.width;
    this.height = started.height;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    nativeCounters.screenTracks--;
    this.renderer.dispose();
    this.onStop(this);
  }
}
