import { loadPref, savePref } from "@lib/preferences";

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
  const pttGates = inputMode() === "ptt" && loadPref<number>("pttVk", 0) !== 0 && pttLive;
  return pttGates ? 100 : loadPref<number>("voiceSensitivity", 50);
}
