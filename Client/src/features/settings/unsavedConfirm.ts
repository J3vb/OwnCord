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
import type { UnsavedTopic } from "./settingsGuards";

export interface UnsavedConfirmOptions {
  /** What would be lost; picks the wording. Profile edits by default. */
  topic?: UnsavedTopic;
  /** Runs once, only when the user chooses to discard. */
  onDiscard(): void;
  /** Called when the prompt goes away, however it ended. */
  onClosed(): void;
  /** Aborting closes the prompt without discarding. */
  signal: AbortSignal;
  /** Where to mount the prompt, so it stacks above the overlay. */
  container?: Element;
}

const BODY = {
  profile: "unsaved.body",
  theme: "unsaved.themeBody",
  secret: "unsaved.secretBody",
} as const;

/** Open the prompt and return a function that closes it without discarding. */
export function confirmDiscardUnsaved(options: UnsavedConfirmOptions): () => void {
  const modal = createConfirmModal(
    {
      title: t("unsaved.title"),
      titleId: "settings-unsaved-title",
      body: t(BODY[options.topic ?? "profile"]),
      confirmLabel: t("unsaved.discard"),
      cancelLabel: t(options.topic === "secret" ? "unsaved.keepSecret" : "unsaved.keep"),
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
