/**
 * The notices the main page shows over itself once it mounts, one at a time:
 * What's new first, then the Command Deck notice once What's new has closed or
 * found nothing to show, so one never covers the other. When Version history
 * closes What's new, Settings opens instead and the notice waits for the next
 * start.
 */

import type { MountableComponent } from "../../lib/text/safeRender";
import type { SettingsTabRequest } from "../../stores/ui.store";
import { createWhatsNewPrompt } from "../whats-new/whatsNewPrompt";
import { createLayoutNotice } from "./layoutNotice";

/** `openSettings` opens Settings on a tab; the page passes the UI store's own
 *  so this lazy chunk does not pull the store into a shared startup chunk. */
export function createStartupNotices(
  openSettings: (tab: SettingsTabRequest) => void,
): MountableComponent {
  // i18n-exempt: settings tab keys, not shown text
  const layoutNotice = createLayoutNotice(() => openSettings("Appearance"));
  const whatsNew = createWhatsNewPrompt(
    () => openSettings("About"), // i18n-exempt: settings tab key, not shown text
    (container) => layoutNotice.mount(container),
  );
  return {
    mount: (container) => whatsNew.mount(container),
    destroy(): void {
      whatsNew.destroy?.();
      layoutNotice.destroy?.();
    },
  };
}
