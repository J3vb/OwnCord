/**
 * "Are you sure you want to log out?" — the confirmation Log Out in the
 * settings overlay asks before it does anything.
 *
 * Built on `createModal` like the other confirm prompts (DM leave, masked
 * link): Cancel is focused first so a stray Enter cancels, Escape and the
 * backdrop cancel, and focus returns to the opener. The prompt is tied to the
 * `signal` it is given (the overlay's lifetime): when that aborts the prompt
 * is removed and its listeners go with it, and nothing is logged out.
 */

import { Disposable } from "../../lib/disposable";
import { appendChildren, createElement } from "../../lib/dom";
import { createModal, type ModalInstance } from "../../lib/modalFactory";
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
}

/**
 * Open the prompt and return a function that closes it without confirming. A
 * second call while one is open does nothing and returns null.
 */
export function confirmLogout(options: LogoutConfirmOptions): (() => void) | null {
  if (openPrompt !== null || options.signal.aborted) return null;
  const owner = new Disposable();
  const titleId = "settings-logout-title";

  const header = createElement("div", { class: "modal-header" });
  header.appendChild(createElement("h3", { id: titleId }, t("logout.confirm.title")));
  const body = createElement("div", { class: "modal-body" });
  body.appendChild(createElement("p", { class: "modal-danger-text" }, t("logout.confirm.body")));
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "logout-cancel" },
    t("common.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-danger", type: "button", "data-testid": "logout-confirm" },
    t("logout.confirm.button"),
  );
  const footer = createElement("div", { class: "modal-footer" });
  appendChildren(footer, cancel, confirm);
  const content = createElement("div");
  appendChildren(content, header, body, footer);

  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "logout-confirm-dialog" },
    signal: options.signal,
    fallbackFocus: options.fallbackFocus,
    onClose: () => {
      openPrompt = null;
      owner.destroy();
      options.onClosed?.();
    },
  });
  openPrompt = modal;
  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });
  confirm.addEventListener(
    "click",
    () => {
      modal.close();
      options.onConfirm();
    },
    { signal: owner.signal },
  );
  // A held Enter would auto-repeat into the focused button.
  modal.modal.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat) e.preventDefault();
    },
    { signal: owner.signal },
  );
  cancel.focus();
  return () => modal.close();
}
