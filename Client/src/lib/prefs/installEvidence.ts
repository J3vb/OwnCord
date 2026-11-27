import { DECK_SWITCH_PREF } from "./deckSwitch";
import { STORAGE_PREFIX, storedKeys } from "./preferences";

/** The screen layout key and the Command Deck move marker: the test harness
 *  seeds them alone, so they say nothing about an earlier install. */
const NOT_EVIDENCE = new Set([`${STORAGE_PREFIX}screenLayout`, STORAGE_PREFIX + DECK_SWITCH_PREF]);

/** Whether this storage was used by an earlier launch. Read once, at
 *  startup, before anything writes. */
export function hasInstallEvidence(): boolean {
  return storedKeys().some((key) => key.startsWith("owncord:") && !NOT_EVIDENCE.has(key));
}
