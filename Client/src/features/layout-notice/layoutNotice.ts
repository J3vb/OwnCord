/**
 * Shows the Command Deck notice once, to an install the one-time move took
 * from Classic to Command Deck (lib/prefs/deckSwitch.ts sets the notice pref).
 * Closing the dialog clears the pref, so it never shows again; a page torn
 * down under it leaves the pref for the next page.
 */

import type { MountableComponent } from "../../lib/text/safeRender";
import { createLogger } from "../../lib/logger";
import { DECK_NOTICE_PREF } from "../../lib/prefs/deckSwitch";
import { loadPref, removeStored, STORAGE_PREFIX } from "../../lib/prefs/preferences";
import type { LayoutNoticeDialog } from "./LayoutNoticeDialog";

const log = createLogger("layout-notice");

/** Whether the notice still waits to be shown and closed. */
export function deckNoticePending(): boolean {
  return loadPref<boolean>(DECK_NOTICE_PREF, false);
}

/** `onOpenAppearance` opens Settings › Appearance; the page passes it so this
 *  chunk does not pull in the UI store. */
export function createLayoutNotice(onOpenAppearance: () => void): MountableComponent {
  let destroyed = false;
  let dialog: LayoutNoticeDialog | null = null;

  async function run(container: Element): Promise<void> {
    if (!deckNoticePending()) return;
    // The dialog loads only on the start that shows it.
    const { showLayoutNoticeDialog } = await import("./LayoutNoticeDialog");
    if (destroyed || dialog !== null || !deckNoticePending()) return;
    dialog = showLayoutNoticeDialog(container, {
      onOpenSettings: onOpenAppearance,
      onDismissed: () => {
        dialog = null;
        removeStored(STORAGE_PREFIX + DECK_NOTICE_PREF);
      },
    });
  }

  return {
    mount(container: Element): void {
      void run(container).catch((err: unknown) => {
        log.warn("Command Deck notice failed", { error: String(err) });
      });
    },
    destroy(): void {
      destroyed = true;
      dialog?.destroy();
      dialog = null;
    },
  };
}
