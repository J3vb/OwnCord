/**
 * Change source and Quality for a live screen share, loaded on first
 * use from the stream card.
 *
 * Change source swaps the capture under the published track
 * (`LocalTrack.replaceTrack`), so the publication and its sid stay: viewers
 * keep watching, and the server hears no `voice_screenshare` at all. Quality
 * re-sizes the running capture and re-sets its encoding, with no new picker.
 * The Linux native capture cannot do either in the webview, so its track does
 * both itself: Change source (`inPlaceSourceChange`) has the host swap the
 * capture under the same publication, and Quality (`inPlaceQualityChange`) has
 * the host re-size the running capture and republish it (a new publication, so
 * viewers see the codec switch's short blip).
 */

import {
  Track,
  createLocalScreenTracks,
  type LocalTrack,
  type LocalVideoTrack,
  type Room,
} from "livekit-client";
import type { WsClient } from "../../lib/ws";
import { createLogger } from "../../lib/logger";
import {
  SCREENSHARE_AUDIO_PUBLISH,
  SCREENSHARE_PRESETS,
  disableScreenshare,
  getEffectiveScreenShareFps,
  inPlaceQualityChange,
  inPlaceSourceChange,
  getScreenShareCaptureOptions,
  getScreenShareFps,
  getScreenShareMaxBitrate,
  unpublishManualTrack,
  watchScreenEnded,
  type InPlaceQualityChange,
  type InPlaceSourceChange,
  type ScreenTrackState,
  type StreamQuality,
  type VideoTrackDeps,
} from "../../lib/screenShare";
import { bumpLocalShareRev } from "../../stores/voice.store";
import { isLinuxDesktop } from "./native/platform";
import { setH264GpuProfiles } from "../../lib/h264Profile";
import { h264GpuPublish } from "./videoCodec";
import { startAppShareAudio, wantsAppAudio, type AppShareAudio } from "../../lib/appAudioShare";
import { voiceText } from "../../i18n/voice";

const log = createLogger("screenShare");

interface LiveShare {
  readonly room: Room;
  readonly ws: WsClient;
  readonly video: LocalVideoTrack;
  readonly tracks: LocalTrack[];
  readonly quality: StreamQuality;
  readonly fps: number;
  readonly generation: number;
}

/** The published share, or null while it is starting, stopping or already
 *  changing (one change at a time). */
function liveShare(state: ScreenTrackState, deps: VideoTrackDeps): LiveShare | null {
  const room = deps.getRoom();
  const ws = deps.getWs();
  const video = state.manualScreenTracks.find((t) => t.kind === Track.Kind.Video);
  if (room === null || ws === null || video === undefined) return null;
  if (state.quality === undefined || state.changing === true) return null;
  return {
    room,
    ws,
    video: video as LocalVideoTrack,
    tracks: state.manualScreenTracks,
    quality: state.quality,
    fps: state.fps ?? getScreenShareFps(),
    generation: state.generation ?? 0,
  };
}

/** A stop, a reconnect or a new session took the share while a change waited. */
function superseded(state: ScreenTrackState, deps: VideoTrackDeps, live: LiveShare): boolean {
  return (
    (state.generation ?? 0) !== live.generation ||
    state.manualScreenTracks !== live.tracks ||
    deps.getRoom() !== live.room ||
    deps.getWs() !== live.ws
  );
}

/** A backup-codec sender (VP9/AV1 publishes one for viewers who cannot decode
 *  it) still carries the old capture after replaceTrack; the SDK only swaps
 *  them in restartTrack, so do the same here. */
async function swapBackupCodecs(video: LocalVideoTrack): Promise<void> {
  for (const sc of video.simulcastCodecs.values()) {
    if (sc.sender === undefined || sc.sender.transport?.state === "closed") continue;
    const prev = sc.mediaStreamTrack;
    sc.mediaStreamTrack = video.mediaStreamTrack.clone();
    // oxlint-disable-next-line no-await-in-loop -- one sender at a time, as the SDK does
    await sc.sender.replaceTrack(sc.mediaStreamTrack);
    prev.stop();
  }
}

/** Share something else without stopping: the OS picker opens, and the old
 *  source keeps going until the new one is picked. Cancelling the picker
 *  changes nothing. */
