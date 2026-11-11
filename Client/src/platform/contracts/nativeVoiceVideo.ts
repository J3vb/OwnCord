/**
 * Native voice video types: codecs, the camera and the screen share. Split
 * from `nativeVoice.ts`, which re-exports every name.
 */

/** A video codec the native engine publishes. */
export type NativeVoiceVideoCodec = "vp8" | "h264" | "vp9";

/** What the native engine can encode beyond VP8 (`h264`, `vp9`) and decode
 *  (`decode`: lowercase codec names from libwebrtc's receiver capabilities). */
export interface NativeVoiceVideoCodecs {
  h264: boolean;
  vp9: boolean;
  decode: string[];
}

/** How the camera is published: the web path's `publishTrack` options. */
export interface NativeVoiceCameraOptions {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
  simulcast: boolean;
  /** The codec to publish with. The host defaults to VP8 when it is absent;
   *  `h264` and `vp9` only go out when `videoCodecs` said the engine can encode them. */
  codec: NativeVoiceVideoCodec;
}

/** A native camera device: the id `startCamera` takes. */
export interface NativeVoiceCameraDevice {
  id: string;
  name: string;
  /** Offers only greyscale formats: a face-unlock infrared sensor, listed
   *  after the colour cameras. */
  infrared: boolean;
}

/** Whether the host can capture cameras at all: GStreamer initialises and the
 *  capture pipeline's required elements exist. `missing` names the required
 *  elements that could not be found. */
export interface NativeVoiceCameraSupport {
  available: boolean;
  missing: string[];
}

/** Capture pacing and size cap for the native camera; 0 for both sizes is the
 *  source size. */
export interface NativeVoiceCameraCapture {
  fps: number;
  maxWidth: number;
  maxHeight: number;
}

/** A started camera capture: its id and the first frame's size. */
export interface NativeVoiceCameraStarted {
  capture: number;
  width: number;
  height: number;
}

/** A camera preview outside any room (the settings tab): the live preview
 *  plays on the frame socket's `/camera` route. */
export interface NativeVoiceCameraPreview {
  width: number;
  height: number;
  /** The preview's frame-socket base URL, token included. */
  frames: string;
}

export interface NativeVoiceScreenSource {
  /** What `startScreen` takes. */
  id: string;
  kind: "screen" | "window";
  title: string;
  /** An image URL of the source as it looks now, when it could be read. */
  thumbnail: string | null;
  /** Refresh rate in Hz of the monitor a `screen` source is (X11, from
   *  XRandR). `null` for windows and when it could not be read. */
  readonly refreshHz?: number | null;
}

/** What can be shared. `portal`: the desktop portal's dialog picks
 *  (Wayland), so `sources` is empty and `startScreen` takes `"portal"`. */
export interface NativeVoiceScreenSources {
  portal: boolean;
  sources: NativeVoiceScreenSource[];
  /** Other applications' sound can be shared with the screen: a PulseAudio
   *  protocol server (PulseAudio or pipewire-pulse) answered. */
  audio: boolean;
}

/** Capture pacing and size cap; 0 for both sizes is the source size. */
export interface NativeVoiceScreenCapture {
  fps: number;
  maxWidth: number;
  maxHeight: number;
}

/** A started capture: its id and the first frame's size. */
export interface NativeVoiceScreenStarted {
  capture: number;
  width: number;
  height: number;
}

/** How the screen share is published: the capture's size and the web
 *  path's `publishTrack` encoding for it. `simulcast` adds the web path's
 *  720p 15 fps layer (`SCREENSHARE_SIMULCAST_LAYERS`). */
export interface NativeVoiceScreenOptions {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
  simulcast: boolean;
  /** The codec to publish with. The host defaults to VP8 when it is absent;
   *  `h264` and `vp9` only go out when `videoCodecs` said the engine can encode them. */
  codec: NativeVoiceVideoCodec;
}

/** What a live quality change published: the new publication's sid and the
 *  size the capture now delivers. */
export interface NativeVoiceScreenQualitySet {
  sid: string;
  width: number;
  height: number;
}

/** The outcome of `setScreenQuality`. `refused`: nothing changed and the
 *  share goes on (no published share, a stale capture, a source change
 *  pending, or a host that rejected without a stage). `publish`: the
 *  republish failed and only the screen video is unpublished: the capture
 *  and the share audio stay up, so the caller must `stopScreen` or retry
 *  `publishScreen`. */
export type NativeVoiceScreenQualityResult =
  | ({ ok: true } & NativeVoiceScreenQualitySet)
  | { ok: false; stage: "refused" | "publish"; message: string };
