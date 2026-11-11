/**
 * Ending a screen share: the OS stop-sharing watch, the track cleanup every
 * stop path ends in, and the disable that announces it.
 */

import type { LocalTrack } from "livekit-client";
import { setLocalScreenshare } from "./shareHostLinks";
import { createLogger } from "@lib/logger";
import { recordEvent } from "@lib/diagnostics/eventSink";
import {
  bumpGeneration,
  unpublishManualTrack,
  type ScreenTrackState,
  type VideoTrackDeps,
} from "./videoTrackState";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

const log = createLogger("screenShare");

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
    recordEvent("share.ended");
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

export function stopManualScreenTracks(state: ScreenTrackState, room: VoiceRoom | null): void {
  state.screenTrackEndedCleanup?.();
  state.stopResolutionRecovery?.();
  state.stopResolutionRecovery = undefined;
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
