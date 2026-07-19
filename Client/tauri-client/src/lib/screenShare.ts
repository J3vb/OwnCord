/**
 * Screen share and camera track management — extracted from livekitSession.ts.
 *
 * Provides stream quality presets and functions for publishing/unpublishing
 * local camera and screenshare tracks via a LiveKit Room.
 */

import {
  Track,
  VideoPresets,
  ScreenSharePresets,
  createLocalScreenTracks,
  createLocalVideoTrack,
  type Room,
  type LocalVideoTrack,
  type LocalTrack,
  type VideoCaptureOptions,
  type ScreenShareCaptureOptions,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import { setLocalCamera, setLocalScreenshare } from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";

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

export const SCREENSHARE_PRESETS: Record<StreamQuality, ScreenShareCaptureOptions> = {
  low: { audio: true, resolution: ScreenSharePresets.h720fps5.resolution },
  medium: {
    audio: true,
    resolution: ScreenSharePresets.h1080fps15.resolution,
    contentHint: "detail",
  },
  high: {
    audio: true,
    resolution: ScreenSharePresets.h1080fps30.resolution,
    contentHint: "detail",
  },
  source: { audio: true, contentHint: "detail" }, // no resolution cap — use native source resolution
};

export const SCREENSHARE_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low: 1_500_000,
  medium: 3_000_000,
  high: 6_000_000,
  source: 10_000_000,
};

export function getStreamQuality(): StreamQuality {
  const saved = loadPref<string>("streamQuality", "high");
  if (saved === "low" || saved === "medium" || saved === "high" || saved === "source") return saved;
  return "high";
}

// ---------------------------------------------------------------------------
// Screen share frame rate
// ---------------------------------------------------------------------------

/** Saved screen share FPS preference. 30 is the default and preserves the
 *  historical per-quality caps (5/15/30); 60/120 are explicit overrides. */
export function getScreenShareFps(): number {
  const saved = loadPref<number>("screenShareFps", 30);
  return saved === 60 || saved === 120 ? saved : 30;
}

/** Effective capture/publish frame rate for a quality + fps preference. */
export function getEffectiveScreenShareFps(quality: StreamQuality, fps: number): number {
  if (fps !== 60 && fps !== 120) {
    return quality === "low" ? 5 : quality === "medium" ? 15 : 30;
  }
  return fps;
}

/** High frame rates need proportionally more bitrate to stay sharp. */
const FPS_BITRATE_MULTIPLIER: Readonly<Record<number, number>> = { 60: 1.5, 120: 2 };

export function getScreenShareMaxBitrate(quality: StreamQuality, fps: number): number {
  const multiplier = FPS_BITRATE_MULTIPLIER[fps] ?? 1;
  return Math.round(SCREENSHARE_PUBLISH_BITRATES[quality] * multiplier);
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
// Camera track state
// ---------------------------------------------------------------------------

/** Mutable state for the manually published camera track. */
export interface CameraTrackState {
  manualCameraTrack: LocalVideoTrack | null;
}

export function stopManualCameraTrack(state: CameraTrackState, room: Room | null): void {
  if (state.manualCameraTrack === null || room === null) return;
  const track = state.manualCameraTrack;
  state.manualCameraTrack = null;
  try {
    void room.localParticipant.unpublishTrack(track.mediaStreamTrack);
  } catch {
    /* already unpublished */
  }
  track.stop();
}

export async function enableCamera(state: CameraTrackState, deps: VideoTrackDeps): Promise<void> {
  const room = deps.getRoom();
  const ws = deps.getWs();
  if (room === null || ws === null) {
    log.warn("Cannot enable camera: no active voice session");
    deps.onError("Join a voice channel first");
    return;
  }
  setLocalCamera(true);
  const quality = getStreamQuality();
  try {
    const savedVideoDevice = loadPref<string>("videoInputDevice", "");
    stopManualCameraTrack(state, room);
    const videoTrack = await createLocalVideoTrack({
      ...CAMERA_PRESETS[quality],
      ...(savedVideoDevice ? { deviceId: savedVideoDevice } : {}),
    });
    state.manualCameraTrack = videoTrack;
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.Camera,
      simulcast: quality !== "source",
      videoEncoding: {
        maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
        maxFramerate: quality === "low" ? 15 : 30,
      },
    });
    ws.send({ type: "voice_camera", payload: { enabled: true } });
    deps.reapplyAudioPipeline();
    log.info("Camera enabled", { quality, maxBitrate: CAMERA_PUBLISH_BITRATES[quality] });
  } catch (err) {
    // BUG-100: Stop the created track to release the camera if publish failed.
    if (state.manualCameraTrack !== null) {
      state.manualCameraTrack.stop();
      state.manualCameraTrack = null;
    }
    setLocalCamera(false);
    log.error("Failed to enable camera", err);
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      deps.onError("Camera permission denied");
    } else if (err instanceof DOMException && err.name === "NotFoundError") {
      deps.onError("No camera found");
    } else {
      deps.onError("Failed to start camera");
    }
  }
}

