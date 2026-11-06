/**
 * The member's own mute and deafen as saved across restarts. Reads and writes
 * preferences only; voice.store.ts applies them to its state.
 */

import { loadPref, savePref } from "@lib/prefs/preferences";
import type { VoiceState } from "./voiceModel";

const SELF_MUTED_PREF = "localMuted";
const SELF_DEAFENED_PREF = "localDeafened";
const MUTED_BEFORE_DEAFEN_PREF = "mutedBeforeDeafen";

export interface SavedSelfVoice {
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
  readonly mutedBeforeDeafen: boolean;
}

/** Save the member's own mute and deafen. A moderator's deafen is not saved,
 *  and while a moderator's mute holds the saved mute keeps its last value. */
export function saveSelfVoicePrefs(state: VoiceState): void {
  if (state.localServerMuted !== true) savePref(SELF_MUTED_PREF, state.localMuted);
  savePref(SELF_DEAFENED_PREF, state.localDeafened && state.moderatorDeafened !== true);
  savePref(MUTED_BEFORE_DEAFEN_PREF, state.mutedBeforeDeafen === true);
}

/** The saved values; a saved deafen always mutes, as the deafen toggle does. */
export function loadSelfVoicePrefs(): SavedSelfVoice {
  const localDeafened = loadPref<boolean>(SELF_DEAFENED_PREF, false);
  return {
    localDeafened,
    localMuted: localDeafened || loadPref<boolean>(SELF_MUTED_PREF, false),
    mutedBeforeDeafen: loadPref<boolean>(MUTED_BEFORE_DEAFEN_PREF, false),
  };
}
