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
  const generation = state.generation ?? 0;
  try {
    const savedVideoDevice = loadPref<string>("videoInputDevice", "");
    stopManualCameraTrack(state, room);
    const videoTrack = await createLocalVideoTrack({
      ...CAMERA_PRESETS[quality],
      ...(savedVideoDevice ? { deviceId: savedVideoDevice } : {}),
    });
    if ((state.generation ?? 0) !== generation) {
      // A disableCamera ran to completion while getUserMedia was pending —
      // it already reset localCamera and sent voice_camera(false).
      // Publishing now would resurrect a track the user just turned off.
      videoTrack.stop();
      return;
    }
    state.manualCameraTrack = videoTrack;
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.Camera,
      simulcast: quality !== "source",
      videoEncoding: {
        maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
        maxFramerate: quality === "low" ? 15 : 30,
      },
    });
    if ((state.generation ?? 0) !== generation) {
      // A disableCamera ran to completion while publishTrack was in flight —
      // it already reset localCamera and sent voice_camera(false). The publish
      // may have landed after its unpublish, so undo it again, and stay silent:
      // announcing voice_camera(true) now would override the disable's final
      // word on the server.
      try {
        void room.localParticipant.unpublishTrack(videoTrack.mediaStreamTrack);
      } catch {
        /* already unpublished */
      }
      videoTrack.stop();
      if (state.manualCameraTrack === videoTrack) state.manualCameraTrack = null;
      return;
    }
    const sendId = ws.send({ type: "voice_camera", payload: { enabled: true } });
    registerPendingVideoEnable(sendId, "camera");
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
  // Bump first: a concurrent enableCamera that is still awaiting device
  // acquisition captured the pre-bump value and will detect it changed.
  bumpGeneration(state);
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
export interface ScreenTrackState extends GenerationGuarded {
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
  const generation = state.generation ?? 0;
  try {
    stopManualScreenTracks(state, room);
    const screenTracks = await createLocalScreenTracks(getScreenShareCaptureOptions(quality, fps));
    if ((state.generation ?? 0) !== generation) {
      // A disableScreenshare ran to completion while the OS picker was still
      // up — it already reset localScreenshare and sent voice_screenshare
      // (false). Publishing now would resurrect a share the user just ended.
      for (const t of screenTracks) t.stop();
      return;
    }
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
      if ((state.generation ?? 0) !== generation) {
        // A disableScreenshare ran to completion while that publish was in
        // flight — it already reset localScreenshare, sent voice_screenshare
        // (false) and emptied state.manualScreenTracks, so the tracks still
        // held by this attempt are unreachable from any later disable. Undo
        // every one of them here (a publish may have landed after the
        // disable's unpublish), and stay silent: announcing
        // voice_screenshare(true) now would override the disable's final
        // word on the server.
        for (const t of screenTracks) {
          try {
            void room.localParticipant.unpublishTrack(t.mediaStreamTrack);
          } catch {
            /* already unpublished */
          }
          t.stop();
        }
        if (state.manualScreenTracks === screenTracks) state.manualScreenTracks = [];
        return;
      }
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
    const sendId = ws.send({ type: "voice_screenshare", payload: { enabled: true } });
    registerPendingVideoEnable(sendId, "screen");
    deps.reapplyAudioPipeline();
    log.info("Screenshare enabled", { quality, fps: effectiveFps, maxBitrate });
  } catch (err) {
    // BUG-100 (+ partial-publish-failure hardening): release every created
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
  // Bump first: a concurrent enableScreenshare still awaiting the OS picker
  // captured the pre-bump value and will detect it changed.
  bumpGeneration(state);
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
