/**
 * Screen share and camera track management: the public facade over the
 * camera, screen share and republish modules in this folder, plus the stream
 * getters.
 *
 * Provides stream quality presets and functions for publishing/unpublishing
 * local camera and screenshare tracks via a LiveKit Room.
 */

import { type Room, Track } from "livekit-client";
import type { ShareSenderSample, SenderStatsTrack } from "../../features/voice/shareSenderStats";
import { readSenderSample } from "./shareHostLinks";
export {
  CAMERA_PRESETS,
  CAMERA_PUBLISH_BITRATES,
  cameraSimulcastLayers,
  videoLayerOptions,
  cameraPublishOptions,
  SCREENSHARE_AUDIO_PUBLISH,
  SCREENSHARE_PRESETS,
  SCREENSHARE_PUBLISH_BITRATES,
  getCameraQuality,
  getScreenShareQuality,
  isScreenShareSimulcast,
  SCREENSHARE_SIMULCAST_LAYERS,
  getScreenShareFps,
  getEffectiveScreenShareFps,
  screenShareDegradation,
  getScreenShareMaxBitrate,
  screenVideoPublishOptions,
  getScreenShareCaptureOptions,
} from "./videoPresets";
export type { StreamQuality } from "./videoPresets";

export {
  bumpGeneration,
  rollbackPendingVideo,
  unpublishManualTrack,
  inPlaceQualityChange,
  inPlaceSourceChange,
  type VideoTrackDeps,
  type CameraTrackState,
  type ScreenTrackState,
  type AppAudioRelease,
  type InPlaceSourceChange,
  type InPlaceQualityChange,
} from "./videoTrackState";
export { stopManualCameraTrack, enableCamera, disableCamera } from "./cameraTrack";
export { watchScreenEnded, stopManualScreenTracks, disableScreenshare } from "./screenTrackStop";
export { enableScreenshare } from "./screenTrackEnable";
export {
  republishVideo,
  cameraLiveCodec,
  screenLiveCodec,
  reconcileVideoFlags,
  type LiveCodec,
} from "./videoRepublish";

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

/** Sender evidence for camera encoder checks, using the same stats reader as shares. */
export function getLocalCameraStats(room: Room | null): Promise<ShareSenderSample | null> {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track as
    SenderStatsTrack | undefined;
  return readSenderSample(track);
}
