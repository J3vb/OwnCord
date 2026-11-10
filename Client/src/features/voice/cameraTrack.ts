/**
 * The manually published camera track: enable, disable and the cleanup
 * both share.
 */

import type { Room, LocalVideoTrack } from "livekit-client";
import type { WsClient } from "@lib/ws";
import { loadPref } from "@lib/prefs/preferences";
import { setH264GpuProfiles } from "@lib/voice/h264Profile";
import { createLogger } from "@lib/logger";
import { createCameraTrack, hasCameraTracks } from "../../lib/voice/videoCapture";
import { voiceText } from "../../i18n/voice";
import type { CodecChoice } from "./videoCodec";
import {
  channelPeerDecode,
  h264GpuPublish,
  nativeCameraSupport,
  resolveCodecChoice,
  setLocalCamera,
} from "./shareHostLinks";
import {
  CAMERA_PUBLISH_BITRATES,
  cameraMaxFramerate,
  cameraPublishOptions,
  getCameraQuality,
  type StreamQuality,
} from "../../lib/voice/videoPresets";
import {
  bumpGeneration,
  registerPendingVideoEnable,
  unpublishManualTrack,
  type CameraTrackState,
  type VideoTrackDeps,
} from "./videoTrackState";
import { clampPublishedVideo, presetRate } from "./videoCapFollow";
import { liveVideoBudget } from "./videoBudgetNow";

const log = createLogger("screenShare");

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

/** Linux captures in the backend, which needs GStreamer's camera elements:
 *  without them no capture can ever start, so name the missing support
 *  rather than failing later with a generic "no camera". False when the
 *  enable stops here. */
function nativeCameraReady(
  state: CameraTrackState,
  generation: number,
  deps: VideoTrackDeps,
  support: Awaited<ReturnType<typeof nativeCameraSupport>>,
): boolean {
  if ((state.generation ?? 0) !== generation) return false;
  if (support !== null && !support.available) {
    log.warn("Cannot enable camera: native camera support is missing", support.missing);
    deps.onError(voiceText("share.gstreamerMissing"));
    setLocalCamera(false);
    return false;
  }
  return true;
}

/** The `ended` listener is per-track and self-scoped: it acts only while
 *  this track is still the reported camera, independent of any other stop
 *  path. Returns its remover. */
function watchCameraEnded(
  state: CameraTrackState,
  deps: VideoTrackDeps,
  videoTrack: LocalVideoTrack,
  generation: number,
  room: Room,
  ws: WsClient,
): () => void {
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
  state.onCameraEnded = onEnded;
  videoTrack.mediaStreamTrack.addEventListener("ended", onEnded, { once: true });
  return (): void => {
    videoTrack.mediaStreamTrack.removeEventListener("ended", onEnded);
  };
}

/** Tell the server the camera is on, and record what went out. */
function announceCamera(
  state: CameraTrackState,
  ws: WsClient,
  deps: VideoTrackDeps,
  videoTrack: LocalVideoTrack,
  quality: StreamQuality,
  choice: CodecChoice,
): void {
  const sendId = ws.send({ type: "voice_camera", payload: { enabled: true } });
  registerPendingVideoEnable(sendId, "camera");
  state.announced = videoTrack;
  state.quality = quality;
  state.preferred = choice.preferred;
  state.published = choice.codec;
  deps.reapplyAudioPipeline();
  log.info("Camera enabled", {
    quality,
    maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
    codec: choice.codec,
  });
}

function failCameraEnable(
  state: CameraTrackState,
  generation: number,
  deps: VideoTrackDeps,
  err: unknown,
): void {
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

export async function enableCamera(state: CameraTrackState, deps: VideoTrackDeps): Promise<void> {
  const room = deps.getRoom();
  const ws = deps.getWs();
  if (room === null || ws === null) {
    log.warn("Cannot enable camera: no active voice session");
    deps.onError(voiceText("share.joinVoiceFirst"));
    return;
  }
  const generation = state.generation ?? 0;
  const stale = (): boolean => (state.generation ?? 0) !== generation;
  setLocalCamera(true);
  const quality = getCameraQuality();
  let cameraEndedCleanup: (() => void) | undefined;
  try {
    if (
      hasCameraTracks(room.localParticipant) &&
      !nativeCameraReady(state, generation, deps, await nativeCameraSupport())
    ) {
      return;
    }
    const savedVideoDevice = loadPref<string>("videoInputDevice", "");
    stopManualCameraTrack(state, room);
    const videoTrack = await createCameraTrack(room, quality, savedVideoDevice);
    if (stale()) {
      // A disableCamera ran to completion while getUserMedia was pending —
      // it already reset localCamera and sent voice_camera(false).
      // Publishing now would resurrect a track the user just turned off.
      videoTrack.stop();
      return;
    }
    state.manualCameraTrack = videoTrack;
    const removeEndedListener = watchCameraEnded(state, deps, videoTrack, generation, room, ws);
    cameraEndedCleanup = removeEndedListener;
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
    if (stale() || state.manualCameraTrack !== videoTrack) {
      // A disableCamera (or the track unplugging) ran to completion while
      // Auto's probe was pending: it already stopped this track and sent
      // voice_camera(false). Nothing is published yet, so just let go.
      removeEndedListener();
      videoTrack.stop();
      return;
    }
    setH264GpuProfiles(videoTrack.mediaStreamTrack, h264GpuPublish(videoCodec));
    await room.localParticipant.publishTrack(
      videoTrack,
      cameraPublishOptions(videoCodec, quality, liveVideoBudget().camera),
    );
    if (stale() || state.manualCameraTrack !== videoTrack) {
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
    announceCamera(state, ws, deps, videoTrack, quality, choice);
    void clampPublishedVideo(videoTrack, "camera", presetRate("camera", quality));
  } catch (err) {
    cameraEndedCleanup?.();
    failCameraEnable(state, generation, deps, err);
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
