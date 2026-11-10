/**
 * Enabling a screen share: the quality pick, the capture, the codec, the
 * publish and the announce, with the cleanup each step owes on a stop or a
 * failure.
 */

import {
  type Room,
  type LocalVideoTrack,
  type LocalTrack,
  type TrackPublishOptions,
  Track,
  createLocalScreenTracks,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import { fitGpuH264Share, setH264GpuProfiles } from "@lib/voice/h264Profile";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import {
  pickWebShareQuality,
  sharePublishOptions,
  stopTracks,
  type ShareSettings,
} from "../../lib/voice/videoCapture";
import { voiceText } from "../../i18n/voice";
import type { CodecChoice } from "./videoCodec";
import {
  bumpLocalShareRev,
  channelPeerDecode,
  getScreenSourcePicker,
  h264GpuPublish,
  isLinuxDesktop,
  PICKER_DISMISSED,
  PORTAL_NOT_STARTED,
  resolveCodecChoice,
  setLocalScreenshare,
} from "./shareHostLinks";
import {
  getEffectiveScreenShareFps,
  getScreenShareCaptureOptions,
  applyScreenShareContentHint,
  screenShareDegradation,
  getScreenShareFps,
  getScreenShareMaxBitrate,
  getScreenShareQuality,
  SCREENSHARE_AUDIO_PUBLISH,
  screenVideoPublishOptions,
  type StreamQuality,
} from "../../lib/voice/videoPresets";
import {
  qualityOf,
  registerPendingVideoEnable,
  unpublishManualTrack,
  type ScreenTrackState,
  type VideoTrackDeps,
} from "./videoTrackState";
import { disableScreenshare, stopManualScreenTracks, watchScreenEnded } from "./screenTrackStop";
import { clampPublishedVideo } from "./videoCapFollow";
import { liveVideoBudget } from "./videoBudgetNow";

const log = createLogger("screenShare");

/** The web picker's answer. Null when the enable stops here: a stop came
 *  first, or the dialog closed before Go Live (nothing was captured or
 *  announced). */
function acceptSharePick(
  state: ScreenTrackState,
  generation: number,
  pick: Awaited<ReturnType<typeof pickWebShareQuality>>,
): ShareSettings | null {
  if ((state.generation ?? 0) !== generation) return null;
  if (pick === null) {
    setLocalScreenshare(false);
    return null;
  }
  return { quality: pick.quality, fps: pick.fps, appAudioOn: pick.appAudio };
}

/** A disableScreenshare ran to completion while a publish was in flight —
 *  it already reset localScreenshare, sent voice_screenshare(false) and
 *  emptied state.manualScreenTracks, so the tracks still held by this
 *  attempt are unreachable from any later disable. Undo every one of them
 *  (a publish may have landed after the disable's unpublish). */
function undoSupersededShare(
  state: ScreenTrackState,
  room: Room,
  screenTracks: LocalTrack[],
): void {
  for (const t of screenTracks) {
    unpublishManualTrack(room, t);
    t.stop();
  }
  if (state.manualScreenTracks === screenTracks) state.manualScreenTracks = [];
}

/** Windows web path: a shared window gets its app's sound. A stop or newer
 *  share meanwhile has released everything it made. */
function publishShareAppAudio(
  state: ScreenTrackState,
  room: Room,
  screenTracks: LocalTrack[],
  videoTrack: LocalTrack,
  generation: number,
): Promise<"done" | "stale"> {
  return import("../../lib/voice/appAudioShare")
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
}

/** The web capture never grows back after a bandwidth dip on its own; the
 *  Linux native capture is not a browser source. Loaded once the share is
 *  up, and only if this share is still the live one by then. */
function startShareRecovery(
  state: ScreenTrackState,
  videoTrack: LocalTrack | undefined,
  screenTracks: LocalTrack[],
  videoOptions: TrackPublishOptions,
  generation: number,
): void {
  if (videoTrack === undefined || isLinuxDesktop()) return;
  const preference = videoOptions.degradationPreference ?? screenShareDegradation();
  void import("../../lib/voice/shareResolutionRecovery")
    .then(({ watchShareResolutionRecovery }) => {
      if ((state.generation ?? 0) !== generation || state.manualScreenTracks !== screenTracks)
        return;
      state.stopResolutionRecovery?.();
      state.stopResolutionRecovery = watchShareResolutionRecovery(
        videoTrack as LocalVideoTrack,
        preference,
      );
    })
    .catch((err: unknown) => log.warn("Share resolution recovery unavailable", err));
}

/** Tell the server the share is on, and record what went out. */
function announceShare(
  state: ScreenTrackState,
  ws: WsClient,
  deps: VideoTrackDeps,
  videoTrack: LocalTrack | undefined,
  choice: CodecChoice,
  sent: { quality: StreamQuality; fps: number; effectiveFps: number; maxBitrate: number },
): void {
  const sendId = ws.send({ type: "voice_screenshare", payload: { enabled: true } });
  registerPendingVideoEnable(sendId, "screen");
  state.announced = videoTrack;
  state.preferred = choice.preferred;
  state.published = choice.codec;
  // The Linux native capture carries the quality and frame rate its own
  // picker chose, not the saved prefs.
  const nativeQuality = isLinuxDesktop() ? qualityOf(videoTrack) : null;
  if (nativeQuality !== null) {
    state.quality = nativeQuality.quality;
    state.fps = nativeQuality.fps;
  } else if (!isLinuxDesktop()) {
    state.quality = sent.quality;
    state.fps = sent.fps;
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
      ? { fps: picked.maxFramerate, maxBitrate: picked.maxBitrate, codec: choice.codec }
      : {
          quality: sent.quality,
          fps: sent.effectiveFps,
          maxBitrate: sent.maxBitrate,
          codec: choice.codec,
        },
  );
}

function failShareEnable(
  state: ScreenTrackState,
  room: Room,
  generation: number,
  deps: VideoTrackDeps,
  err: unknown,
): void {
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
    // silent rather than reporting "permission denied".
    // The desktop portal cannot say whether the user cancelled or a
    // permission refused, so that case gets a soft notice covering both.
    if (err.message === PORTAL_NOT_STARTED) showToast(voiceText("share.screenNotStarted"), "info");
    else if (err.message !== PICKER_DISMISSED) deps.onError(voiceText("share.screenDenied"));
  } else {
    deps.onError(voiceText("share.screenFailed"));
  }
}

