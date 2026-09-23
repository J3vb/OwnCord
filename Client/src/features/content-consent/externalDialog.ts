/**
 * The per-server external-content choice (B9-8, Q3), loaded only when the
 * viewer first activates a concealed item. Cancel, Escape and the backdrop
 * choose nothing, so nothing is fetched.
 */

import { appendChildren, createElement } from "@lib/dom";
import { createModal } from "@lib/modalFactory";
import { externalConsentText as t } from "../../i18n/externalConsent";
import type { ExternalConsentChoice } from "./external";

export function askExternalConsent(): Promise<ExternalConsentChoice | null> {
  return new Promise((resolve) => {
    let choice: ExternalConsentChoice | null = null;
    const header = createElement("div", { class: "modal-header" });
    header.appendChild(createElement("h3", { id: "external-consent-title" }, t("dialog.title")));
    const body = createElement("div", { class: "modal-body" });
    body.appendChild(
      createElement(
        "p",
        { class: "modal-danger-text", id: "external-consent-body" },
        t("dialog.body"),
      ),
    );
    const footer = createElement("div", { class: "modal-footer" });
    const button = (cls: string, text: string, value: ExternalConsentChoice | null) => {
      const el = createElement("button", { class: cls, type: "button" }, text);
      el.addEventListener("click", () => {
        choice = value;
        modal.close();
      });
      return el;
    };
    appendChildren(
      footer,
      button("btn-modal-cancel", t("dialog.cancel"), null),
      button("btn-ghost", t("dialog.ask"), "ask"),
      button("btn-modal-save", t("dialog.auto"), "auto"),
    );
    const content = createElement("div");
    appendChildren(content, header, body, footer);
    const modal = createModal({
      content,
      ariaLabelledBy: "external-consent-title",
      overlayAttrs: { "data-testid": "external-consent-dialog" },
      onClose: () => resolve(choice),
    });
    modal.modal.setAttribute("aria-describedby", "external-consent-body");
  });
}
