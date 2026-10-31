/** Camera and screen-share quality presets, publish options and saved quality, re-exported by screenShare.ts. */

import {
  type VideoCaptureOptions,
  VideoPresets,
  VideoPreset,
  type TrackPublishOptions,
  Track,
  type AudioCaptureOptions,
  AudioPresets,
  type ScreenShareCaptureOptions,
  ScreenSharePresets,
} from "livekit-client";
import { loadPref } from "@lib/prefs/preferences";
import { offeredShareFps } from "@lib/voice/shareFps";
import { shareMotionArm, getShareMotionPolicy } from "./shareFlags";
import type { PublishCodec } from "../../features/voice/videoCodec";

// ---------------------------------------------------------------------------
// Stream quality presets
// ---------------------------------------------------------------------------

export type StreamQuality = "low" | "medium" | "high" | "source";

export const CAMERA_PRESETS: Record<StreamQuality, VideoCaptureOptions> = {
  low: { resolution: VideoPresets.h360.resolution },
  medium: { resolution: VideoPresets.h720.resolution },
  high: { resolution: VideoPresets.h1080.resolution },
  source: { resolution: VideoPresets.h1080.resolution },
};

export const CAMERA_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low: 600_000,
  medium: 1_700_000,
  high: 4_000_000,
  source: 8_000_000,
};

/** A 1080p camera's lower layers (the SDK adds the full-resolution one on
 *  top). Its default 180p/360p pair leaves a viewer on a 1-3 Mbps link a
 *  blurry 360p picture with stalls when a 720p layer would fit. Only the high
 *  preset needs it: the 720p preset's own default layers already end at 360p
 *  below it. Mirrored by `camera_publish_options` in native_voice/session.rs. */
export function cameraSimulcastLayers(quality: StreamQuality): VideoPreset[] | undefined {
  return quality === "high" ? [VideoPresets.h360, VideoPresets.h720] : undefined;
}

/** The simulcast part of a video publish's options. VP9 is published as SVC,
 *  where livekit-client builds its own spatial layers and never reads ours, so
 *  it gets none; VP8 and H.264 keep the camera's and the share's layers. */
export function videoLayerOptions(
  kind: "camera" | "screen",
  codec: PublishCodec,
  quality: StreamQuality,
  fps: number,
): Pick<TrackPublishOptions, "simulcast" | "videoSimulcastLayers" | "screenShareSimulcastLayers"> {
  if (codec === "vp9") return { simulcast: false };
  if (kind === "camera") {
    const layers = cameraSimulcastLayers(quality);
    return {
      simulcast: quality !== "source",
      ...(layers ? { videoSimulcastLayers: layers } : {}),
    };
  }
  const simulcast = isScreenShareSimulcast(quality, fps);
  return {
    simulcast,
    ...(simulcast ? { screenShareSimulcastLayers: [...SCREENSHARE_SIMULCAST_LAYERS] } : {}),
  };
}

/** The camera's frame-rate cap: 15 fps at the low preset, else 30. */
export function cameraMaxFramerate(quality: StreamQuality): number {
  return quality === "low" ? 15 : 30;
}

/** The camera's video publish options for `codec`. One factory for the first
 *  publish and for the live codec switch, so the two cannot drift. */
export function cameraPublishOptions(
  codec: PublishCodec,
  quality: StreamQuality,
): TrackPublishOptions {
  const maxFramerate = cameraMaxFramerate(quality);
  return {
    source: Track.Source.Camera,
    ...videoLayerOptions("camera", codec, quality, maxFramerate),
    videoEncoding: { maxBitrate: CAMERA_PUBLISH_BITRATES[quality], maxFramerate },
    videoCodec: codec,
  };
}

