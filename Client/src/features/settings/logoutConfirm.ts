/**
 * "Are you sure you want to log out?" — the confirmation Log Out in the
 * settings overlay asks before it does anything.
 *
 * Built on the shared confirm preset (features/dialogs/confirmModal.ts) like the other
 * confirm prompts (DM leave, masked link): Cancel is focused first so a stray Enter cancels, Escape and the
 * backdrop cancel, and focus returns to the opener. The prompt is tied to the
 * `signal` it is given (the overlay's lifetime): when that aborts the prompt
 * is removed and its listeners go with it, and nothing is logged out.
 */

import { createConfirmModal } from "../dialogs/confirmModal";
import type { ModalInstance } from "../../lib/ui/modalFactory";
import { settingsText as t } from "../../i18n/settings";

let openPrompt: ModalInstance | null = null;

export interface LogoutConfirmOptions {
  /** Runs once, only when the user confirms. */
  onConfirm(): void;
  /** Aborting closes the prompt without confirming. */
  signal: AbortSignal;
  /** Called when the prompt goes away, however it ended. */
  onClosed?(): void;
  /** Focus target on close when the opener is gone. */
  fallbackFocus?(): HTMLElement | null;
  /** Where to mount the prompt; the settings overlay passes its own root so
   *  the prompt stacks above it. Defaults to `document.body`. */
  container?: Element;
}

/**
 * Open the prompt and return a function that closes it without confirming. A
 * second call while one is open does nothing and returns null.
 */
export function confirmLogout(options: LogoutConfirmOptions): (() => void) | null {
  if (openPrompt !== null || options.signal.aborted) return null;
  const modal = createConfirmModal(
    {
      title: t("logout.confirm.title"),
      titleId: "settings-logout-title",
      body: t("logout.confirm.body"),
      confirmLabel: t("logout.confirm.button"),
      cancelLabel: t("common.cancel"),
      testId: "logout-confirm-dialog",
      confirmTestId: "logout-confirm",
      cancelTestId: "logout-cancel",
      signal: options.signal,
      fallbackFocus: options.fallbackFocus,
      onConfirm: options.onConfirm,
      onClose: () => {
        openPrompt = null;
        options.onClosed?.();
      },
    },
    options.container,
  );
  openPrompt = modal;
  return () => modal.close();
}
