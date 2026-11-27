/**
 * The one-time move to Command Deck. On its first start of a release that runs
 * Command Deck everywhere, an install that ran before and is on Classic (its
 * own pick, or pinned there when Command Deck first shipped) moves to Command
 * Deck once, and a notice pref asks the main page to say so. A marker pref
 * records that the move was settled, so someone who goes back to Classic stays
 * there. Themes are never touched.
 *
 * A stored Classic with no install evidence is a profile set up that way on
 * purpose (the test harness seeds the layout alone), so it stays Classic.
 */

import { readStored, saveStoredJson, STORAGE_PREFIX } from "./preferences";
import { loadStoredScreenLayout, SCREEN_LAYOUT_PREF } from "./screenLayout";

/** Set once the move is settled, whatever it decided. Survives Clear cache. */
export const DECK_SWITCH_PREF = "deckSwitchDone";

/** Set for an install the move switched, until its notice is closed. */
export const DECK_NOTICE_PREF = "deckSwitchNotice";

/** Runs once per start, after `settleNewInstallDefaults` and before the layout
 *  is applied. `evidence` is hasInstallEvidence(), read before any startup
 *  write. Storage that cannot be written moves no one and leaves no notice. */
export function settleDeckSwitch(evidence: boolean): void {
  if (readStored(STORAGE_PREFIX + DECK_SWITCH_PREF) !== null) return;
  if (evidence && loadStoredScreenLayout() === "classic") {
    if (!saveStoredJson(STORAGE_PREFIX + SCREEN_LAYOUT_PREF, "deck")) return;
    saveStoredJson(STORAGE_PREFIX + DECK_NOTICE_PREF, true);
  }
  saveStoredJson(STORAGE_PREFIX + DECK_SWITCH_PREF, true);
}
