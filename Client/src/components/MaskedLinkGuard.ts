/**
 * The warning before a masked link (`[label](url)`) leaves the app: the visible
 * text is not the address, so the viewer sees where it really goes first.
 * Loaded on demand from main.ts's link handler — nothing here is on the
 * startup path. Cancel, Escape and the backdrop open nothing; focus starts on
 * Cancel and Enter acts on whichever button has focus.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, createElement } from "@lib/dom";
import { createModal } from "@lib/modalFactory";
import { isDomainTrusted, linkDomain, trustDomain } from "@lib/trustedDomains";
import { messagingText } from "../i18n/messaging";
import { shellText } from "../i18n/shell";

let dialogShown = false;

/**
 * Open `href` through `open`, after asking first unless its domain was trusted.
 * A URL with no usable http(s) host is never opened.
 */
export function guardMaskedLink(href: string, open: (url: string) => void): void {
  const domain = linkDomain(href);
  if (domain === null) return;
  if (isDomainTrusted(domain)) {
    open(href);
    return;
  }

  // A double-click must not stack two dialogs.
  if (dialogShown) return;
  dialogShown = true;
  const owner = new Disposable();
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(
    createElement("h3", { id: "masked-link-title" }, messagingText("maskedLink.title")),
  );

  const body = createElement("div", { class: "modal-body" });
  const urlEl = createElement("div", {
    class: "masked-link-url",
    "data-testid": "masked-link-url",
  });
  urlEl.textContent = href;
  const trustRow = createElement("label", { class: "form-check masked-link-trust" });
  const trustBox = createElement("input", {
    type: "checkbox",
    "data-testid": "masked-link-trust",
  });
  appendChildren(
    trustRow,
    trustBox,
    createElement("span", {}, messagingText("maskedLink.trust", { domain })),
  );
  appendChildren(
    body,
    createElement("p", { id: "masked-link-body" }, messagingText("maskedLink.body")),
    urlEl,
    trustRow,
  );

  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "masked-link-cancel" },
    shellText("common.cancel"),
  );
  const go = createElement(
    "button",
    { class: "btn-modal-save", type: "button", "data-testid": "masked-link-go" },
    messagingText("maskedLink.go"),
  );
  appendChildren(footer, cancel, go);
  const content = createElement("div");
  appendChildren(content, header, body, footer);

  const modal = createModal({
    content,
    ariaLabelledBy: "masked-link-title",
    overlayAttrs: { "data-testid": "masked-link-dialog" },
    onClose: () => {
      dialogShown = false;
      owner.destroy();
    },
  });
  modal.modal.setAttribute("aria-describedby", "masked-link-body");

  const confirm = (): void => {
    if (trustBox.checked) trustDomain(domain);
    modal.close();
    open(href);
  };
  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });
  go.addEventListener("click", confirm, { signal: owner.signal });

  // Focus starts on Cancel, so a stray Enter cancels rather than confirms. A
  // held Enter would auto-repeat into the focused button: ignore the repeats.
  cancel.focus();
  modal.modal.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat) e.preventDefault();
    },
    { signal: owner.signal },
  );
}
