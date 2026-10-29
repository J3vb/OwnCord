/**
 * "Join with an invite link" dialog opened by the server rail's compass: one
 * field, an inline error for a link that is not an invite, and a submit that
 * closes the dialog only when the link was accepted.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import { shellText } from "../i18n/shell";
import { serverRailText } from "../i18n/serverRail";

export interface JoinModalOptions {
  /** Called with the trimmed input; returns false when it is not a usable invite. */
  readonly onSubmit: (value: string) => boolean;
  readonly onClose?: () => void;
}

export function openServerRailJoinModal(options: JoinModalOptions): ModalInstance {
  const form = createElement("form", { class: "server-rail-join-form", novalidate: "" });
  const title = createElement("h3", { id: "server-rail-join-title" }, serverRailText("joinTitle"));
  const label = createElement(
    "label",
    { class: "server-rail-join-label", for: "server-rail-join-input" },
    serverRailText("joinLabel"),
  );
  const input = createElement("input", {
    id: "server-rail-join-input",
    type: "text",
    class: "server-rail-join-input",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: serverRailText("joinPlaceholder"),
    "data-testid": "server-rail-join-input",
  });
  const error = createElement("p", {
    class: "server-rail-join-error",
    role: "alert",
    "data-testid": "server-rail-join-error",
  });
  error.hidden = true;
  const cancel = createElement(
    "button",
    { type: "button", class: "btn btn-secondary", "data-testid": "server-rail-join-cancel" },
    shellText("common.cancel"),
  );
  const submit = createElement(
    "button",
    { type: "submit", class: "btn btn-primary", "data-testid": "server-rail-join-submit" },
    serverRailText("joinConfirm"),
  );
  const footer = createElement("div", { class: "server-rail-join-actions" });
  appendChildren(footer, cancel, submit);
  appendChildren(form, title, label, input, error, footer);

  const modal = createModal({
    content: form,
    ariaLabelledBy: "server-rail-join-title",
    overlayAttrs: { "data-testid": "server-rail-join-dialog" },
    ...(options.onClose !== undefined ? { onClose: options.onClose } : {}),
  });

  cancel.addEventListener("click", () => modal.close());
  input.addEventListener("input", () => {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (options.onSubmit(input.value.trim())) {
      modal.close();
      return;
    }
    setText(error, serverRailText("joinInvalid"));
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  });
  input.focus();
  return modal;
}
