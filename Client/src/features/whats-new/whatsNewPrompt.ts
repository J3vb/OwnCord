/**
 * Shows the "What's new" dialog once, on the first start after the app
 * updated to a version the bundled changelog has notes for. A fresh install,
 * an unchanged version or a version without notes shows nothing.
 */

import type { MountableComponent } from "../../lib/safe-render";
import { Disposable } from "../../lib/disposable";
import { createLogger } from "../../lib/logger";
import { desktop } from "../../platform/desktop";
import { isNewVersion, markVersionSeen } from "./seenVersion";
import type { WhatsNewDialog } from "./WhatsNewDialog";

const log = createLogger("whats-new");

async function readVersion(): Promise<string | null> {
  try {
    const v = await desktop.appMetadata.getVersion();
    return typeof v === "string" && v !== "" ? v.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

export function createWhatsNewPrompt(): MountableComponent {
  const owner = new Disposable();
  let dialog: WhatsNewDialog | null = null;

  async function run(container: Element): Promise<void> {
    const version = await readVersion();
    if (version === null || owner.signal.aborted || !isNewVersion(version)) return;
    // The changelog and the dialog load only on the start that needs them.
    const [{ loadChangelog }, { findVersion }, { showWhatsNewDialog }] = await Promise.all([
      import("./changelogSource"),
      import("./changelog"),
      import("./WhatsNewDialog"),
    ]);
    const entry = findVersion(await loadChangelog(), version);
    if (owner.signal.aborted) return;
    markVersionSeen(version);
    if (entry === null) return;
    dialog = showWhatsNewDialog(container, entry, () => {
      dialog = null;
    });
  }

  return {
    mount(container: Element): void {
      void run(container).catch((err: unknown) => {
        log.warn("What's new check failed", { error: String(err) });
      });
    },
    destroy(): void {
      owner.destroy();
      dialog?.destroy();
      dialog = null;
    },
  };
}