export async function changeScreenshareSource(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
): Promise<void> {
  const inPlace = inPlaceSourceChange(state);
  if (inPlace !== null) {
    await changeInPlace(state, deps, inPlace);
    return;
  }
  const live = liveShare(state, deps);
  if (live === null) return;
  state.changing = true;
  let fresh: LocalTrack[] = [];
  let swapped = false;
  let appShare: AppShareAudio | null = null;
  try {
    fresh = await createLocalScreenTracks(getScreenShareCaptureOptions(live.quality, live.fps));
    const freshVideo = fresh.find((t) => t.kind === Track.Kind.Video);
    if (
      superseded(state, deps, live) ||
      freshVideo === undefined ||
      freshVideo.mediaStreamTrack.readyState === "ended"
    ) {
      for (const t of fresh) t.stop();
      return;
    }
    let freshAudio: LocalTrack | undefined = fresh.find((t) => t.kind === Track.Kind.Audio);
    const oldAudio = live.tracks.find((t) => t.kind === Track.Kind.Audio);
    // Windows: a window gets its app's sound as the "fresh audio".
    // The host replaces the capture of the window being left; leaving a
    // window for anything else stops it below.
    if (
      !isLinuxDesktop() &&
      wantsAppAudio(state.appAudioOn, freshVideo.mediaStreamTrack, freshAudio !== undefined)
    ) {
      appShare = await startAppShareAudio(freshVideo.mediaStreamTrack, () =>
        superseded(state, deps, live),
      );
      if (superseded(state, deps, live)) {
        // startAppShareAudio already stopped a capture it opened.
        for (const t of fresh) t.stop();
        return;
      }
      if (appShare !== null) freshAudio = appShare.track;
    }
    swapped = true;
    state.screenTrackEndedCleanup?.();
    // The SDK stops the old capture once the sender carries the new one.
    await live.video.replaceTrack(freshVideo.mediaStreamTrack, { userProvidedTrack: false });
    // A reconnect republishes the share with this capture: keep its H.264
    // profiles.
    setH264GpuProfiles(freshVideo.mediaStreamTrack, h264GpuPublish(state.published ?? "vp8"));
    await swapBackupCodecs(live.video);
    const tracks: LocalTrack[] = [live.video];
    if (oldAudio !== undefined && freshAudio !== undefined) {
      await oldAudio.replaceTrack(freshAudio.mediaStreamTrack, { userProvidedTrack: false });
      tracks.push(oldAudio);
    } else if (oldAudio !== undefined) {
      unpublishManualTrack(live.room, oldAudio);
      oldAudio.stop();
    } else if (freshAudio !== undefined) {
      await live.room.localParticipant.publishTrack(freshAudio, {
        source: Track.Source.ScreenShareAudio,
        ...SCREENSHARE_AUDIO_PUBLISH,
      });
      tracks.push(freshAudio);
    }
    if (superseded(state, deps, live)) {
      // The stop already released the share's tracks; these captures are the
      // only ones it could not reach.
      for (const t of fresh) t.stop();
      appShare?.close();
      if (freshAudio !== undefined && tracks.includes(freshAudio)) {
        unpublishManualTrack(live.room, freshAudio);
      }
      return;
    }
    // The `fresh` wrappers stay unstopped: stopping one would stop the
    // capture the published track now carries.
    state.manualScreenTracks = tracks;
    // The app's sound follows the window.
    const oldApp = state.appAudio;
    state.appAudio = appShare ?? undefined;
    // A newer start (window to window) already replaced the old capture on the
    // host, so closing the old one skips the stop; to a screen it stops.
    oldApp?.close();
    watchScreenEnded(state, deps, live.video, tracks, live.generation);
    if (live.video.mediaStreamTrack.readyState === "ended") {
      // The new capture ended while it was being swapped in, before the
      // watch above was listening.
      await disableScreenshare(state, deps);
      return;
    }
    deps.reapplyAudioPipeline();
    bumpLocalShareRev();
    log.info("Screenshare source changed", { audio: freshAudio !== undefined });
  } catch (err) {
    for (const t of fresh) t.stop();
    if (appShare !== null && state.appAudio !== appShare) appShare.close();
    if (superseded(state, deps, live)) return;
    if (!swapped) {
      // The picker was closed (not a failure) or could not open: the old
      // source is still going out untouched.
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        log.error("Failed to open a new screenshare source", err);
        deps.onError(voiceText("share.changeFailed"));
      }
      return;
    }
    // Half swapped: what goes out is unknown, so end the share cleanly.
    log.error("Failed to change screenshare source", err);
    deps.onError(voiceText("share.changeFailed"));
    await disableScreenshare(state, deps);
  } finally {
    state.changing = false;
  }
}

/** Change source on a track that swaps its own capture: the publication, the
 *  tracks and the ended watch all stay, and a failed or cancelled pick leaves
 *  the old source going. */
