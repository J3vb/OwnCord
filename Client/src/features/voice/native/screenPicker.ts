// The Linux screen-share source picker. The web path gets the browser's own
// getDisplayMedia picker; the native path picks here, from the host's
// enumeration (`NativeVoice.screenSources`): screens and windows, each shown
// with a thumbnail of what would be shared, so the user sees it before
// sharing starts. On Wayland the host cannot enumerate anything — the
// desktop portal's dialog is the picker (and the consent) — so the dialog
// shows only the quality step and hands "portal" to the host.
//
// The dialog itself is `components/ScreenSharePicker.ts`; this module adapts
// its result to the host capture and the shared publish settings, so the
// per-share quality the user picked drives both.
import { desktop } from "../../../platform/desktop";
import {
  getEffectiveScreenShareFps,
  getScreenShareCaptureOptions,
  getScreenShareFps,
  getScreenShareMaxBitrate,
  getStreamQuality,
} from "@lib/screenShare";
import type { NativeVoiceScreenCapture } from "../../../platform/contracts/nativeVoice";
import { showScreenSharePicker } from "../../../components/ScreenSharePicker";
import { captureOptions } from "./screenTrack";

/** A confirmed share: the host source to capture, plus what it should be
 *  captured and published at. Resolved once the user presses Go Live. */
export interface ScreenSharePick {
  /** A host source id, or "portal" on Wayland. */
  source: string;
  /** Host capture pacing and size cap. */
  capture: NativeVoiceScreenCapture;
  maxBitrate: number;
  maxFramerate: number;
}

/** Resolve the source to share and its settings, or null when the user closed
 *  the picker. */
export async function pickScreenSource(): Promise<ScreenSharePick | null> {
  const listed = await desktop.nativeVoice.screenSources();
  const pick = await showScreenSharePicker({
    sources: listed.sources,
    portal: listed.portal,
    defaultQuality: getStreamQuality(),
    defaultFps: getScreenShareFps(),
  });
  if (pick === null) return null;
  return {
    source: pick.source,
    capture: captureOptions(getScreenShareCaptureOptions(pick.quality, pick.fps)),
    maxBitrate: getScreenShareMaxBitrate(pick.quality, pick.fps),
    maxFramerate: getEffectiveScreenShareFps(pick.quality, pick.fps),
  };
}
