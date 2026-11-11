// Shared types and small helpers of the native room's local video, split from
// nativeLocalVideo.ts. Nothing here holds state.
import type { NativeVoiceStats } from "../../../platform/contracts/nativeVoice";
import type { NativeCameraTrack } from "./nativeCameraTrack";
import type { NativeScreenAudioTrack } from "./screenAudioTrack";
import type { NativeScreenTrack } from "./screenTrack";

/** The slice of livekit-client's `LocalVideoTrack` the camera path hands
 *  `publishTrack`. */
export interface PublishableTrack {
  kind: string;
  source: string;
  mediaStreamTrack: MediaStreamTrack;
}

export interface PublishOptions {
  source?: string;
  simulcast?: boolean;
  /** The selected preset's capture size; the host downscales a larger source. */
  resolution?: { width: number; height: number };
  videoEncoding?: { maxBitrate: number; maxFramerate?: number };
  /** The codec `resolveVideoCodec` chose; the native engine publishes VP8
   *  unless this is `h264` or `vp9`. */
  videoCodec?: string;
}

/** The native publish's codec for the shared path's `videoCodec` option:
 *  H.264 or VP9 when asked for, VP8 for everything else (the native engine has
 *  no H.265). */
export function nativeCodec(options: PublishOptions): "vp8" | "h264" | "vp9" {
  return options.videoCodec === "h264" || options.videoCodec === "vp9" ? options.videoCodec : "vp8";
}

/** A local camera or screen publication, as `getLocalCameraStream`,
 *  `getLocalScreenshareStream` and the diagnostics read it. */
export interface NativeLocalPublication {
  readonly trackSid: string;
  readonly source: string;
  readonly kind: string;
  readonly isMuted: boolean;
  /** The camera track is a `NativeCameraTrack`, the screen share a
   *  `NativeScreenTrack`; both stand in for `LocalVideoTrack`. */
  readonly track: PublishableTrack | NativeCameraTrack | NativeScreenTrack | NativeScreenAudioTrack;
}

export function unsupported(what: string): Error {
  // i18n-exempt: internal Linux unsupported-path guard, caught and mapped by the caller
  return new Error(`${what} is not available on Linux yet`);
}

/** What the local video reads from its room: the live session, the frame
 *  socket and the local publications map. */
export interface NativeVideoHost {
  sessionId(): number | null;
  frames(): string;
  readonly publications: Map<string, NativeLocalPublication>;
  readStats(): Promise<NativeVoiceStats | null>;
}
