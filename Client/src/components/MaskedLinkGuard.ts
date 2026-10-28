/**
 * The warning before a masked link (`[label](url)`) leaves the app: the visible
 * text is not the address, so the viewer sees where it really goes first.
 * Loaded on demand from main.ts's link handler — nothing here is on the
 * startup path. Cancel, Escape and the backdrop open nothing; focus starts on
 * Cancel and Enter acts on whichever button has focus.
 */

import { appendChildren, createElement } from "@lib/dom";
import { createConfirmModal } from "../features/dialogs/confirmModal";
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

  // Focus starts on Cancel, so a stray Enter cancels rather than confirms.
  createConfirmModal({
    title: messagingText("maskedLink.title"),
    titleId: "masked-link-title",
    body: [
      createElement("p", { id: "masked-link-body" }, messagingText("maskedLink.body")),
      urlEl,
      trustRow,
    ],
    confirmLabel: messagingText("maskedLink.go"),
    cancelLabel: shellText("common.cancel"),
    tone: "primary",
    testId: "masked-link-dialog",
    confirmTestId: "masked-link-go",
    cancelTestId: "masked-link-cancel",
    describedBy: "masked-link-body",
    onConfirm: () => {
      if (trustBox.checked) trustDomain(domain);
      open(href);
    },
    onClose: () => {
      dialogShown = false;
    },
  });
}
