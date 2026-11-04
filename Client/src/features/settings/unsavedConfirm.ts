/**
 * "Discard unsaved changes?" — asked by the settings overlay before a tab
 * switch or close would throw away profile edits that were never saved.
 *
 * Built on the shared confirm preset like the Log Out prompt: Keep editing is
 * focused first, so a stray Enter or Escape keeps the edits; only Discard lets
 * the switch or close go ahead.
 */

import { createConfirmModal } from "../dialogs/confirmModal";
import { settingsText as t } from "../../i18n/settings";

export interface UnsavedConfirmOptions {
  /** Runs once, only when the user chooses to discard. */
  onDiscard(): void;
  /** Called when the prompt goes away, however it ended. */
  onClosed(): void;
  /** Aborting closes the prompt without discarding. */
  signal: AbortSignal;
  /** Where to mount the prompt, so it stacks above the overlay. */
  container?: Element;
}

/** Open the prompt and return a function that closes it without discarding. */
export function confirmDiscardUnsaved(options: UnsavedConfirmOptions): () => void {
  const modal = createConfirmModal(
    {
      title: t("unsaved.title"),
      titleId: "settings-unsaved-title",
      body: t("unsaved.body"),
      confirmLabel: t("unsaved.discard"),
      cancelLabel: t("unsaved.keep"),
      testId: "unsaved-confirm-dialog",
      confirmTestId: "unsaved-discard",
      cancelTestId: "unsaved-keep",
      signal: options.signal,
      onConfirm: options.onDiscard,
      onClose: options.onClosed,
    },
    options.container,
  );
  return () => modal.close();
}
