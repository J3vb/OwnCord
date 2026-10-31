// The input-sensitivity slider's scale: linear in decibels, as a level gate
// is heard. The saved `voiceSensitivity` (0-100) is the handle's position,
// 0 at the strictest gate and 100 for no gate at all; each step is the same
// loudness change anywhere on the slider.
//
// Before this scale the slider was linear in amplitude: 0-75 covered 12 dB
// of loud levels and every quiet-voice setting sat between 90 and 99. A
// saved value from then is moved once onto this scale by
// migrateVoiceSensitivityScale(), keeping the gate level it had.

import { loadPref, savePref } from "@lib/prefs/preferences";

/** The gate level at sensitivity 100 (just before "no gate"), in dBFS. */
export const GATE_DB_MIN = -70;
/** The gate level at sensitivity 0, in dBFS. */
export const GATE_DB_MAX = -10;

/** The gate level in dBFS for `sensitivity` (0-100). */
export function vadThresholdDb(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  return GATE_DB_MAX - (clamped / 100) * (GATE_DB_MAX - GATE_DB_MIN);
}

/** The RMS a ~10 ms stretch must reach to count as speech at `sensitivity`
 *  (0-100). 100 is no gate at all. */
export function vadThreshold(sensitivity: number): number {
  if (sensitivity >= 100) return 0;
  return 10 ** (vadThresholdDb(sensitivity) / 20);
}

/** Where an RMS level sits on the slider's axis, 0 (GATE_DB_MIN and below)
 *  to 1 (GATE_DB_MAX and above): the meter draws it where the handle for
 *  that level would be. */
export function vadLevelPosition(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - GATE_DB_MIN) / (GATE_DB_MAX - GATE_DB_MIN)));
}

/** The old amplitude-linear slider's gate level at `sensitivity`, as the
 *  RMS it compared against. */
function legacyThreshold(sensitivity: number): number {
  return ((100 - Math.max(0, Math.min(100, sensitivity))) / 100) * 0.1;
}

/** The position on this scale that gates at the level the old scale gated
 *  at for `sensitivity`; 100 (no gate) stays 100. */
export function legacySensitivityToDbScale(sensitivity: number): number {
  if (sensitivity >= 100) return 100;
  const db = 20 * Math.log10(legacyThreshold(sensitivity));
  const position = ((GATE_DB_MAX - db) / (GATE_DB_MAX - GATE_DB_MIN)) * 100;
  return Math.round(Math.max(0, Math.min(99, position)));
}

const SCALE_PREF = "voiceSensitivityScale";

/** Move a saved sensitivity from the old amplitude-linear scale onto this
 *  one, once, so the gate keeps the level the user chose. A profile that
 *  never moved the slider has nothing saved and follows the default on
 *  this scale, manual or automatic, so everyone starts from the same gate.
 *  Runs at startup, after automatic sensitivity's own migration. */
export function migrateVoiceSensitivityScale(): void {
  if (loadPref<string>(SCALE_PREF, "") === "db") return;
  const saved = loadPref<number>("voiceSensitivity", Number.NaN);
  if (Number.isFinite(saved)) {
    savePref("voiceSensitivity", legacySensitivityToDbScale(saved));
  }
  savePref(SCALE_PREF, "db");
}
