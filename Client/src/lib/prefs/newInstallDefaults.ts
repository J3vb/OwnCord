/**
 * The defaults a new install starts on: Command Deck everywhere, and the
 * Gunmetal theme everywhere but the Android app, where a new install keeps the
 * theme it had before Gunmetal. An install that ran before keeps its theme;
 * its layout is settled once by `settleDeckSwitch` (deckSwitch.ts). Kept out of
 * `screenLayout.ts` so the layout module does not import the theme module.
 */

import { isAndroidHost } from "../hostPlatform";
import { settleDeckSwitch } from "./deckSwitch";
import { readStored, STORAGE_PREFIX } from "./preferences";
import { SCREEN_LAYOUT_PREF, saveScreenLayout } from "./screenLayout";
import { recordNewInstallTheme } from "./themes";

/** Records the screen layout and, outside the Android app, the theme of a new
 *  install, once at startup. `evidence` is hasInstallEvidence(), read before
 *  any startup write. A stored value is never changed. */
export function settleNewInstallDefaults(evidence: boolean): void {
  if (evidence || readStored(STORAGE_PREFIX + SCREEN_LAYOUT_PREF) !== null) return;
  if (!isAndroidHost()) recordNewInstallTheme();
  saveScreenLayout("deck");
}

/** The startup layout settles, in order: a new install's defaults, then the
 *  one-time move to Command Deck. Runs before the layout is applied. */
export function settleStartupLayout(evidence: boolean): void {
  settleNewInstallDefaults(evidence);
  settleDeckSwitch(evidence);
}
