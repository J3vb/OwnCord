/**
 * "Leave <current server> to join <host>?" — the prompt an invite chip in chat
 * asks before it runs the invite flow, which signs out of the current server.
 * Cancel is focused first so a stray Enter cancels; Escape and the backdrop
 * cancel too.
 */

import { createElement } from "@lib/dom";
import { createConfirmModal, type ConfirmModalInstance } from "@lib/confirmModal";
import { onAuthCleared } from "@stores/auth.store";
import { messagingText } from "../i18n/messaging";

/** The open dialog, so a later request can take it over. */
interface OpenDialog {
  readonly modal: ConfirmModalInstance;
  readonly bodyText: HTMLElement;
  onConfirm: () => void;
}
let open: OpenDialog | null = null;

/** Wording overrides; the in-chat chip uses the defaults. */
export interface InviteConfirmText {
  readonly title?: string;
  readonly confirmLabel?: string;
}

/**
 * Ask first; `onConfirm` runs only when the user confirms. At most one dialog
 * is ever open: a request that arrives while it is showing replaces its text
 * and its action, so the latest invite wins and the earlier one is dropped.
 */
export function confirmInviteJoin(
  body: string,
  onConfirm: () => void,
  text: InviteConfirmText = {},
): void {
  const title = text.title ?? messagingText("invite.confirmTitle");
  const confirmLabel = text.confirmLabel ?? messagingText("invite.confirmButton");
  if (open !== null) {
    open.modal.title.textContent = title;
    open.bodyText.textContent = body;
    open.modal.confirm.textContent = confirmLabel;
    open.onConfirm = onConfirm;
    // The text changed under the user: put them back on the safe choice.
    open.modal.cancel.focus();
    return;
  }
  const bodyText = createElement("p", {}, body);
  let stopAuthWatch: (() => void) | null = null;
  const modal = createConfirmModal({
    title,
    titleId: "invite-join-title",
    body: bodyText,
    confirmLabel,
    cancelLabel: messagingText("invite.cancel"),
    tone: "primary",
    testId: "invite-join-dialog",
    confirmTestId: "invite-join-confirm",
    cancelTestId: "invite-join-cancel",
    // Read at click time: a later request swaps the action.
    onConfirm: () => dialog.onConfirm(),
    onClose: () => {
      open = null;
      stopAuthWatch?.();
    },
  });
  const dialog: OpenDialog = { modal, bodyText, onConfirm };
  open = dialog;
  // Any end of the session (logout, 401, server switch) drops the prompt.
  stopAuthWatch = onAuthCleared(() => modal.close());
}
