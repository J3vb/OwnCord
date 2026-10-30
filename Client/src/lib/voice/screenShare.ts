/**
 * Screen share and camera track management — extracted from livekitSession.ts.
 *
 * Provides stream quality presets and functions for publishing/unpublishing
 * local camera and screenshare tracks via a LiveKit Room.
 */

import {
  AudioPresets,
  Track,
  VideoPreset,
  VideoPresets,
  ScreenSharePresets,
  createLocalScreenTracks,
  createLocalVideoTrack,
  type Room,
  type LocalVideoTrack,
  type LocalTrack,
  type VideoCaptureOptions,
  type ScreenShareCaptureOptions,
  type AudioCaptureOptions,
  type TrackPublishOptions,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  bumpLocalShareRev,
  setLocalCamera,
  setLocalScreenshare,
  voiceStore,
} from "@stores/voice.store";
import { loadPref } from "@lib/prefs/preferences";
import { offeredShareFps } from "@lib/voice/shareFps";
import { setH264GpuProfiles } from "@lib/voice/h264Profile";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import {
  isLinuxDesktop,
  PICKER_DISMISSED,
  PORTAL_NOT_STARTED,
} from "../../features/voice/native/platform";
import type { NativeCameraTrack } from "../../features/voice/native/nativeCameraTrack";
import {
  readSenderSample,
  type SenderStatsTrack,
  type ShareSenderSample,
} from "../../features/voice/shareSenderStats";
import { getShareMotionPolicy, shareMotionArm } from "./shareFlags";
import { nativeCameraSupport } from "../../features/voice/native/devices";
import { voiceText } from "../../i18n/voice";
import { channelPeerDecode } from "../../features/voice/peerDecode";
import {
  h264GpuPublish,
  resolveCodecChoice,
  type CodecChoice,
  type PublishCodec,
} from "../../features/voice/videoCodec";
import {
  getScreenSourcePicker,
  type ScreenSourcePicker,
} from "../../features/voice/native/screenPickerSlot";

const log = createLogger("screenShare");

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
function cameraMaxFramerate(quality: StreamQuality): number {
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
    contentHint: "detail",
  },
  high: {
    audio: SCREENSHARE_AUDIO,
    resolution: ScreenSharePresets.h1080fps30.resolution,
    contentHint: "detail",
  },
  source: { audio: SCREENSHARE_AUDIO, contentHint: "detail" }, // no resolution cap — use native source resolution
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

/** How WebRTC gives way when the encoder or link cannot keep up. At 120 fps
 *  it lowers the resolution a little before it halves the frame rate (a
 *  120 fps share is chosen for motion); otherwise text stays sharp and the
 *  frame rate gives. Always explicit, so an SDK default cannot move 30/60. */
