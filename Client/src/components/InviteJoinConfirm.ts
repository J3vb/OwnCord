/**
 * "Leave <current server> to join <host>?" — the prompt an invite chip in chat
 * asks before it runs the invite flow, which signs out of the current server.
 * Cancel is focused first so a stray Enter cancels; Escape and the backdrop
 * cancel too.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, createElement } from "@lib/dom";
import { createModal } from "@lib/modalFactory";
import { messagingText } from "../i18n/messaging";

/** The open dialog's live parts, so a later request can take it over. */
interface OpenDialog {
  title: HTMLElement;
  body: HTMLElement;
  confirm: HTMLElement;
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
    open.title.textContent = title;
    open.body.textContent = body;
    open.confirm.textContent = confirmLabel;
    open.onConfirm = onConfirm;
    return;
  }
  const owner = new Disposable();
  const header = createElement("div", { class: "modal-header" });
  const titleEl = createElement("h3", { id: "invite-join-title" }, title);
  header.appendChild(titleEl);
  const bodyEl = createElement("div", { class: "modal-body" });
  const bodyText = createElement("p", {}, body);
  bodyEl.appendChild(bodyText);
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "invite-join-cancel" },
    messagingText("invite.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-primary", type: "button", "data-testid": "invite-join-confirm" },
    confirmLabel,
  );
  const footer = createElement("div", { class: "modal-footer" });
  appendChildren(footer, cancel, confirm);
  const content = createElement("div");
  appendChildren(content, header, bodyEl, footer);

  const dialog: OpenDialog = { title: titleEl, body: bodyText, confirm, onConfirm };
  open = dialog;
  const modal = createModal({
    content,
    ariaLabelledBy: "invite-join-title",
    overlayAttrs: { "data-testid": "invite-join-dialog" },
    onClose: () => {
      open = null;
      owner.destroy();
    },
  });
  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });
  confirm.addEventListener(
    "click",
    () => {
      modal.close();
      dialog.onConfirm();
    },
    { signal: owner.signal },
  );
  cancel.focus();
}