export async function disableCamera(state: CameraTrackState, deps: VideoTrackDeps): Promise<void> {
  const room = deps.getRoom();
  try {
    stopManualCameraTrack(state, room);
    if (room !== null) await room.localParticipant.setCameraEnabled(false);
  } catch (err) {
    log.warn("Failed to disable camera track (non-fatal)", err);
  } finally {
    setLocalCamera(false);
    const ws = deps.getWs();
    if (ws !== null) ws.send({ type: "voice_camera", payload: { enabled: false } });
    log.info("Camera disabled");
  }
}

// ---------------------------------------------------------------------------
// Screenshare track state
// ---------------------------------------------------------------------------

/** Mutable state for the manually published screenshare tracks. */
export interface ScreenTrackState {
  manualScreenTracks: LocalTrack[];
}

export function stopManualScreenTracks(state: ScreenTrackState, room: Room | null): void {
  if (state.manualScreenTracks.length === 0 || room === null) return;
  const tracks = state.manualScreenTracks;
  state.manualScreenTracks = [];
  for (const track of tracks) {
    try {
      void room.localParticipant.unpublishTrack(track.mediaStreamTrack);
    } catch {
      /* already unpublished */
    }
    track.stop();
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
    deps.onError("Join a voice channel first");
    return;
  }
  setLocalScreenshare(true);
  const quality = getStreamQuality();
  const fps = getScreenShareFps();
  const effectiveFps = getEffectiveScreenShareFps(quality, fps);
  const maxBitrate = getScreenShareMaxBitrate(quality, fps);
  try {
    stopManualScreenTracks(state, room);
    const screenTracks = await createLocalScreenTracks(getScreenShareCaptureOptions(quality, fps));
    state.manualScreenTracks = screenTracks;
    for (const track of screenTracks) {
      const isVideo = track.kind === Track.Kind.Video;
      // oxlint-disable-next-line no-await-in-loop -- tracks must be published sequentially to maintain correct order
      await room.localParticipant.publishTrack(track, {
        source: isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
        simulcast: false,
        ...(isVideo
          ? {
              videoEncoding: {
                maxBitrate,
                maxFramerate: effectiveFps,
              },
            }
          : {}),
      });
    }
    // BUG-101: Listen for OS "Stop sharing" so the app runs the full disable path.
    const videoTrack = screenTracks.find((t) => t.kind === Track.Kind.Video);
    if (videoTrack) {
      videoTrack.mediaStreamTrack.addEventListener(
        "ended",
        () => {
          log.info("Screen track ended externally (OS stop-sharing)");
          void disableScreenshare(state, deps);
        },
        { once: true },
      );
    }
    ws.send({ type: "voice_screenshare", payload: { enabled: true } });
    deps.reapplyAudioPipeline();
    log.info("Screenshare enabled", { quality, fps: effectiveFps, maxBitrate });
  } catch (err) {
    // BUG-100: Stop created tracks to release screen capture if publish failed.
    for (const t of state.manualScreenTracks) {
      t.stop();
    }
    state.manualScreenTracks = [];
    setLocalScreenshare(false);
    log.error("Failed to enable screenshare", err);
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      deps.onError("Screen sharing permission denied");
    } else {
      deps.onError("Failed to start screen sharing");
    }
  }
}

export async function disableScreenshare(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
): Promise<void> {
  const room = deps.getRoom();
  try {
    stopManualScreenTracks(state, room);
    if (room !== null) await room.localParticipant.setScreenShareEnabled(false);
  } catch (err) {
    log.warn("Failed to disable screenshare track (non-fatal)", err);
  } finally {
    setLocalScreenshare(false);
    const ws = deps.getWs();
    if (ws !== null) ws.send({ type: "voice_screenshare", payload: { enabled: false } });
    log.info("Screenshare disabled");
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

export function getRemoteVideoStream(
  room: Room | null,
  userId: number,
  type: "camera" | "screenshare",
): MediaStream | null {
  if (room === null) return null;
  const source = type === "screenshare" ? Track.Source.ScreenShare : Track.Source.Camera;
  // Iterate remote participants — identity may include a ":token" suffix
  // (e.g. "user-42:abc123") so exact getParticipantByIdentity won't match.
  for (const participant of room.remoteParticipants.values()) {
    const match = participant.identity.match(/^user-(\d+)(?::|$)/);
    if (match !== null && parseInt(match[1]!, 10) === userId) {
      const pub = participant.getTrackPublication(source);
      if (pub?.track?.mediaStreamTrack) return new MediaStream([pub.track.mediaStreamTrack]);
      return null;
    }
  }
  return null;
}
