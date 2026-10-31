import { loadPref, savePref } from "@lib/prefs/preferences";

/** How the microphone decides when to transmit: the sensitivity gate
 *  (Voice Activity) or a held key (Push to Talk). */
export type InputMode = "vad" | "ptt";

/** The saved input mode. A profile from before the choice existed has none:
 *  a bound PTT key then means Push to Talk, so nobody's setup changes. */
export function inputMode(): InputMode {
  const saved = loadPref<string>("inputMode", "");
  if (saved === "vad" || saved === "ptt") return saved;
  return loadPref<number>("pttVk", 0) !== 0 ? "ptt" : "vad";
}

/** Persist the derived mode once at startup, so a key bound later while in
 *  Voice Activity mode stays a binding and does not switch the mode. */
export function migrateInputMode(): void {
  const saved = loadPref<string>("inputMode", "");
  if (saved !== "vad" && saved !== "ptt") savePref("inputMode", inputMode());
}

/** The sensitivity the gate runs at. Push to Talk replaces the Voice Activity
 *  threshold (100 = no gate), but only while a bound key can actually gate the
 *  mic (`pttLive`: the poller is running on a host that reports key state);
 *  otherwise the saved sensitivity keeps gating, as before Input Mode. */
export function effectiveVoiceSensitivity(pttLive: boolean): number {
  return pttGates(pttLive) ? 100 : loadPref<number>("voiceSensitivity", 50);
}

/** The on-screen talk button is the Push to Talk trigger (the Android app,
 *  which has no key to bind). Set once at startup by the talk button. */
let talkButton = false;

export function setTalkButton(on: boolean): void {
  talkButton = on;
}

/** Whether Push to Talk gates the mic: the mode is Push to Talk, something can
 *  be pressed (a bound key, or the talk button), and a press can actually be
 *  observed (`pttLive`). The voice session closes the gate at join on this. */
export function pttGates(pttLive: boolean): boolean {
  return inputMode() === "ptt" && (talkButton || loadPref<number>("pttVk", 0) !== 0) && pttLive;
}

/** Whether the gate finds its own threshold above the room's noise floor.
 *  A profile from before the choice existed has none: a sensitivity moved
 *  off the default (50) means the user tuned it, so it stays manual. */
export function autoInputSensitivity(): boolean {
  return loadPref<boolean>("autoInputSensitivity", loadPref<number>("voiceSensitivity", 50) === 50);
}

/** Persist the derived choice once at startup, so a later slider move does
 *  not switch automatic sensitivity off. */
export function migrateAutoInputSensitivity(): void {
  // Saved when both fallbacks read back the same value.
  if (
    loadPref<boolean>("autoInputSensitivity", true) !==
    loadPref<boolean>("autoInputSensitivity", false)
  ) {
    savePref("autoInputSensitivity", autoInputSensitivity());
  }
}

/** The gate the web microphone runs: none ("off") while a Push to Talk key
 *  gates or the sensitivity is 100, the noise-floor estimate ("auto"), or the
 *  saved sensitivity. */
export function effectiveVoiceGate(pttLive: boolean): "off" | "auto" | number {
  if (pttGates(pttLive)) return "off";
  if (autoInputSensitivity()) return "auto";
  const sensitivity = loadPref<number>("voiceSensitivity", 50);
  return sensitivity >= 100 ? "off" : sensitivity;
}
