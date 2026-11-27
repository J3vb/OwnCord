/**
 * The defaults a new install starts on: Command Deck and the Gunmetal theme.
 * An install that ran before keeps what it had, so it is pinned to Classic
 * and its theme is left alone. The Android app is left out entirely. Kept out of `screenLayout.ts` so the layout
 * module does not import the theme module.
 */

import { isAndroidHost } from "../hostPlatform";
import { isPhoneLayout } from "../ui/phoneLayout";
import { readStored, STORAGE_PREFIX } from "./preferences";
import { SCREEN_LAYOUT_PREF, saveScreenLayout } from "./screenLayout";
import { recordNewInstallTheme } from "./themes";

/** Records the screen layout and, for a new install, the theme, once at
 *  startup. `evidence` is hasInstallEvidence(), read before any startup
 *  write. A stored value is never changed.
 *
 *  The Android app writes nothing: Command Deck runs there only as a
 *  Developer-mode preview, a layout value nobody chose must not decide it if
 *  that ever changes, and a new phone install keeps the theme it had before
 *  Gunmetal. A new phone-sized browser gets Gunmetal but stores Classic, the
 *  layout it runs, so a later release that brings Command Deck to phones does
 *  not switch it unasked. */
export function settleNewInstallDefaults(evidence: boolean): void {
  if (isAndroidHost()) return;
  if (readStored(STORAGE_PREFIX + SCREEN_LAYOUT_PREF) !== null) return;
  if (evidence) {
    saveScreenLayout("classic");
    return;
  }
  recordNewInstallTheme();
  saveScreenLayout(isPhoneLayout() ? "classic" : "deck");
}