/** What a share captured: its tracks, the video among them, and the
 *  capture options it asked for. */
interface CapturedShare {
  screenTracks: LocalTrack[];
  videoTrack: LocalTrack | undefined;
  captureOptions: ReturnType<typeof getScreenShareCaptureOptions>;
}

/** Capture the share and watch for the OS ending it. Null when the enable
 *  stops here: a stop came first, or the capture already ended. */
async function captureShare(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  room: Room,
  settings: ShareSettings,
  generation: number,
  ended: { remove?: () => void },
): Promise<CapturedShare | null> {
  stopManualScreenTracks(state, room);
  const captureOptions = getScreenShareCaptureOptions(settings.quality, settings.fps);
  // Linux captures in the native backend (no getDisplayMedia behind a
  // WebRTC-less webview): its room's picker-and-capture stands in and sets
  // the capture from the picker's per-share quality.
  const screenTracks = isLinuxDesktop()
    ? await room.localParticipant.createScreenTracks()
    : await createLocalScreenTracks(captureOptions);
  if ((state.generation ?? 0) !== generation) {
    // A disableScreenshare ran to completion while the OS picker was still
    // up — it already reset localScreenshare and sent voice_screenshare
    // (false). Publishing now would resurrect a share the user just ended.
    stopTracks(screenTracks);
    return null;
  }
  state.manualScreenTracks = screenTracks;
  // The OS may stop capture while a publication is still awaiting the
  // server. Observe it before publishing, so remaining tracks (including
  // screen audio) cannot start after the user has already stopped sharing.
  const videoTrack = screenTracks.find((t) => t.kind === Track.Kind.Video);
  if (videoTrack !== undefined) {
    ended.remove = watchScreenEnded(state, deps, videoTrack, screenTracks, generation);
    if (videoTrack.mediaStreamTrack.readyState === "ended") {
      await disableScreenshare(state, deps);
      return null;
    }
  }
  return { screenTracks, videoTrack, captureOptions };
}

/** Pick the share's codec, then shape the capture for it. */
async function prepareShareCodec(
  captured: CapturedShare,
  effectiveFps: number,
  maxBitrate: number,
): Promise<CodecChoice> {
  const { videoTrack, captureOptions } = captured;
  if (videoTrack === undefined) return { preferred: "vp8", codec: "vp8" };
  const choice = await resolveCodecChoice(
    videoTrack.mediaStreamTrack,
    effectiveFps,
    maxBitrate,
    channelPeerDecode,
  );
  if (!isLinuxDesktop())
    applyScreenShareContentHint(videoTrack.mediaStreamTrack, captureOptions, choice.codec);
  if (h264GpuPublish(choice.codec)) {
    await fitGpuH264Share(videoTrack);
  }
  return choice;
}

