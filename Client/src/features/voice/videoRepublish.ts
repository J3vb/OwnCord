/**
 * The live codec switch for a published camera or share, and the
 * reconciliation of the server's video flags with the local tracks.
 */

import type { LocalVideoTrack, LocalTrack, TrackPublishOptions } from "livekit-client";
import { setH264GpuProfiles } from "@lib/voice/h264Profile";
import { createLogger } from "@lib/logger";
import { voiceText } from "../../i18n/voice";
import type { PublishCodec } from "./videoCodec";
import { bumpLocalShareRev, h264GpuPublish, isLinuxDesktop, voiceStore } from "./shareHostLinks";
import {
  cameraPublishOptions,
  getScreenShareCaptureOptions,
  applyScreenShareContentHint,
  getScreenShareFps,
  screenVideoPublishOptions,
  type StreamQuality,
} from "../../lib/voice/videoPresets";
import {
  registerPendingVideoEnable,
  unpublishManualTrack,
  type CameraTrackState,
  type ScreenTrackState,
  type VideoTrackDeps,
} from "./videoTrackState";
import { disableCamera } from "./cameraTrack";
import { disableScreenshare } from "./screenTrackStop";

const log = createLogger("screenShare");

/** The live video a republish acts on, with its quality: null while it is
 *  starting, stopping or not on, or (a share) while a Change source or
 *  Quality change runs. */
function republishTarget(
  kind: "camera" | "screen",
  state: CameraTrackState | ScreenTrackState,
): { track: LocalTrack; quality: StreamQuality } | null {
  const live =
    kind === "camera"
      ? liveCameraVideo(state as CameraTrackState)
      : liveShareVideo(state as ScreenTrackState);
  if (live === null || live.quality === undefined) return null;
  if (kind === "screen" && (state as ScreenTrackState).changing === true) return null;
  return { track: live.track, quality: live.quality };
}

/** The publish options a republish keeps, but for the codec. */
function republishOptions(
  kind: "camera" | "screen",
  state: CameraTrackState | ScreenTrackState,
  codec: PublishCodec,
  quality: StreamQuality,
): TrackPublishOptions {
  return kind === "camera"
    ? cameraPublishOptions(codec, quality)
    : screenVideoPublishOptions(
        codec,
        quality,
        (state as ScreenTrackState).fps ?? getScreenShareFps(),
      );
}

function hintShareRepublish(
  state: ScreenTrackState,
  track: LocalTrack,
  quality: StreamQuality,
  codec: PublishCodec,
): void {
  if (isLinuxDesktop()) return;
  applyScreenShareContentHint(
    track.mediaStreamTrack,
    getScreenShareCaptureOptions(quality, state.fps ?? getScreenShareFps()),
    codec,
  );
}

/** A failed republish takes the normal disable path, so no half state is left. */
async function failRepublish(
  kind: "camera" | "screen",
  state: CameraTrackState | ScreenTrackState,
  deps: VideoTrackDeps,
): Promise<void> {
  if (kind === "camera") {
    await disableCamera(state as CameraTrackState, deps);
    deps.onError(voiceText("share.cameraFailed"));
  } else {
    await disableScreenshare(state as ScreenTrackState, deps);
    deps.onError(voiceText("share.screenFailed"));
  }
}

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
  const live = republishTarget(kind, state);
  if (room === null || ws === null || live === null) return false;
  const { track, quality } = live;
  const generation = state.generation ?? 0;
  const stale = (): boolean =>
    (state.generation ?? 0) !== generation ||
    deps.getRoom() !== room ||
    deps.getWs() !== ws ||
    (kind === "camera"
      ? (state as CameraTrackState).manualCameraTrack !== track
      : (state as ScreenTrackState).announced !== track);
  const options = republishOptions(kind, state, codec, quality);
  // A Change source or Quality change must not start under the republish.
  if (kind === "screen") (state as ScreenTrackState).changing = true;
  try {
    await room.localParticipant.unpublishTrack(track, false);
    // A stop between the two awaits already unpublished and stopped the track
    // and sent its `false`: publishing now would resurrect it.
    if (stale()) return false;
    if (kind === "screen") hintShareRepublish(state as ScreenTrackState, track, quality, codec);
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
    await failRepublish(kind, state, deps);
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
