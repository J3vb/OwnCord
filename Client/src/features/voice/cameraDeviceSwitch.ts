// Moving the live camera to another input device: in place when the track can
// swap its capture, else a restart (stop, start on the saved device,
// republish). Queueing and the latest-pick rule stay in MediaControl; this runs
// one switch, reading the session's camera state and the latest pick through
// the host on every use.
import { bumpLocalCameraRev } from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import { voiceText } from "../../i18n/voice";
import { savePref } from "../../lib/prefs/preferences";
import { setH264GpuProfiles } from "../../lib/voice/h264Profile";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "./cameraSwitch";
import { h264GpuPublish } from "./videoCodec";
import type { CameraTrackState } from "./videoTrackState";

// Same logger tag as before the extraction, so the media log lines are unchanged.
const log = createLogger("livekitSession");

/** What one camera switch reads from, and calls on, MediaControl. */
export interface CameraSwitchHost {
  /** The latest device picked, which a newer pick can change mid-switch. */
  latestDevice(): string | null;
  setLatestDevice(device: string | null): void;
  enableCamera(): Promise<void>;
  disableCamera(): Promise<void>;
  /** Start the camera with its failure messages sent to `onError` instead. */
  startCameraHolding(onError: (message: string) => void): Promise<void>;
  onError(message: string): void;
}

type LiveCameraTrack = NonNullable<CameraTrackState["manualCameraTrack"]>;
type SwappableTrack = Extract<LiveCameraTrack, { setDeviceId: unknown }>;

interface SwitchContext {
  readonly host: CameraSwitchHost;
  readonly deviceId: string;
  readonly state: CameraTrackState;
  /** The device the live camera runs on (the native track knows it). */
  readonly previous: string | null;
}

/** The pick is unusable and the live camera stays: keep using its device. */
function keepPrevious(c: SwitchContext): void {
  if (c.previous === null || c.host.latestDevice() !== c.deviceId) return;
  savePref("videoInputDevice", c.previous);
  c.host.setLatestDevice(c.previous);
}

/** The restart on the picked device failed: start the previous one. */
async function fallBackToPrevious(
  c: SwitchContext,
  previous: string,
  failed: () => boolean,
): Promise<void> {
  log.warn("Camera restart on the picked device failed, starting the previous one");
  const back = c.host.latestDevice() === c.deviceId;
  const newer = c.host.latestDevice();
  // Start on the previous device. A pick made meanwhile stays the
  // saved choice and its queued switch moves the camera on from here.
  savePref("videoInputDevice", previous);
  await c.host.enableCamera();
  if (back) keepPrevious(c);
  else if (newer !== null) savePref("videoInputDevice", newer);
  if (!failed() && back) {
    c.host.onError(voiceText("share.cameraSwitchFailed"));
  }
}

/** The restart path: stop, start on the saved device, republish. */
async function restartCameraOn(c: SwitchContext): Promise<boolean> {
  const generation = c.state.generation ?? 0;
  const failed = (): boolean =>
    c.state.manualCameraTrack === null && (c.state.generation ?? 0) === generation;
  if (c.previous === null) {
    await c.host.enableCamera();
  } else {
    // Hold the failure message: the previous camera may still come back.
    const held: string[] = [];
    await c.host.startCameraHolding((msg) => held.push(msg));
    if (failed()) {
      await fallBackToPrevious(c, c.previous, failed);
    } else {
      for (const msg of held) c.host.onError(msg);
    }
  }
  // A failed restart already said so, but the server still has the
  // camera on: tell it the camera is off.
  if (failed()) {
    await c.host.disableCamera();
    return false;
  }
  return true;
}

/** Restart on the saved device; true when the switch went through. */
async function restartAndRedraw(c: SwitchContext): Promise<boolean> {
  if (!(await restartCameraOn(c))) return false;
  bumpLocalCameraRev();
  return true;
}

/** The restart swaps the capture: unplug detection and the H.264
 *  profiles a reconnect would republish with move with it. */
function rearmSwappedCapture(
  state: CameraTrackState,
  track: SwappableTrack,
  before: MediaStreamTrack,
): void {
  const now = track.mediaStreamTrack;
  if (now !== before) setH264GpuProfiles(now, h264GpuPublish(state.published ?? "vp8"));
  if (now !== before && state.manualCameraTrack === track && state.onCameraEnded) {
    now.addEventListener("ended", state.onCameraEnded, { once: true });
  }
  // The self tile holds the stopped capture: have it drawn again.
  if (now !== before && state.manualCameraTrack === track) bumpLocalCameraRev();
}

/** Switch a track that can swap its capture in place; true when the switch
 *  went through, false when it was refused or a restart failed. */
async function switchInPlace(c: SwitchContext, track: SwappableTrack): Promise<boolean> {
  const before = track.mediaStreamTrack;
  try {
    if (!(await track.setDeviceId(c.deviceId))) {
      log.warn("Camera restarted on another device than the one picked");
    }
  } catch (err) {
    if (err instanceof CameraDeviceUnusable) {
      log.warn("Picked camera gave no picture, keeping the live one", err);
      // A newer pick queued meanwhile moves the camera on: no message.
      if (c.host.latestDevice() !== c.deviceId) return false;
      keepPrevious(c);
      c.host.onError(voiceText("share.cameraSwitchFailed"));
      return false;
    }
    if (!(err instanceof CameraSwitchUnavailable)) throw err;
    // The in-place switch could not run and the old camera still
    // publishes: restart on the new device instead.
    log.info("In-place camera switch unavailable, restarting", err);
    return restartAndRedraw(c);
  }
  rearmSwappedCapture(c.state, track, before);
  return true;
}

/** Move the live camera to `deviceId`. `state` is the session's camera state,
 *  read once when the switch starts. */
export async function switchCameraDevice(
  host: CameraSwitchHost,
  state: CameraTrackState,
  deviceId: string,
): Promise<void> {
  const track = state.manualCameraTrack;
  // Camera off, or still starting: the saved choice is what it uses next.
  // An enable that read the choice just before this pick starts on the old
  // device; picking again moves it.
  if (track === null) return;
  const c: SwitchContext = {
    host,
    deviceId,
    state,
    previous: "device" in track ? track.device : null,
  };
  try {
    const switched =
      "setDeviceId" in track ? await switchInPlace(c, track) : await restartAndRedraw(c);
    if (switched) log.info("Camera device switched");
  } catch (err) {
    if (state.manualCameraTrack !== track) return;
    log.warn("Camera device switch failed", err);
    await host.disableCamera();
    host.onError(voiceText("share.cameraFailed"));
  }
}
