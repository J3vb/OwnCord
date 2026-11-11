/**
 * The shared shapes of the camera and screen share tracks: the state each one
 * keeps, the dependencies the session hands in, the supersession counter and
 * the correlation that lets a server refusal roll a published track back.
 */

import type { LocalVideoTrack, LocalTrack } from "livekit-client";
import { Track } from "livekit-client";
import type { WsClient } from "@lib/ws";
import { createLogger } from "@lib/logger";
import type { NativeCameraTrack } from "./native/nativeCameraTrack";
import type { PublishCodec } from "./videoCodec";
import type { StreamQuality } from "../../lib/voice/videoPresets";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

const log = createLogger("screenShare");

export interface VideoTrackDeps {
  readonly getRoom: () => VoiceRoom | null;
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

export function registerPendingVideoEnable(id: string, kind: "camera" | "screen"): void {
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

/** Unpublishing can reject later during WebRTC renegotiation. Track cleanup
 *  must proceed immediately and contain that asynchronous failure too. Takes
 *  any track with a `mediaStreamTrack` (browser `LocalTrack` or a native
 *  camera/screen track). */
export function unpublishManualTrack(
  room: VoiceRoom,
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

/** Mutable state for the manually published screenshare tracks. */
export interface ScreenTrackState extends GenerationGuarded {
  manualScreenTracks: LocalTrack[];
  screenTrackEndedCleanup?: () => void;
  /** Stops the published share's resolution-recovery watcher. */
  stopResolutionRecovery?: () => void;
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

export function qualityOf(track: LocalTrack | undefined): InPlaceQualityChange | null {
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
