// The "Automatically play cameras" preference (Voice & Video settings).
import { loadPref } from "../../lib/prefs/preferences";

export const AUTO_PLAY_CAMERAS_PREF = "autoPlayCameras";

/** Remote cameras play without a Watch click (default on); off, each one
 *  waits behind Watch stream like a screen share. */
export function autoPlayCameras(): boolean {
  return loadPref<boolean>(AUTO_PLAY_CAMERAS_PREF, true);
}