export function screenShareDegradation(effectiveFps: number): RTCDegradationPreference {
  return effectiveFps >= 120 ? "balanced" : "maintain-resolution";
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
      shareMotionArm(getShareMotionPolicy()).degradation ?? screenShareDegradation(effectiveFps),
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

// ---------------------------------------------------------------------------
// Dependencies injected by the caller (LiveKitSession)
// ---------------------------------------------------------------------------

export interface VideoTrackDeps {
  readonly getRoom: () => Room | null;
  readonly getWs: () => WsClient | null;
  readonly onError: (message: string) => void;
  /** Called after publishing a track to re-apply the audio pipeline. */
  readonly reapplyAudioPipeline: () => void;
}

// ---------------------------------------------------------------------------
// Shared race guard for the enable/disable pairs below
// ---------------------------------------------------------------------------

/** A camera/screenshare disable() bumps this so a concurrent enable() that
 *  captured an earlier value before its async device-acquisition gap
 *  (getUserMedia / getDisplayMedia — a seconds-long window on the first
 *  permission prompt) can tell it was superseded once that gap resolves, and
 *  discard the track it just created instead of publishing over a stop. The
 *  camera and screenshare races are the same shape, so both state types
 *  carry this and share the two helpers below rather than each hand-rolling
 *  a counter. */
interface GenerationGuarded {
  generation?: number;
}

/** Exported so callers that stop manual tracks outside disableCamera/
 *  disableScreenshare (leaveVoice, teardownForReconnect) can supersede an
 *  in-flight enable() the same way — see the doc comment above. */
export function bumpGeneration(state: GenerationGuarded): void {
  state.generation = (state.generation ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Server-refusal rollback correlation
// ---------------------------------------------------------------------------

/** Correlates an in-flight camera/screenshare *enable* request's envelope id
 *  with its kind, so dispatcher.ts's ERROR handler can roll back the
 *  already-published track on a server refusal (FORBIDDEN, RATE_LIMITED,
 *  INTERNAL, ...) it could not have pre-blocked. A new enable of the same
 *  kind supersedes the previous entry — only the latest in-flight request
 *  for that kind can still be refused. */
const pendingVideoEnables = new Map<string, "camera" | "screen">();

function registerPendingVideoEnable(id: string, kind: "camera" | "screen"): void {
  for (const [existingId, existingKind] of pendingVideoEnables) {
    if (existingKind === kind) pendingVideoEnables.delete(existingId);
  }
  pendingVideoEnables.set(id, kind);
}

/** Consume a pending video-enable correlation on a server refusal. Returns
 *  the kind that must be rolled back, or undefined when `id` doesn't match
 *  an in-flight enable (unrelated error, or already resolved). */
export function rollbackPendingVideo(id: string): "camera" | "screen" | undefined {
  const kind = pendingVideoEnables.get(id);
  if (kind !== undefined) pendingVideoEnables.delete(id);
  return kind;
}

// ---------------------------------------------------------------------------
// Camera track state
// ---------------------------------------------------------------------------

/** Mutable state for the manually published camera track. */
export interface CameraTrackState extends GenerationGuarded {
  manualCameraTrack: LocalVideoTrack | NativeCameraTrack | null;
  /** The live camera's unplug handler, re-armed when a device switch
   *  restarts its capture. */
  onCameraEnded?: () => void;
  /** The track the server was last told is on. */
  announced?: LocalVideoTrack | NativeCameraTrack;
  /** The live camera's quality, for a republish with the same options. */
  quality?: StreamQuality;
  /** The codec the settings asked for, before peers were considered. */
  preferred?: PublishCodec;
  /** The codec the camera is published with now. */
  published?: PublishCodec;
}

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

function hasCameraTracks(
  participant: Room["localParticipant"],
): participant is Room["localParticipant"] & NativeCameraParticipant {
  return typeof (participant as Partial<NativeCameraParticipant>).createCameraTracks === "function";
}

/** Unpublishing can reject later during WebRTC renegotiation. Track cleanup
 *  must proceed immediately and contain that asynchronous failure too. Takes
 *  any track with a `mediaStreamTrack` (browser `LocalTrack` or a native
 *  camera/screen track). */
export function unpublishManualTrack(
  room: Room,
  track: LocalTrack | { mediaStreamTrack: MediaStreamTrack },
): void {
  try {
    void room.localParticipant.unpublishTrack(track.mediaStreamTrack).catch((err: unknown) => {
      log.warn("Failed to unpublish stopped video track (non-fatal)", err);
    });
  } catch {
    /* already unpublished */
  }
}

export function stopManualCameraTrack(state: CameraTrackState, room: Room | null): void {
  state.onCameraEnded = undefined;
  if (state.manualCameraTrack === null || room === null) return;
  const track = state.manualCameraTrack;
  state.manualCameraTrack = null;
  // A stopped track is no longer what the server was told is on, and holding
  // it would keep the left room reachable through its signal client.
  state.announced = undefined;
  state.preferred = undefined;
  state.published = undefined;
  unpublishManualTrack(room, track);
  track.stop();
}

export async function enableCamera(state: CameraTrackState, deps: VideoTrackDeps): Promise<void> {
  const room = deps.getRoom();
  const ws = deps.getWs();
  if (room === null || ws === null) {
    log.warn("Cannot enable camera: no active voice session");
    deps.onError(voiceText("share.joinVoiceFirst"));
    return;
  }
  const generation = state.generation ?? 0;
  setLocalCamera(true);
  const quality = getCameraQuality();
  let cameraEndedCleanup: (() => void) | undefined;
  try {
    // Linux captures in the backend, which needs GStreamer's camera elements:
    // without them no capture can ever start, so name the missing support
    // rather than failing later with a generic "no camera".
    if (hasCameraTracks(room.localParticipant)) {
      const support = await nativeCameraSupport();
      if ((state.generation ?? 0) !== generation) {
        return;
      }
      if (support !== null && !support.available) {
        log.warn("Cannot enable camera: native camera support is missing", support.missing);
        deps.onError(voiceText("share.gstreamerMissing"));
        setLocalCamera(false);
        return;
      }
    }
    const savedVideoDevice = loadPref<string>("videoInputDevice", "");
    stopManualCameraTrack(state, room);
    // Linux captures in the native backend (WebKitGTK freezes a hidden page's
    // <video>, which stalled the webview pump): the room's `createCameraTracks`
    // stands in for `createLocalVideoTrack` and its track previews the host
    // capture over the frame socket. Windows and macOS keep the web path. The
    // cast is the same seam the native room crosses: `NativeCameraTrack` is
    // structurally the `LocalVideoTrack` slice this function uses.
    const videoTrack = (
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
    if ((state.generation ?? 0) !== generation) {
      // A disableCamera ran to completion while getUserMedia was pending —
      // it already reset localCamera and sent voice_camera(false).
      // Publishing now would resurrect a track the user just turned off.
      videoTrack.stop();
      return;
    }
    state.manualCameraTrack = videoTrack;
    // The `ended` listener is per-track and self-scoped: it acts only while
    // this track is still the reported camera, independent of any other stop
    // path.
    const onEnded = (): void => {
      if (
        (state.generation ?? 0) !== generation ||
        state.manualCameraTrack !== videoTrack ||
        deps.getRoom() !== room ||
        deps.getWs() !== ws
      ) {
        return;
      }
      log.info("Camera track ended externally (device unplugged)");
      void disableCamera(state, deps);
    };
    const removeEndedListener = (): void => {
      videoTrack.mediaStreamTrack.removeEventListener("ended", onEnded);
    };
    cameraEndedCleanup = removeEndedListener;
    state.onCameraEnded = onEnded;
    videoTrack.mediaStreamTrack.addEventListener("ended", onEnded, { once: true });
    if (videoTrack.mediaStreamTrack.readyState === "ended") {
      await disableCamera(state, deps);
      return;
    }
    const choice = await resolveCodecChoice(
      videoTrack.mediaStreamTrack,
      cameraMaxFramerate(quality),
      CAMERA_PUBLISH_BITRATES[quality],
      channelPeerDecode,
    );
    const videoCodec = choice.codec;
    if ((state.generation ?? 0) !== generation || state.manualCameraTrack !== videoTrack) {
      // A disableCamera (or the track unplugging) ran to completion while
      // Auto's probe was pending: it already stopped this track and sent
      // voice_camera(false). Nothing is published yet, so just let go.
      removeEndedListener();
      videoTrack.stop();
      return;
    }
    setH264GpuProfiles(videoTrack.mediaStreamTrack, h264GpuPublish(videoCodec));
    await room.localParticipant.publishTrack(videoTrack, cameraPublishOptions(videoCodec, quality));
    if ((state.generation ?? 0) !== generation || state.manualCameraTrack !== videoTrack) {
      // A disableCamera (or the track unplugging) ran to completion while
      // publishTrack was in flight — it already reset localCamera, stopped the
      // track and sent voice_camera(false). The publish may have landed after
      // its unpublish, so undo it again, and stay silent: announcing
      // voice_camera(true) now would override the disable's final word on the
      // server.
      removeEndedListener();
      unpublishManualTrack(room, videoTrack);
      videoTrack.stop();
      if (state.manualCameraTrack === videoTrack) state.manualCameraTrack = null;
      return;
    }
    const sendId = ws.send({ type: "voice_camera", payload: { enabled: true } });
    registerPendingVideoEnable(sendId, "camera");
    state.announced = videoTrack;
    state.quality = quality;
    state.preferred = choice.preferred;
    state.published = videoCodec;
    deps.reapplyAudioPipeline();
    log.info("Camera enabled", {
      quality,
      maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
      codec: videoCodec,
    });
  } catch (err) {
    cameraEndedCleanup?.();
    if ((state.generation ?? 0) !== generation) {
      // A disableCamera (and possibly a newer enableCamera) already ran to
      // completion while this attempt's device acquisition/publish was in
      // flight. This attempt's own track, if any, was already released by
      // that disable — touching shared state now would stop/clear a live
      // track that belongs to a newer, successful enable.
      log.warn("Superseded camera enable failed — leaving newer attempt's state alone", err);
      return;
    }
    // Stop the created track to release the camera if publish failed.
    if (state.manualCameraTrack !== null) {
      state.manualCameraTrack.stop();
      state.manualCameraTrack = null;
    }
    state.announced = undefined;
    setLocalCamera(false);
    log.error("Failed to enable camera", err);
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      deps.onError(voiceText("share.cameraDenied"));
    } else if (err instanceof DOMException && err.name === "NotFoundError") {
      deps.onError(voiceText("share.noCamera"));
    } else {
      deps.onError(voiceText("share.cameraFailed"));
    }
  }
}

export async function disableCamera(state: CameraTrackState, deps: VideoTrackDeps): Promise<void> {
  // Bump first: a concurrent enableCamera that is still awaiting device
  // acquisition captured the pre-bump value and will detect it changed.
  bumpGeneration(state);
  const generation = state.generation ?? 0;
  const room = deps.getRoom();
  const ws = deps.getWs();
  try {
    stopManualCameraTrack(state, room);
    if (room !== null) await room.localParticipant.setCameraEnabled(false);
  } catch (err) {
    log.warn("Failed to disable camera track (non-fatal)", err);
  } finally {
    // Leaving/rejoining can finish before the SDK's old disable does. Its
    // completion must not clear or announce the new session's camera state.
    if ((state.generation ?? 0) === generation && deps.getRoom() === room && deps.getWs() === ws) {
      setLocalCamera(false);
      if (ws !== null) ws.send({ type: "voice_camera", payload: { enabled: false } });
      log.info("Camera disabled");
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshare track state
// ---------------------------------------------------------------------------

/** Mutable state for the manually published screenshare tracks. */
export interface ScreenTrackState extends GenerationGuarded {
  manualScreenTracks: LocalTrack[];
  screenTrackEndedCleanup?: () => void;
  /** The live share's quality, set once it is published: Change source and
   *  Quality act on a share only while it is set. On Linux it is the quality
   *  the native picker chose, and the track changes it itself. */
  quality?: StreamQuality;
  /** The live share's frame-rate choice (30 = the quality's own rate). */
  fps?: number;
  /** A Change source or Quality change is running. */
  changing?: boolean;
  /** The share's video track the server was last told is on. */
  announced?: LocalTrack;
  /** The codec the settings asked for, before peers were considered. */
  preferred?: PublishCodec;
  /** The codec the share's video is published with now. */
  published?: PublishCodec;
  /** The picker's "Share the app's sound" switch was on for this share
   *  (Windows web path). Change source reads it for the new window. */
  appAudioOn?: boolean;
  /** The app's sound going out as this share's audio, until the share stops. */
  appAudio?: AppAudioRelease;
}

/** What a share holds to end its app-audio capture (`lib/voice/appAudioShare.ts`,
 *  a lazy module: only this shape is needed on the stop paths). */
export interface AppAudioRelease {
  /** Close the page side, and stop the host capture unless a newer start
   *  already replaced it. Idempotent. */
  close(): void;
}

/** A share whose video track changes its own source under the publication
 *  (the Linux native capture, which picks in its own dialog). */
export interface InPlaceSourceChange {
  changeSource(): Promise<void>;
}

/** A share whose video track runs at a new quality by itself (the Linux native
 *  capture: the host re-sizes the running capture and republishes it). It
 *  carries the quality and frame rate it was picked at. `published` is the
 *  codec the share goes out with now. */
export interface InPlaceQualityChange {
  readonly quality: StreamQuality;
  readonly fps: number;
  setQuality(quality: StreamQuality, fps: number, published: PublishCodec): Promise<void>;
}

function qualityOf(track: LocalTrack | undefined): InPlaceQualityChange | null {
  const t = track as Partial<InPlaceQualityChange> | undefined;
  return typeof t?.setQuality === "function" && t.quality !== undefined && typeof t.fps === "number"
    ? (t as InPlaceQualityChange)
    : null;
}

/** The live share's video track when it changes quality by itself, else null. */
export function inPlaceQualityChange(state: ScreenTrackState): InPlaceQualityChange | null {
  return qualityOf(state.manualScreenTracks.find((t) => t.kind === Track.Kind.Video));
}

/** The live share's video track when it changes source by itself, else null. */
export function inPlaceSourceChange(state: ScreenTrackState): InPlaceSourceChange | null {
  const video = state.manualScreenTracks.find((t) => t.kind === Track.Kind.Video) as
    Partial<InPlaceSourceChange> | undefined;
  return typeof video?.changeSource === "function" ? (video as InPlaceSourceChange) : null;
}

/** Stop sharing when the OS ends the capture (its own Stop sharing bar), as
 *  long as this video track still carries `mst` for this share. A Change
 *  source moves the watch to the new capture. */
export function watchScreenEnded(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  videoTrack: LocalTrack,
  screenTracks: LocalTrack[],
  generation: number,
): () => void {
  const room = deps.getRoom();
  const ws = deps.getWs();
  const mst = videoTrack.mediaStreamTrack;
  const onEnded = (): void => {
    if (
      (state.generation ?? 0) !== generation ||
      state.manualScreenTracks !== screenTracks ||
      videoTrack.mediaStreamTrack !== mst ||
      deps.getRoom() !== room ||
      deps.getWs() !== ws
    ) {
      return;
    }
    log.info("Screen track ended externally (OS stop-sharing)");
    void disableScreenshare(state, deps);
  };
  const cleanup = (): void => {
    mst.removeEventListener("ended", onEnded);
    if (state.screenTrackEndedCleanup === cleanup) {
      state.screenTrackEndedCleanup = undefined;
    }
  };
  state.screenTrackEndedCleanup = cleanup;
  mst.addEventListener("ended", onEnded, { once: true });
  return cleanup;
}

export function stopManualScreenTracks(state: ScreenTrackState, room: Room | null): void {
  state.screenTrackEndedCleanup?.();
  // Every stop path ends here: the app's sound and the host capture go too.
  const appAudio = state.appAudio;
  state.appAudio = undefined;
  appAudio?.close();
  state.quality = undefined;
  state.fps = undefined;
  if (state.manualScreenTracks.length === 0 || room === null) return;
  const tracks = state.manualScreenTracks;
  state.manualScreenTracks = [];
  state.announced = undefined;
  state.preferred = undefined;
  state.published = undefined;
  for (const track of tracks) {
    unpublishManualTrack(room, track);
    track.stop();
  }
}

/** The web path's quality step before the OS picker: the saved
 *  defaults, overridden for this share by the dialog. Null when it was closed. */
async function pickWebShareQuality(
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

export async function enableScreenshare(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
): Promise<void> {
  const room = deps.getRoom();
  const ws = deps.getWs();
  if (room === null || ws === null) {
    log.warn("Cannot enable screenshare: no active voice session");
    deps.onError(voiceText("share.joinVoiceFirst"));
    return;
  }
  setLocalScreenshare(true);
  const generation = state.generation ?? 0;
  let quality = getScreenShareQuality();
  let fps = getScreenShareFps();
  let appAudioOn = false;
  // Linux picks inside its own capture; a headless run (no dialog registered)
  // keeps the saved defaults.
  const showPicker = isLinuxDesktop() ? null : getScreenSourcePicker();
  if (showPicker !== null) {
    const pick = await pickWebShareQuality(showPicker, quality, fps);
    if ((state.generation ?? 0) !== generation) return;
    if (pick === null) {
      // Closed before Go Live: nothing was captured or announced.
      setLocalScreenshare(false);
      return;
    }
    ({ quality, fps } = pick);
    appAudioOn = pick.appAudio;
  }
  const effectiveFps = getEffectiveScreenShareFps(quality, fps);
  const maxBitrate = getScreenShareMaxBitrate(quality, fps);
  let removeEndedListener: (() => void) | undefined;
  try {
    stopManualScreenTracks(state, room);
    // Linux captures in the native backend (no getDisplayMedia behind a
    // WebRTC-less webview): its room's picker-and-capture stands in and sets
    // the capture from the picker's per-share quality.
    const screenTracks = isLinuxDesktop()
      ? await room.localParticipant.createScreenTracks()
      : await createLocalScreenTracks(getScreenShareCaptureOptions(quality, fps));
    if ((state.generation ?? 0) !== generation) {
      // A disableScreenshare ran to completion while the OS picker was still
      // up — it already reset localScreenshare and sent voice_screenshare
      // (false). Publishing now would resurrect a share the user just ended.
      for (const t of screenTracks) t.stop();
      return;
    }
    state.manualScreenTracks = screenTracks;
    // The OS may stop capture while a publication is still awaiting the
    // server. Observe it before publishing, so remaining tracks (including
    // screen audio) cannot start after the user has already stopped sharing.
    const videoTrack = screenTracks.find((t) => t.kind === Track.Kind.Video);
    if (videoTrack !== undefined) {
      removeEndedListener = watchScreenEnded(state, deps, videoTrack, screenTracks, generation);
      if (videoTrack.mediaStreamTrack.readyState === "ended") {
        await disableScreenshare(state, deps);
        return;
      }
    }
    const choice: CodecChoice =
      videoTrack === undefined
        ? { preferred: "vp8", codec: "vp8" }
        : await resolveCodecChoice(
            videoTrack.mediaStreamTrack,
            effectiveFps,
            maxBitrate,
            channelPeerDecode,
          );
    const videoCodec = choice.codec;
    if ((state.generation ?? 0) !== generation || state.manualScreenTracks !== screenTracks) {
      // A disableScreenshare (or the OS stop-sharing button) ran to
      // completion while Auto's probe was pending: it already stopped these
      // tracks and sent voice_screenshare(false). Nothing is published yet.
      removeEndedListener?.();
      for (const t of screenTracks) t.stop();
      return;
    }
    if (videoTrack !== undefined)
      setH264GpuProfiles(videoTrack.mediaStreamTrack, h264GpuPublish(videoCodec));
    for (const track of screenTracks) {
      const isVideo = track.kind === Track.Kind.Video;
      // oxlint-disable-next-line no-await-in-loop -- tracks must be published sequentially to maintain correct order
      await room.localParticipant.publishTrack(track, {
        ...(isVideo
          ? screenVideoPublishOptions(videoCodec, quality, fps)
          : {
              source: Track.Source.ScreenShareAudio,
              simulcast: false,
              ...SCREENSHARE_AUDIO_PUBLISH,
            }),
      });
      if ((state.generation ?? 0) !== generation) {
        removeEndedListener?.();
        // A disableScreenshare ran to completion while that publish was in
        // flight — it already reset localScreenshare, sent voice_screenshare
        // (false) and emptied state.manualScreenTracks, so the tracks still
        // held by this attempt are unreachable from any later disable. Undo
        // every one of them here (a publish may have landed after the
        // disable's unpublish), and stay silent: announcing
        // voice_screenshare(true) now would override the disable's final
        // word on the server.
        for (const t of screenTracks) {
          unpublishManualTrack(room, t);
          t.stop();
        }
        if (state.manualScreenTracks === screenTracks) state.manualScreenTracks = [];
        return;
      }
    }
    state.appAudioOn = appAudioOn;
    if (
      appAudioOn &&
      videoTrack !== undefined &&
      !isLinuxDesktop() &&
      !screenTracks.some((t) => t.kind === Track.Kind.Audio)
    ) {
      // Windows web path: a shared window gets its app's sound. A
      // stop or newer share meanwhile has released everything it made.
      const outcome = await import("./appAudioShare")
        .then((m) =>
          m.publishAppAudio(state, room, screenTracks, videoTrack, generation, {
            ...SCREENSHARE_AUDIO_PUBLISH,
            source: Track.Source.ScreenShareAudio,
            simulcast: false,
          }),
        )
        .catch((err: unknown) => {
          log.warn("App audio unavailable; the video share goes on", err);
          return "done" as const;
        });
      if (outcome === "stale" || (state.generation ?? 0) !== generation) {
        removeEndedListener?.();
        return;
      }
    }
    const sendId = ws.send({ type: "voice_screenshare", payload: { enabled: true } });
    registerPendingVideoEnable(sendId, "screen");
    state.announced = videoTrack;
    state.preferred = choice.preferred;
    state.published = videoCodec;
    // The Linux native capture carries the quality and frame rate its own
    // picker chose, not the saved prefs.
    const nativeQuality = isLinuxDesktop() ? qualityOf(videoTrack) : null;
    if (nativeQuality !== null) {
      state.quality = nativeQuality.quality;
      state.fps = nativeQuality.fps;
    } else if (!isLinuxDesktop()) {
      state.quality = quality;
      state.fps = fps;
    }
    bumpLocalShareRev();
    deps.reapplyAudioPipeline();
    // The Linux native track carries the dialog's per-share encoding, which
    // replaces the saved prefs.
    const picked = (
      videoTrack as { publishEncoding?: { maxBitrate: number; maxFramerate: number } } | undefined
    )?.publishEncoding;
    log.info(
      "Screenshare enabled",
      picked !== undefined
        ? { fps: picked.maxFramerate, maxBitrate: picked.maxBitrate, codec: videoCodec }
        : { quality, fps: effectiveFps, maxBitrate, codec: videoCodec },
    );
  } catch (err) {
    removeEndedListener?.();
    if ((state.generation ?? 0) !== generation) {
      // A disableScreenshare (and possibly a newer enableScreenshare) already
      // ran to completion while this attempt's capture/publish was in
      // flight. This attempt's own tracks, if any, were already released by
      // that disable — calling stopManualScreenTracks now would unpublish
      // and stop tracks that belong to a newer, successful enable.
      log.warn("Superseded screenshare enable failed — leaving newer attempt's state alone", err);
      return;
    }
    // Release every created
    // track, not just stop() it — a track already published before a later
    // one in the batch fails (all quality presets request audio alongside
    // video) needs unpublishing too, or it stays orphaned in the room:
    // track.stop() is programmatic and never fires the DOM "ended" event, so
    // LiveKit's ended-driven auto-unpublish never runs. stopManualScreenTracks
    // does both and no-ops when nothing was created.
    stopManualScreenTracks(state, room);
    setLocalScreenshare(false);
    log.error("Failed to enable screenshare", err);
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      // The user closed the picker: not a failure and not a denial — stay
      // silent rather than reporting "permission denied" (polish #10).
      // The desktop portal cannot say whether the user cancelled or a
      // permission refused, so that case gets a soft notice covering both.
      if (err.message === PORTAL_NOT_STARTED)
        showToast(voiceText("share.screenNotStarted"), "info");
      else if (err.message !== PICKER_DISMISSED) deps.onError(voiceText("share.screenDenied"));
    } else {
      deps.onError(voiceText("share.screenFailed"));
    }
  }
}

export async function disableScreenshare(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
): Promise<void> {
  // Bump first: a concurrent enableScreenshare still awaiting the OS picker
  // captured the pre-bump value and will detect it changed.
  bumpGeneration(state);
  const generation = state.generation ?? 0;
  const room = deps.getRoom();
  const ws = deps.getWs();
  try {
    stopManualScreenTracks(state, room);
    if (room !== null) await room.localParticipant.setScreenShareEnabled(false);
  } catch (err) {
    log.warn("Failed to disable screenshare track (non-fatal)", err);
  } finally {
    if ((state.generation ?? 0) === generation && deps.getRoom() === room && deps.getWs() === ws) {
      setLocalScreenshare(false);
      if (ws !== null) ws.send({ type: "voice_screenshare", payload: { enabled: false } });
      log.info("Screenshare disabled");
    }
  }
}

// ---------------------------------------------------------------------------
// Live codec switch
// ---------------------------------------------------------------------------

/** Publish the live camera or share video again with `codec`, on the same
 *  capture. livekit-client 2.22.3 cannot change a published codec in place and
 *  E2EE allows no backup codec, so the track is unpublished without stopping
 *  it (the room default would stop it, and a stopped share would reopen the OS
 *  picker) and published again with the same options but for the codec. No
 *  `voice_camera`/`voice_screenshare` is sent: the server flag stays on and the
 *  server ignores track unpublishes. Screen audio stays published.
 *
 *  Superseded, not cancelled: after each await a stop, a leave, a reconnect or
 *  a new socket (`generation`, `getRoom()`, `getWs()`) ends the run, and a
 *  publish that lands after a stop is undone as the enable does. A failed
 *  republish takes the normal disable path, so no half state is left.
 *  Resolves true when the track now carries `codec`. */
export function republishVideo(
  kind: "camera",
  state: CameraTrackState,
  deps: VideoTrackDeps,
  codec: PublishCodec,
): Promise<boolean>;
export function republishVideo(
  kind: "screen",
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  codec: PublishCodec,
): Promise<boolean>;
export async function republishVideo(
  kind: "camera" | "screen",
  state: CameraTrackState | ScreenTrackState,
  deps: VideoTrackDeps,
  codec: PublishCodec,
): Promise<boolean> {
  const room = deps.getRoom();
  const ws = deps.getWs();
  const live =
    kind === "camera"
      ? liveCameraVideo(state as CameraTrackState)
      : liveShareVideo(state as ScreenTrackState);
  if (room === null || ws === null || live === null || live.quality === undefined) return false;
  if (kind === "screen" && (state as ScreenTrackState).changing === true) return false;
  const { track, quality } = live;
  const generation = state.generation ?? 0;
  const stale = (): boolean =>
    (state.generation ?? 0) !== generation ||
    deps.getRoom() !== room ||
    deps.getWs() !== ws ||
    (kind === "camera"
      ? (state as CameraTrackState).manualCameraTrack !== track
      : (state as ScreenTrackState).announced !== track);
  const options =
    kind === "camera"
      ? cameraPublishOptions(codec, quality)
      : screenVideoPublishOptions(
          codec,
          quality,
          (state as ScreenTrackState).fps ?? getScreenShareFps(),
        );
  // A Change source or Quality change must not start under the republish.
  if (kind === "screen") (state as ScreenTrackState).changing = true;
  try {
    await room.localParticipant.unpublishTrack(track, false);
    // A stop between the two awaits already unpublished and stopped the track
    // and sent its `false`: publishing now would resurrect it.
    if (stale()) return false;
    setH264GpuProfiles(track.mediaStreamTrack, h264GpuPublish(codec));
    await room.localParticipant.publishTrack(track, options);
    if (stale()) {
      // The stop's unpublish may have run before this publish landed: undo it
      // again and stay silent, so no `true` reaches the server.
      unpublishManualTrack(room, track);
      track.stop();
      return false;
    }
    state.published = codec;
    if (kind === "screen") bumpLocalShareRev();
    log.info("Republished with a codec every viewer plays", { kind, codec });
    return true;
  } catch (err) {
    if (stale()) {
      log.warn("Superseded codec switch failed, leaving the newer state alone", err);
      return false;
    }
    log.error("Failed to republish with a new codec", { kind, codec, err });
    if (kind === "camera") {
      await disableCamera(state as CameraTrackState, deps);
      deps.onError(voiceText("share.cameraFailed"));
    } else {
      await disableScreenshare(state as ScreenTrackState, deps);
      deps.onError(voiceText("share.screenFailed"));
    }
    return false;
  } finally {
    if (kind === "screen") (state as ScreenTrackState).changing = false;
  }
}

/** What the live codec switch needs of a published video: the codec the
 *  settings asked for, the one it goes out with, and whether a Change source or
 *  Quality change is running under it. */
export interface LiveCodec {
  readonly preferred: PublishCodec;
  readonly published: PublishCodec;
  readonly busy: boolean;
}

/** The camera's codecs while it is published and announced, else null (it is
 *  starting, stopping or not on). */
export function cameraLiveCodec(state: CameraTrackState): LiveCodec | null {
  const live = liveCameraVideo(state);
  if (live === null || live.quality === undefined) return null;
  if (state.preferred === undefined || state.published === undefined) return null;
  return { preferred: state.preferred, published: state.published, busy: false };
}

/** The share's codecs while its video is published and announced, else null. */
export function screenLiveCodec(state: ScreenTrackState): LiveCodec | null {
  const live = liveShareVideo(state);
  if (live === null || live.quality === undefined) return null;
  if (state.preferred === undefined || state.published === undefined) return null;
  return {
    preferred: state.preferred,
    published: state.published,
    busy: state.changing === true,
  };
}

/** The announced camera video and its quality, or null while it starts or stops. */
function liveCameraVideo(
  state: CameraTrackState,
): { track: LocalVideoTrack; quality: StreamQuality | undefined } | null {
  const track = state.manualCameraTrack;
  if (track === null || state.announced !== track) return null;
  return { track: track as LocalVideoTrack, quality: state.quality };
}

/** The announced share video and its quality, or null while it starts or stops. */
function liveShareVideo(
  state: ScreenTrackState,
): { track: LocalVideoTrack; quality: StreamQuality | undefined } | null {
  const track = state.announced;
  if (track === undefined || !state.manualScreenTracks.includes(track)) return null;
  return { track: track as LocalVideoTrack, quality: state.quality };
}

/** Bring the server's camera and share flags from `ready` back in line with
 *  what this session sends. A live track the server lost track of (its
 *  announce went out while the socket was down) is announced again, and the
 *  server may still refuse it, which rolls it back. A flag still on for a
 *  track already stopped is turned off. A toggle in flight sends its own. */
export function reconcileVideoFlags(
  camera: CameraTrackState,
  screen: ScreenTrackState,
  deps: VideoTrackDeps,
  server: { readonly camera: boolean; readonly screenshare: boolean },
): void {
  const ws = deps.getWs();
  if (ws === null) return;
  const { localCamera, localScreenshare } = voiceStore.getState();
  const cameraLive =
    camera.manualCameraTrack !== null && camera.announced === camera.manualCameraTrack;
  if (cameraLive && !server.camera) {
    registerPendingVideoEnable(
      ws.send({ type: "voice_camera", payload: { enabled: true } }),
      "camera",
    );
  } else if (!localCamera && server.camera) {
    ws.send({ type: "voice_camera", payload: { enabled: false } });
  }
  const shareLive =
    screen.announced !== undefined && screen.manualScreenTracks.includes(screen.announced);
  if (shareLive && !server.screenshare) {
    registerPendingVideoEnable(
      ws.send({ type: "voice_screenshare", payload: { enabled: true } }),
      "screen",
    );
  } else if (!localScreenshare && server.screenshare) {
    ws.send({ type: "voice_screenshare", payload: { enabled: false } });
  }
}

// ---------------------------------------------------------------------------
// Stream getters
// ---------------------------------------------------------------------------

export function getLocalCameraStream(room: Room | null): MediaStream | null {
  if (room === null) return null;
  const cameraPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if (cameraPub?.track?.mediaStreamTrack)
    return new MediaStream([cameraPub.track.mediaStreamTrack]);
  return null;
}

export function getLocalScreenshareStream(room: Room | null): MediaStream | null {
  if (room === null) return null;
  const screenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if (screenPub?.track?.mediaStreamTrack)
    return new MediaStream([screenPub.track.mediaStreamTrack]);
  return null;
}

/** What your screen share is sending and why it falls short (its own tile's
 *  readout), or null where the track has no sender stats (the Linux
 *  native track publishes in the backend) or nothing is shared. */
export function getLocalScreenshareStats(room: Room | null): Promise<ShareSenderSample | null> {
  const track = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as
    SenderStatsTrack | undefined;
  return readSenderSample(track);
}