async function changeInPlace(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  share: InPlaceSourceChange,
): Promise<void> {
  const room = deps.getRoom();
  if (state.changing === true || room === null) return;
  const generation = state.generation ?? 0;
  const tracks = state.manualScreenTracks;
  const stale = (): boolean =>
    (state.generation ?? 0) !== generation ||
    state.manualScreenTracks !== tracks ||
    deps.getRoom() !== room;
  state.changing = true;
  try {
    await share.changeSource();
    if (stale()) return;
    bumpLocalShareRev();
    log.info("Screenshare source changed", { inPlace: true });
  } catch (err) {
    if (stale()) return;
    if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
      log.error("Failed to change screenshare source", err);
      deps.onError(voiceText("share.changeFailed"));
    }
  } finally {
    state.changing = false;
  }
}

/** A quality change the host could not complete, by its `stage`
 *  (`ScreenQualityError`): "publish" means the share's video is gone. Read by
 *  shape, so this web-loaded module does not import the Linux track. */
function isPublishFailure(err: unknown): boolean {
  return err instanceof Error && (err as { stage?: unknown }).stage === "publish";
}

/** Quality on a track that changes it itself (Linux): the host re-sizes the
 *  running capture and republishes it. A refusal changed nothing, so the
 *  toast shows and the select reverts to the live quality; a failed republish
 *  left no video, so the share ends. A stop, reconnect or new session while
 *  the host works makes the change go silent. */
async function qualityInPlace(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  share: InPlaceQualityChange,
  quality: StreamQuality,
): Promise<void> {
  const room = deps.getRoom();
  const ws = deps.getWs();
  if (state.changing === true || room === null || ws === null) return;
  if (state.quality === undefined || state.quality === quality) return;
  const generation = state.generation ?? 0;
  const tracks = state.manualScreenTracks;
  const fps = state.fps ?? share.fps;
  const stale = (): boolean =>
    (state.generation ?? 0) !== generation ||
    state.manualScreenTracks !== tracks ||
    deps.getRoom() !== room ||
    deps.getWs() !== ws;
  state.changing = true;
  try {
    await share.setQuality(quality, fps, state.published ?? "vp8");
    if (stale()) return;
    state.quality = quality;
    bumpLocalShareRev();
    log.info("Screenshare quality changed", { quality, fps, inPlace: true });
  } catch (err) {
    if (stale()) return;
    log.error("Failed to change screenshare quality", err);
    if (isPublishFailure(err)) await disableScreenshare(state, deps);
    deps.onError(voiceText("share.qualityFailed"));
  } finally {
    state.changing = false;
  }
}

/** The encoding the top layer carries (the one at full size). */
async function setTopLayer(
  sender: RTCRtpSender | undefined,
  maxBitrate: number,
  maxFramerate: number,
): Promise<void> {
  if (sender === undefined) return;
  const params = sender.getParameters();
  const top = params.encodings.reduce<RTCRtpEncodingParameters | undefined>(
    (best, e) =>
      best === undefined || (e.scaleResolutionDownBy ?? 1) <= (best.scaleResolutionDownBy ?? 1)
        ? e
        : best,
    undefined,
  );
  if (top === undefined) return;
  top.maxBitrate = maxBitrate;
  top.maxFramerate = maxFramerate;
  await sender.setParameters(params);
}

/** Change the live share's quality without a new picker: the capture is
 *  re-sized in place and the encoding follows. For this share only; the
 *  saved default in Settings stays. */
export async function setScreenshareQuality(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  quality: StreamQuality,
): Promise<void> {
  const inPlace = inPlaceQualityChange(state);
  if (inPlace !== null) {
    await qualityInPlace(state, deps, inPlace, quality);
    return;
  }
  const live = liveShare(state, deps);
  if (live === null || live.quality === quality) return;
  state.changing = true;
  try {
    const fps = live.fps;
    const frameRate = getEffectiveScreenShareFps(quality, fps);
    const maxBitrate = getScreenShareMaxBitrate(quality, fps);
    const size = SCREENSHARE_PRESETS[quality].resolution;
    const mst = live.video.mediaStreamTrack;
    await mst.applyConstraints(
      size === undefined
        ? { frameRate }
        : { width: { max: size.width }, height: { max: size.height }, frameRate },
    );
    if (superseded(state, deps, live)) return;
    live.video.publishOptions = {
      ...live.video.publishOptions,
      screenShareEncoding: { maxBitrate, maxFramerate: frameRate },
    };
    // Re-sets the track on its own sender: the SDK recomputes every layer
    // for the new size (nothing when the size did not change).
    await live.video.replaceTrack(mst, { userProvidedTrack: false });
    await setTopLayer(live.video.sender, maxBitrate, frameRate);
    if (superseded(state, deps, live)) return;
    state.quality = quality;
    bumpLocalShareRev();
    log.info("Screenshare quality changed", { quality, fps: frameRate, maxBitrate });
  } catch (err) {
    if (superseded(state, deps, live)) return;
    log.error("Failed to change screenshare quality", err);
    deps.onError(voiceText("share.qualityFailed"));
  } finally {
    state.changing = false;
  }
}
