/**
 * Capture setup steps of the camera and screen share enables
 * (screenShare.ts): the native camera capture, the web share's quality
 * step, and the share's publish options.
 */
import {
  type Room,
  type LocalVideoTrack,
  type LocalTrack,
  type TrackPublishOptions,
  Track,
  createLocalVideoTrack,
} from "livekit-client";
import { createLogger } from "@lib/logger";
import type { NativeCameraTrack } from "../../features/voice/native/nativeCameraTrack";
import type { ScreenSourcePicker } from "../../features/voice/native/screenPickerSlot";
import {
  CAMERA_PRESETS,
  CAMERA_PUBLISH_BITRATES,
  SCREENSHARE_AUDIO_PUBLISH,
  type StreamQuality,
} from "./videoPresets";

const log = createLogger("screenShare");

/** The native camera publication surface `NativeRoom` adds to
 *  `localParticipant`, reached through a cast because the shared modules see
 *  livekit-client's `Room`. Captures in the host so it survives a hidden
 *  window; the returned track is a `NativeCameraTrack`. */
interface NativeCameraParticipant {
  createCameraTracks(options: {
    source?: string;
    simulcast?: boolean;
    resolution?: { width: number; height: number };
    videoEncoding?: { maxBitrate: number; maxFramerate?: number };
  }): Promise<NativeCameraTrack[]>;
}

export function hasCameraTracks(
  participant: Room["localParticipant"],
): participant is Room["localParticipant"] & NativeCameraParticipant {
  return typeof (participant as Partial<NativeCameraParticipant>).createCameraTracks === "function";
}

/** Linux captures in the native backend (WebKitGTK freezes a hidden page's
 *  <video>, which stalled the webview pump): the room's `createCameraTracks`
 *  stands in for `createLocalVideoTrack` and its track previews the host
 *  capture over the frame socket. Windows and macOS keep the web path. The
 *  cast is the same seam the native room crosses: `NativeCameraTrack` is
 *  structurally the `LocalVideoTrack` slice enableCamera uses. */
export async function createCameraTrack(
  room: Room,
  quality: StreamQuality,
  savedVideoDevice: string,
): Promise<LocalVideoTrack> {
  return (
    hasCameraTracks(room.localParticipant)
      ? (
          await room.localParticipant.createCameraTracks({
            source: Track.Source.Camera,
            simulcast: quality !== "source",
            ...(quality === "source" ? {} : { resolution: CAMERA_PRESETS[quality].resolution }),
            videoEncoding: {
              maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
              maxFramerate: quality === "low" ? 15 : 30,
            },
          })
        )[0]!
      : await createLocalVideoTrack({
          ...CAMERA_PRESETS[quality],
          ...(savedVideoDevice ? { deviceId: savedVideoDevice } : {}),
        })
  ) as LocalVideoTrack;
}

/** The web path's quality step before the OS picker: the saved
 *  defaults, overridden for this share by the dialog. Null when it was closed. */
export async function pickWebShareQuality(
  showPicker: ScreenSourcePicker,
  quality: StreamQuality,
  fps: number,
): Promise<{ quality: StreamQuality; fps: number; appAudio: boolean } | null> {
  try {
    const pick = await showPicker({
      sources: [],
      portal: false,
      osPicker: true,
      defaultQuality: quality,
      defaultFps: fps,
    });
    return pick === null
      ? null
      : { quality: pick.quality, fps: pick.fps, appAudio: pick.audio === true };
  } catch (err) {
    // The dialog's chunk failed to load: share at the defaults rather than not at all.
    log.warn("Screen share quality step unavailable", err);
    return { quality, fps, appAudio: false };
  }
}

/** The share's quality, frame rate and app-audio switch. */
export interface ShareSettings {
  quality: StreamQuality;
  fps: number;
  appAudioOn: boolean;
}

export function stopTracks(tracks: LocalTrack[]): void {
  for (const t of tracks) t.stop();
}

export function sharePublishOptions(
  track: LocalTrack,
  videoOptions: TrackPublishOptions,
): TrackPublishOptions {
  return {
    ...(track.kind === Track.Kind.Video
      ? videoOptions
      : {
          source: Track.Source.ScreenShareAudio,
          simulcast: false,
          ...SCREENSHARE_AUDIO_PUBLISH,
        }),
  };
}
