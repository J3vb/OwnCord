/**
 * Preferences for the app's own sounds: one master volume and one
 * on/off switch per sound. Kept in a leaf module (preferences only) so the
 * settings tab, the sound player, `notifications.ts` and the voice sound
 * subscriber can all read them without importing one another.
 *
 * Each per-sound switch sits *under* an existing group switch
 * (`notificationSounds`, `callSounds`, `voiceSounds`, whose keys and meaning
 * are unchanged): a sound plays only when its group switch AND its own switch
 * are on. A per-sound switch that was never set is on, so nobody loses a
 * sound they have today.
 */

import { loadPref } from "./preferences";

/** The master volume pref, 0-100. 100 (the default) is today's level. */
export const APP_SOUNDS_VOLUME_KEY = "appSoundsVolume";

/** Every sound that has its own switch. */
export type SoundSwitch =
  "message" | "mention" | "ring" | "ringback" | "joinLeave" | "muteDeafen" | "stream";

/** The pref key behind each per-sound switch. */
export const SOUND_SWITCH_KEYS: Readonly<Record<SoundSwitch, string>> = {
  message: "soundMessage",
  mention: "soundMention",
  ring: "soundRing",
  ringback: "soundRingback",
  joinLeave: "soundJoinLeave",
  muteDeafen: "soundMuteDeafen",
  stream: "soundStream",
};

/** Is this sound's own switch on? (Not the group switch above it.) */
export function soundSwitchOn(sound: SoundSwitch): boolean {
  return loadPref<boolean>(SOUND_SWITCH_KEYS[sound], true);
}

/** The saved master volume as a gain in [0, 1]; a bad stored value reads as 100%. */
export function loadAppSoundsGain(): number {
  const percent = loadPref<number>(APP_SOUNDS_VOLUME_KEY, 100);
  if (!Number.isFinite(percent)) return 1;
  return Math.min(100, Math.max(0, percent)) / 100;
}