/** Publish the tracks in order. False when a stop landed meanwhile; this
 *  attempt's tracks are then undone. */
async function publishShareTracks(
  state: ScreenTrackState,
  room: Room,
  screenTracks: LocalTrack[],
  videoOptions: TrackPublishOptions,
  generation: number,
  ended: { remove?: () => void },
): Promise<boolean> {
  for (const track of screenTracks) {
    // oxlint-disable-next-line no-await-in-loop -- tracks must be published sequentially to maintain correct order
    await room.localParticipant.publishTrack(track, sharePublishOptions(track, videoOptions));
    if ((state.generation ?? 0) !== generation) {
      ended.remove?.();
      // Stay silent: announcing voice_screenshare(true) now would
      // override the disable's final word on the server.
      undoSupersededShare(state, room, screenTracks);
      return false;
    }
  }
  return true;
}

function wantsAppAudio(
  appAudioOn: boolean,
  videoTrack: LocalTrack | undefined,
  screenTracks: LocalTrack[],
): videoTrack is LocalTrack {
  return (
    appAudioOn &&
    videoTrack !== undefined &&
    !isLinuxDesktop() &&
    !screenTracks.some((t) => t.kind === Track.Kind.Audio)
  );
}

/** Capture, publish and announce the share at `settings`. */
async function startShare(
  state: ScreenTrackState,
  deps: VideoTrackDeps,
  room: Room,
  ws: WsClient,
  settings: ShareSettings,
  generation: number,
): Promise<void> {
  const { quality, fps, appAudioOn } = settings;
  const stale = (): boolean => (state.generation ?? 0) !== generation;
  const effectiveFps = getEffectiveScreenShareFps(quality, fps);
  const maxBitrate = getScreenShareMaxBitrate(quality, fps);
  const ended: { remove?: () => void } = {};
  try {
    const captured = await captureShare(state, deps, room, settings, generation, ended);
    if (captured === null) return;
    const { screenTracks, videoTrack } = captured;
    const choice = await prepareShareCodec(captured, effectiveFps, maxBitrate);
    if (stale() || state.manualScreenTracks !== screenTracks) {
      // A disableScreenshare (or the OS stop-sharing button) ran to
      // completion while Auto's probe or the GPU fit was pending: it already stopped these
      // tracks and sent voice_screenshare(false). Nothing is published yet.
      ended.remove?.();
      stopTracks(screenTracks);
      return;
    }
    if (videoTrack !== undefined)
      setH264GpuProfiles(videoTrack.mediaStreamTrack, h264GpuPublish(choice.codec));
    const videoOptions = screenVideoPublishOptions(
      choice.codec,
      quality,
      fps,
      liveVideoBudget().screen,
    );
    if (!(await publishShareTracks(state, room, screenTracks, videoOptions, generation, ended)))
      return;
    // The publish step resolves a tick after its own check: a stop in that
    // tick has released the tracks, and nothing may be announced.
    if (stale()) {
      ended.remove?.();
      undoSupersededShare(state, room, screenTracks);
      return;
    }
    state.appAudioOn = appAudioOn;
    if (wantsAppAudio(appAudioOn, videoTrack, screenTracks)) {
      const outcome = await publishShareAppAudio(state, room, screenTracks, videoTrack, generation);
      if (outcome === "stale" || stale()) {
        ended.remove?.();
        return;
      }
    }
    startShareRecovery(state, videoTrack, screenTracks, videoOptions, generation);
    announceShare(state, ws, deps, videoTrack, choice, { quality, fps, effectiveFps, maxBitrate });
    void clampPublishedVideo(videoTrack, "screen", maxBitrate);
  } catch (err) {
    ended.remove?.();
    failShareEnable(state, room, generation, deps, err);
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
  let settings: ShareSettings = {
    quality: getScreenShareQuality(),
    fps: getScreenShareFps(),
    appAudioOn: false,
  };
  // Linux picks inside its own capture; a headless run (no dialog registered)
  // keeps the saved defaults.
  const showPicker = isLinuxDesktop() ? null : getScreenSourcePicker();
  if (showPicker !== null) {
    const pick = await pickWebShareQuality(showPicker, settings.quality, settings.fps);
    const accepted = acceptSharePick(state, generation, pick);
    if (accepted === null) return;
    settings = accepted;
  }
  await startShare(state, deps, room, ws, settings, generation);
}