/** Screen-share audio: capture it, but exclude OwnCord's own playback from the
 *  captured stream. Without `restrictOwnAudio` a screen share on Windows
 *  captures system loopback — the call itself — and echoes every other caller
 *  back into the stream the viewers hear. Chromium-only (WebView2 included);
 *  other browsers ignore the constraint and keep their current behaviour.
 *  It only takes effect through the real picker: with
 *  `--use-fake-ui-for-media-stream` Chromium answers getDisplayMedia with the
 *  default microphone as the "screen audio" and never reads it, so the window
 *  must not pass that flag (see tauri.conf.json).
 *
 *  The captured track is game or music audio, not a voice: Chromium's voice
 *  processing is switched off (it would duck, gate and compress it) and stereo
 *  is requested. Published as music in `SCREENSHARE_AUDIO_PUBLISH`. */
const SCREENSHARE_AUDIO: AudioCaptureOptions = {
  restrictOwnAudio: true,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};

/** Publish options for the screen-share audio track. Without them it inherits
 *  the voice defaults: DTX (pumps quiet passages), mono, and the operator's
 *  voice bitrate. */
export const SCREENSHARE_AUDIO_PUBLISH: TrackPublishOptions = {
  dtx: false,
  forceStereo: true,
  audioPreset: AudioPresets.musicHighQualityStereo,
};

export const SCREENSHARE_PRESETS: Record<StreamQuality, ScreenShareCaptureOptions> = {
  low: { audio: SCREENSHARE_AUDIO, resolution: ScreenSharePresets.h720fps5.resolution },
  medium: {
    audio: SCREENSHARE_AUDIO,
    resolution: ScreenSharePresets.h720fps30.resolution,
    contentHint: "motion",
  },
  high: {
    audio: SCREENSHARE_AUDIO,
    resolution: ScreenSharePresets.h1080fps30.resolution,
    contentHint: "motion",
  },
  source: { audio: SCREENSHARE_AUDIO, contentHint: "motion" }, // no resolution cap — use native source resolution
};

export const SCREENSHARE_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low: 1_500_000,
  medium: 3_000_000,
  high: 6_000_000,
  source: 10_000_000,
};

function loadQuality(key: string, fallback: StreamQuality): StreamQuality {
  const saved = loadPref<string>(key, fallback);
  if (saved === "low" || saved === "medium" || saved === "high" || saved === "source") return saved;
  return fallback;
}

/** The camera's quality: 720p by default (half the encode CPU of 1080p, and a
 *  720p tile is what a grid shows). It keeps the `streamQuality` key it shared
 *  with the screen share before the two were split, so a saved choice carries
 *  over. */
export function getCameraQuality(): StreamQuality {
  return loadQuality("streamQuality", "medium");
}

/** The screen share's quality. 720p30 by default: scrolling text at 1080p
 *  needs about 5 Mbps to stay fluid, and slides to 1-2 fps below that. */
export function getScreenShareQuality(): StreamQuality {
  return loadQuality("screenShareQuality", "medium");
}

/** Whether a screen share at `quality` and `fps` is published with
 *  SCREENSHARE_SIMULCAST_LAYERS. Without a lower layer the SFU can only send
 *  a viewer whose link cannot carry the share the full stream, which they
 *  cannot decode at all (a frozen frame), while their keyframe requests raise
 *  the bitrate for every other viewer. Low is already a small stream, and
 *  Source is meant to arrive untouched. High at 120 fps goes out as one layer
 *  too: encoding both layers in turn held 1080p120 to 40-50 fps. */
export function isScreenShareSimulcast(quality: StreamQuality, fps: number): boolean {
  return quality === "medium" || (quality === "high" && fps !== 120);
}

/** The screen share's one lower layer (the SDK adds the full-resolution one
 *  on top): 720p keeps text readable, and 15 fps at 1.2 Mbps leaves most of
 *  the budget to the top layer. */
export const SCREENSHARE_SIMULCAST_LAYERS: readonly VideoPreset[] = [
  new VideoPreset(1280, 720, 1_200_000, 15),
];

// ---------------------------------------------------------------------------
// Screen share frame rate
// ---------------------------------------------------------------------------

/** Saved screen share FPS preference. 30 is the default and keeps each
 *  quality's own cap (5 for low, 30 otherwise); 60/120 are explicit
 *  overrides. A saved 120 reads as 60 while 120 is not offered. */
