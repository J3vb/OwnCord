/**
 * Settings previews of the app sounds. A preview is an explicit press, so it
 * plays through `playSpec` (the saved volume and output device, the Linux
 * host) but skips every gate (deafen, Do Not Disturb, the switches), and it
 * never touches the ring and ringback timers. It plays its sounds one after
 * another in the style saved when each starts, with a pause between them.
 * One preview runs at a time: starting one cuts the one before.
 */

import { setOwnedTimeout } from "../dom";
import { loadSoundStyle } from "../prefs/soundPrefs";
import { playSpec, type Playing } from "./notificationSound";
import { soundSpec, type AppSound, type ToneSpec } from "./soundTables";

/** The silence between one sound's end and the next one's start, in ms. */
export const PREVIEW_GAP_MS = 300;

/** How long `spec` sounds, in ms: its latest note end, release included. */
export function specLengthMs(spec: ToneSpec): number {
  let end = 0;
  for (const n of spec) end = Math.max(end, n.at + n.duration + (n.release ?? 0));
  return end * 1000;
}

/** A running preview. */
export interface SoundPreview {
  /** Cut the sound in flight and play nothing more. Idempotent. */
  stop(): void;
}

let current: SoundPreview | null = null;
const noop = (): void => undefined;

/**
 * Play `sounds` in order, each starting `PREVIEW_GAP_MS` after the previous
 * one ended. `signal` owns the timers: aborting it stops the preview. `onEnd`
 * runs once when the preview ends, whether it finished, was stopped or was
 * cut by a newer one; never from inside this call. With nothing to play, or
 * an owner that already ended, nothing starts: the result is `null` and
 * `onEnd` never runs.
 */
export function previewSounds(
  sounds: readonly AppSound[],
  signal: AbortSignal,
  onEnd: () => void = noop,
): SoundPreview | null {
  current?.stop();
  if (sounds.length === 0 || signal.aborted) return null;
  let playing: Playing | null = null;
  let cancelTimer = noop;
  let ended = false;

  const end = (cut: boolean): void => {
    if (ended) return;
    ended = true;
    cancelTimer();
    if (cut) playing?.stop();
    signal.removeEventListener("abort", stop);
    if (current === preview) current = null;
    onEnd();
  };
  const stop = (): void => end(true);
  const preview: SoundPreview = { stop };

  const step = (i: number): void => {
    const sound = sounds[i];
    if (sound === undefined) {
      end(false);
      return;
    }
    const spec = soundSpec(loadSoundStyle(), sound);
    // i18n-exempt: log text, never displayed
    playing = playSpec(spec, "Sound preview");
    const gap = i + 1 < sounds.length ? PREVIEW_GAP_MS : 0;
    cancelTimer = setOwnedTimeout(signal, () => step(i + 1), specLengthMs(spec) + gap);
  };

  current = preview;
  signal.addEventListener("abort", stop, { once: true });
  step(0);
  return preview;
}
