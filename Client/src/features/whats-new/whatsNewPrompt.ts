/**
 * Shows the "What's new" dialog once, on the first start after the app
 * updated to a version the bundled changelog has notes for. A fresh install,
 * an unchanged version or a version without notes shows nothing.
 */

import type { MountableComponent } from "../../lib/text/safeRender";
import { Disposable } from "../../lib/disposable";
import { createLogger } from "../../lib/logger";
import { readAppVersion } from "./appVersion";
import { isNewVersion, markVersionSeen } from "./seenVersion";
import type { WhatsNewDialog } from "./WhatsNewDialog";

const log = createLogger("whats-new");

/** `onOpenHistory` opens Settings › About; the page passes it so the lazy
 *  dialog chunk does not pull the UI store into a shared startup chunk.
 *  `onSettled` runs once, when this start shows no notes, the check fails, or
 *  the person closes the dialog; never after `destroy()`, and not when Version
 *  history closes it, since Settings then opens over the page. */
export function createWhatsNewPrompt(
  onOpenHistory: () => void,
  onSettled: (container: Element) => void = () => {},
): MountableComponent {
  const owner = new Disposable();
  let dialog: WhatsNewDialog | null = null;
  let settled = false;

  const settle = (container: Element): void => {
    if (settled || owner.signal.aborted) return;
    settled = true;
    onSettled(container);
  };

  /** Shows the notes when this start has some; false when it shows nothing. */
  async function run(container: Element): Promise<boolean> {
    const version = await readAppVersion();
    if (version === null || owner.signal.aborted || !isNewVersion(version)) return false;
    // The changelog and the dialog load only on the start that needs them.
    const [{ loadChangelog }, { findVersion }, { showWhatsNewDialog }] = await Promise.all([
      import("./changelogSource"),
      import("./changelog"),
      import("./WhatsNewDialog"),
    ]);
    const entry = findVersion(await loadChangelog(), version);
    if (owner.signal.aborted) return false;
    markVersionSeen(version);
    if (entry === null) return false;
    dialog = showWhatsNewDialog(container, entry, onOpenHistory, (toHistory) => {
      dialog = null;
      if (!toHistory) settle(container);
    });
    return true;
  }

  return {
    mount(container: Element): void {
      void run(container).then(
        (shown) => {
          if (!shown) settle(container);
        },
        (err: unknown) => {
          log.warn("What's new check failed", { error: String(err) });
          settle(container);
        },
      );
    },
    destroy(): void {
      owner.destroy();
      dialog?.destroy();
      dialog = null;
    },
  };
}
