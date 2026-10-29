// The Linux screen-share source picker. The web path gets the browser's own
// getDisplayMedia picker; the native path picks here, from the host's
// enumeration (`NativeVoice.screenSources`): screens and windows, each shown
// with a thumbnail of what would be shared, so the user sees it before
// sharing starts. On Wayland the host cannot enumerate anything — the
// desktop portal's dialog is the picker (and the consent) — so the dialog
// shows only the quality step and hands "portal" to the host.
//
// The dialog itself lives in the UI layer (`components/ScreenSharePicker.ts`).
// This module is a lower layer and must not import a component, so
// the UI registers the dialog through `screenPickerSlot.ts` — the same
// injection shape as `lib/read-state.ts`'s `setMarkReadSender` — and this
// module adapts the dialog's result to the host capture and the shared publish
// settings, so the per-share quality the user picked drives both. With no
// picker registered (a headless run) a share resolves to null, i.e. cancelled.
import { desktop } from "../../../platform/desktop";
import {
  getEffectiveScreenShareFps,
  getScreenShareCaptureOptions,
  getScreenShareFps,
  getScreenShareMaxBitrate,
  getScreenShareQuality,
  isScreenShareSimulcast,
} from "@lib/screenShare";
import type { NativeVoiceScreenCapture } from "../../../platform/contracts/nativeVoice";
import type { StreamQuality } from "@lib/screenShare";
import { getScreenSourcePicker } from "./screenPickerSlot";
import { captureOptions } from "./screenTrack";

/** What a quality and frame-rate choice means for a native share: the host
 *  capture's pacing and size cap, and the publish encoding. One mapping for the
 *  picker's pick and for a live quality change. */
export interface ScreenShareSettings {
  /** Host capture pacing and size cap. */
  capture: NativeVoiceScreenCapture;
  maxBitrate: number;
  maxFramerate: number;
  /** Publish with the 720p 15 fps simulcast layer. */
  simulcast: boolean;
}

export function shareSettings(quality: StreamQuality, fps: number): ScreenShareSettings {
  return {
    capture: captureOptions(getScreenShareCaptureOptions(quality, fps)),
    maxBitrate: getScreenShareMaxBitrate(quality, fps),
    maxFramerate: getEffectiveScreenShareFps(quality, fps),
    simulcast: isScreenShareSimulcast(quality, fps),
  };
}

/** A confirmed share: the host source to capture, plus what it should be
 *  captured and published at. Resolved once the user presses Go Live. */
export interface ScreenSharePick extends ScreenShareSettings {
  /** A host source id, or "portal" on Wayland. */
  source: string;
  /** The quality and frame-rate choice the settings came from, which the
   *  stream card's Quality menu shows and changes. */
  quality: StreamQuality;
  fps: number;
  /** Share other applications' sound with the picture. Absent when the host
   *  cannot capture it (no PulseAudio-protocol sound server); the Share
   *  audio switch's answer otherwise. */
  audio?: boolean;
}

/** The last confirmed pick, for a share restarted after a reconnect. */
let lastPick: ScreenSharePick | null = null;
/** Set while a restart runs: the next pick is this, with no dialog. */
let restartPick: ScreenSharePick | null = null;

/** Make the next share reuse the last pick when the host still lists its
 *  source. False on Wayland (only the portal dialog can pick) or when the
 *  source is gone. Undo with disarmScreenRestart once the share settles. */
export async function armScreenRestart(): Promise<boolean> {
  const pick = lastPick;
  if (pick === null || pick.source === "portal") return false;
  const listed = await desktop.nativeVoice.screenSources();
  if (!listed.sources.some((s) => s.id === pick.source)) return false;
  // The pick is reused as it was, audio included: a sound server that is
  // restarting does not fail the host's publish (it retries and publishes
  // silence until the server returns).
  restartPick = pick;
  return true;
}

export function disarmScreenRestart(): void {
  restartPick = null;
}

/** Resolve the source to share and its settings, or null when the user closed
 *  the picker. */
export async function pickScreenSource(): Promise<ScreenSharePick | null> {
  if (restartPick !== null) {
    const pick = restartPick;
    restartPick = null;
    return pick;
  }
  const showPicker = getScreenSourcePicker();
  if (showPicker === null) return null;
  const listed = await desktop.nativeVoice.screenSources();
  const pick = await showPicker({
    sources: listed.sources,
    portal: listed.portal,
    audioAvailable: listed.audio,
    defaultQuality: getScreenShareQuality(),
    defaultFps: getScreenShareFps(),
  });
  if (pick === null) return null;
  lastPick = {
    source: pick.source,
    quality: pick.quality,
    fps: pick.fps,
    ...shareSettings(pick.quality, pick.fps),
    // Kept with the pick, so a restart after a reconnect shares audio again.
    ...(pick.audio === undefined ? {} : { audio: pick.audio }),
  };
  return lastPick;
}

/** The source for a Change source on a live share, or null when the user
 *  closed the picker. Only the source is picked: the share keeps its
 *  quality. On Wayland the portal's own dialog is the picker. */
export async function pickChangeSource(): Promise<string | null> {
  const listed = await desktop.nativeVoice.screenSources();
  let source = "portal";
  if (!listed.portal) {
    const showPicker = getScreenSourcePicker();
    if (showPicker === null) return null;
    const pick = await showPicker({
      sources: listed.sources,
      portal: false,
      sourceOnly: true,
      defaultQuality: getScreenShareQuality(),
      defaultFps: getScreenShareFps(),
    });
    if (pick === null) return null;
    source = pick.source;
  }
  return source;
}

/** Record `source` as what the live share now captures, once the host has
 *  swapped it in: a restart after a reconnect shares what is going out now,
 *  and a failed change leaves the old source in place. */
export function noteChangedSource(source: string): void {
  if (lastPick !== null) lastPick = { ...lastPick, source };
}

/** Record the quality the live share now runs at, so a restart after a
 *  reconnect shares at it, not at the quality it first started with. */
export function noteChangedQuality(quality: StreamQuality, fps: number): void {
  if (lastPick !== null) lastPick = { ...lastPick, quality, fps, ...shareSettings(quality, fps) };
}
