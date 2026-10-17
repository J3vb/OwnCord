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

let dialogShown = false;

/** Ask first; `onConfirm` runs only when the user confirms. */
export function confirmInviteJoin(body: string, onConfirm: () => void): void {
  // A double-click must not stack two dialogs.
  if (dialogShown) return;
  dialogShown = true;
  const owner = new Disposable();
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(
    createElement("h3", { id: "invite-join-title" }, messagingText("invite.confirmTitle")),
  );
  const bodyEl = createElement("div", { class: "modal-body" });
  bodyEl.appendChild(createElement("p", {}, body));
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "invite-join-cancel" },
    messagingText("invite.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-primary", type: "button", "data-testid": "invite-join-confirm" },
    messagingText("invite.confirmButton"),
  );
  const footer = createElement("div", { class: "modal-footer" });
  appendChildren(footer, cancel, confirm);
  const content = createElement("div");
  appendChildren(content, header, bodyEl, footer);

  const modal = createModal({
    content,
    ariaLabelledBy: "invite-join-title",
    overlayAttrs: { "data-testid": "invite-join-dialog" },
    onClose: () => {
      dialogShown = false;
      owner.destroy();
    },
  });
  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });
  confirm.addEventListener(
    "click",
    () => {
      modal.close();
      onConfirm();
    },
    { signal: owner.signal },
  );
  cancel.focus();
}
