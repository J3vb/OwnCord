/**
 * The concealed stand-in for an external item (B9-8). Kept apart from the
 * consent model, which loads with the startup closure through attachments.ts.
 */

import { createElement, setText } from "@lib/dom";
import { externalConsentText } from "../../i18n/externalConsent";

/** The concealed stand-in for an item: names the host and loads nothing
 *  until its button is activated. */
export function renderConcealedItem(url: string, onActivate: () => void): HTMLDivElement {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // Keep the raw text; the broker would refuse it anyway.
  }
  const wrap = createElement("div", { class: "msg-embed msg-embed-concealed" });
  const button = createElement("button", { type: "button", class: "btn-ghost" });
  setText(button, externalConsentText("item.load", { host }));
  button.addEventListener("click", onActivate);
  wrap.appendChild(button);
  return wrap;
}