export function getScreenShareFps(): number {
  return offeredShareFps(loadPref<number>("screenShareFps", 30));
}

/** Effective capture/publish frame rate for a quality + fps preference. */
export function getEffectiveScreenShareFps(quality: StreamQuality, fps: number): number {
  if (fps !== 60 && fps !== 120) {
    return quality === "low" ? 5 : 30;
  }
  return fps;
}

/** How WebRTC gives way when the encoder or link cannot keep up: the picture
 *  gets smaller or softer and the motion stays smooth, at every frame rate.
 *  Holding the resolution instead turned a fast video on a slow uplink into a
 *  5-10 fps slideshow. Always explicit, so an SDK default cannot move it. */
export function screenShareDegradation(): RTCDegradationPreference {
  return "maintain-framerate";
}

/** High frame rates need proportionally more bitrate to stay sharp. */
const FPS_BITRATE_MULTIPLIER: Readonly<Record<number, number>> = { 60: 1.5, 120: 2 };

export function getScreenShareMaxBitrate(quality: StreamQuality, fps: number): number {
  const multiplier = FPS_BITRATE_MULTIPLIER[fps] ?? 1;
  return Math.round(SCREENSHARE_PUBLISH_BITRATES[quality] * multiplier);
}

/** The share's video publish options for `codec` (`fps` is the saved choice,
 *  30 meaning the quality's own rate). One factory for the first publish and
 *  for the live codec switch. livekit-client takes a screen share's encoding
 *  from `screenShareEncoding` and ignores `videoEncoding` for that source. */
export function screenVideoPublishOptions(
  codec: PublishCodec,
  quality: StreamQuality,
  fps: number,
): TrackPublishOptions {
  const effectiveFps = getEffectiveScreenShareFps(quality, fps);
  return {
    source: Track.Source.ScreenShare,
    ...videoLayerOptions("screen", codec, quality, fps),
    screenShareEncoding: {
      maxBitrate: getScreenShareMaxBitrate(quality, fps),
      maxFramerate: effectiveFps,
    },
    videoCodec: codec,
    degradationPreference:
      shareMotionArm(getShareMotionPolicy()).degradation ?? screenShareDegradation(),
  };
}

/** Capture options for a quality with the fps preference applied. Presets with
 *  a fixed resolution get frameRate injected into the getDisplayMedia
 *  constraints. Always returns a copy: createLocalScreenTracks mutates the
 *  options object in place (it injects a default 1080p30 resolution when none
 *  is set), which would otherwise corrupt the shared presets.
 *
 *  For "source" (no resolution cap) with an explicit 60/120 override, a
 *  zero-size resolution suppresses the library's 1080p30 default (the
 *  constraint translation treats 0 as uncapped) and the frame rate is passed
 *  through the raw video constraints instead. */
export function getScreenShareCaptureOptions(
  quality: StreamQuality,
  fps: number,
): ScreenShareCaptureOptions {
  const { contentHint } = shareMotionArm(getShareMotionPolicy());
  const options = baseScreenShareCaptureOptions(quality, fps);
  return contentHint === undefined ? options : { ...options, contentHint };
}

function baseScreenShareCaptureOptions(
  quality: StreamQuality,
  fps: number,
): ScreenShareCaptureOptions {
  const preset = SCREENSHARE_PRESETS[quality];
  const effectiveFps = getEffectiveScreenShareFps(quality, fps);
  if (preset.resolution === undefined) {
    if (fps === 60 || fps === 120) {
      return {
        ...preset,
        resolution: { width: 0, height: 0, frameRate: effectiveFps },
        // Runtime passes this object verbatim to getDisplayMedia; the declared
        // type is narrower than what the library actually accepts.
        video: { frameRate: effectiveFps } as ScreenShareCaptureOptions["video"],
      };
    }
    return { ...preset };
  }
  return {
    ...preset,
    resolution: { ...preset.resolution, frameRate: effectiveFps },
  };
}
