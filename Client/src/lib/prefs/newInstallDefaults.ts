/**
 * The defaults a new install starts on: Command Deck and the Gunmetal theme.
 * An install that ran before keeps what it had, so it is pinned to Classic
 * and its theme is left alone. Kept out of `screenLayout.ts` so the layout
 * module does not import the theme module.
 */

import { isAndroidHost } from "../hostPlatform";
import { readStored, STORAGE_PREFIX } from "./preferences";
import { SCREEN_LAYOUT_PREF, saveScreenLayout } from "./screenLayout";
import { recordNewInstallTheme } from "./themes";

/** Records the screen layout and, for a new install, the theme, once at
 *  startup. `evidence` is hasInstallEvidence(), read before any startup
 *  write. A stored value is never changed.
 *
 *  The Android app stores no layout: Command Deck does not run there, and a
 *  value nobody chose must not decide it if that ever changes. It still gets
 *  the new-install theme, so the theme write comes before the Android check. */
export function settleNewInstallDefaults(evidence: boolean): void {
  if (readStored(STORAGE_PREFIX + SCREEN_LAYOUT_PREF) !== null) return;
  if (evidence) {
    if (!isAndroidHost()) saveScreenLayout("classic");
    return;
  }
  recordNewInstallTheme();
  if (!isAndroidHost()) saveScreenLayout("deck");
}
