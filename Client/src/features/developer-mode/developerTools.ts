/**
 * Developer Mode helpers shared by the context menus (message, member,
 * channel): whether the preference is on, and a copy that reports its outcome.
 */

import { loadPref, onPrefChange } from "../../lib/prefs/preferences";
import { messagingText } from "../../i18n/messaging";
import { copyThenToast } from "../../lib/ui/clipboard";

/** Cached value of the developerMode preference. Invalidated on pref change. */
let developerModeEnabled = loadPref<boolean>("developerMode", false);
onPrefChange(["developerMode"], () => {
  developerModeEnabled = loadPref<boolean>("developerMode", false);
});

/** Whether Developer Mode is on: the copy-ID entries on the context menus. */
export function isDeveloperMode(): boolean {
  return developerModeEnabled;
}

type MessagingKey = Parameters<typeof messagingText>[0];

/** Copy `text`, then say whether it worked: a copy with no feedback is
 *  indistinguishable from a clipboard that refused. */
export function copyWithToast(text: string, done: MessagingKey, failed: MessagingKey): void {
  copyThenToast(text, messagingText(done), messagingText(failed));
}
