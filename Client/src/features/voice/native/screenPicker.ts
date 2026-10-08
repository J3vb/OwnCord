// The Linux screen-share source picker. The web path gets the browser's own
// getDisplayMedia picker; the native path picks here, from the host's
// enumeration (`NativeVoice.screenSources`): screens and windows, each shown
// with a thumbnail of what would be shared, so the user sees it before
// sharing starts. On Wayland the host cannot enumerate anything — the
// desktop portal's dialog is the picker (and the consent) — so the dialog
// shows only the quality step and hands "portal" to the host.
//
// The dialog itself lives in the UI layer (`components/ScreenSharePicker.ts`).
// This module is a lower layer and must not import a component (ARCH-06), so
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
import { getScreenSourcePicker } from "./screenPickerSlot";
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
  /** Publish with the 720p 15 fps simulcast layer. */
  simulcast: boolean;
}

/** Resolve the source to share and its settings, or null when the user closed
 *  the picker. */
export async function pickScreenSource(): Promise<ScreenSharePick | null> {
  const showPicker = getScreenSourcePicker();
  if (showPicker === null) return null;
  const listed = await desktop.nativeVoice.screenSources();
  const pick = await showPicker({
    sources: listed.sources,
    portal: listed.portal,
    defaultQuality: getScreenShareQuality(),
    defaultFps: getScreenShareFps(),
  });
  if (pick === null) return null;
  return {
    source: pick.source,
    capture: captureOptions(getScreenShareCaptureOptions(pick.quality, pick.fps)),
    maxBitrate: getScreenShareMaxBitrate(pick.quality, pick.fps),
    maxFramerate: getEffectiveScreenShareFps(pick.quality, pick.fps),
    simulcast: isScreenShareSimulcast(pick.quality),
  };
}
