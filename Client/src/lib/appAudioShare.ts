/**
 * Windows per-app share audio: the start step shared by a new share
 * and Change source. Loaded on first use by `screenShare.ts` and
 * `features/voice/screenshareChange.ts`, so it stays out of the share chunk.
 *
 * WebView2's picker gives a shared window no sound. When the picker's "Share
 * the app's sound" switch is on, the share is a window and Chromium gave no
 * audio track, the host captures the window's app (`start_app_audio`, keyed by
 * the video track's label) and `openAppAudio` plays that into a track, which
 * the caller publishes exactly like Chromium's share audio.
 *
 * Every await re-asks `isStale()`: a stop, leave or newer share that landed
 * meanwhile means the capture is stopped again and nothing is published.
 */

import {
  LocalAudioTrack,
  type LocalTrack,
  type Room,
  type TrackPublishOptions,
} from "livekit-client";
import { desktop } from "../platform/desktop";
import type { AppAudioErrorCode } from "../platform/contracts/appAudio";
import { openAppAudio } from "./appAudioTrack";
import type { ScreenTrackState } from "./screenShare";
import { createLogger } from "./logger";
import { showToast } from "./toast";
import { voiceText } from "../i18n/voice";

const log = createLogger("appAudioShare");

/** A refusal that is the expected answer rather than a fault: the share is
 *  not of a window, a newer start replaced this one, or it is OwnCord's own
 *  window (or one it descends from), which has no app sound to share. */
const SILENT: ReadonlySet<AppAudioErrorCode> = new Set([
  "not_window",
  "superseded",
  "own_window",
  "ancestor",
]);

/** The app's sound for a live share. */
export interface AppShareAudio {
  /** Publish this as the share's audio. */
  readonly track: LocalAudioTrack;
  /** Close the page side and, if no newer start was issued since this one,
   *  stop the host capture (once). A newer start already replaced it on the
   *  host, and a stop now would stop the newer capture. Idempotent. */
  close(): void;
}

/** Starts issued so far, newest last. The host keeps one capture and a stop
 *  cancels whatever is current, so a start only stops the host while it is
 *  still the latest one issued. */
let issued = 0;

/** Whether a share's video should get the app's sound: the picker switch was
 *  on, the capture is a window and Chromium gave no audio of its own. */
export function wantsAppAudio(
  switchOn: boolean | undefined,
  video: MediaStreamTrack,
  hasChromiumAudio: boolean,
): boolean {
  if (switchOn !== true || hasChromiumAudio) return false;
  return video.getSettings?.()?.displaySurface === "window";
}

/**
 * Start capturing the sound of the window `video` shows and open it as a
 * track. Null when there is none to share (a refusal, an error, or `isStale`
 * turning true), with the host capture stopped again; a refusal other than
 * "not a window" or "superseded" raises one toast, and the video share goes on.
 */
export async function startAppShareAudio(
  video: MediaStreamTrack,
  isStale: () => boolean,
): Promise<AppShareAudio | null> {
  if (isStale()) return null;
  const mine = ++issued;
  const stopIfLatest = (): void => {
    if (issued === mine) void desktop.appAudio.stop();
  };
  const started = await desktop.appAudio.start(video.label, "window");
  if (!started.ok) {
    if (!isStale() && !SILENT.has(started.code)) {
      log.warn("App audio did not start", { code: started.code });
      showToast(voiceText("share.appAudioFailed"), "warning");
    }
    return null;
  }
  if (isStale()) {
    stopIfLatest();
    return null;
  }
  let handle: Awaited<ReturnType<typeof openAppAudio>>;
  try {
    handle = await openAppAudio(started.url);
  } catch (err) {
    log.warn("App audio socket could not be opened", err);
    stopIfLatest();
    if (!isStale()) showToast(voiceText("share.appAudioFailed"), "warning");
    return null;
  }
  if (isStale()) {
    handle.close();
    stopIfLatest();
    return null;
  }
  const track = new LocalAudioTrack(handle.track, undefined, true);
  let closed = false;
  return {
    track,
    close(): void {
      if (closed) return;
      closed = true;
      handle.close();
      stopIfLatest();
    },
  };
}

/**
 * Windows web path, a new share: give the shared window its app's sound. Runs
 * after the video is published; a share of a screen and every failure leave
 * the video going as it is. Returns "stale" when a stop or newer share took
 * over (everything this made is released, nothing is announced), else "done".
 * `publishOptions` are the share-audio options of `screenShare.ts`.
 */
export async function publishAppAudio(
  state: ScreenTrackState,
  room: Room,
  screenTracks: LocalTrack[],
  video: LocalTrack,
  generation: number,
  publishOptions: TrackPublishOptions,
): Promise<"done" | "stale"> {
  const stale = (): boolean =>
    (state.generation ?? 0) !== generation || state.manualScreenTracks !== screenTracks;
  if (!wantsAppAudio(true, video.mediaStreamTrack, false)) return "done";
  try {
    const app = await startAppShareAudio(video.mediaStreamTrack, stale);
    if (app === null) return stale() ? "stale" : "done";
    state.appAudio = app;
    try {
      await room.localParticipant.publishTrack(app.track, publishOptions);
    } catch (err) {
      log.warn("Publishing the app's sound failed; the video share goes on", err);
      if (state.appAudio === app) state.appAudio = undefined;
      app.close();
      if (stale()) return "stale";
      showToast(voiceText("share.appAudioFailed"), "warning");
      return "done";
    }
    if (stale()) {
      if (state.appAudio === app) state.appAudio = undefined;
      app.close();
      room.localParticipant.unpublishTrack(app.track.mediaStreamTrack).catch((err: unknown) => {
        log.warn("Failed to unpublish the app's sound (non-fatal)", err);
      });
      return "stale";
    }
    screenTracks.push(app.track);
    return "done";
  } catch (err) {
    log.warn("App audio failed; the video share goes on", err);
    return stale() ? "stale" : "done";
  }
}
