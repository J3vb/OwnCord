import { appendChildren, createElement } from "../dom";
import { createIcon } from "../icons";

export interface EyebrowHeaderOptions {
  readonly eyebrow: string;
  readonly title: string;
  readonly titleId: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly signal: AbortSignal;
}

/** A modal header with a small eyebrow line over the title and a ✕ button. */
export function buildEyebrowHeader(options: EyebrowHeaderOptions): HTMLElement {
  const header = createElement("div", { class: "modal-header" });
  const heading = createElement("div", {});
  appendChildren(
    heading,
    createElement("div", { class: "whats-new-eyebrow" }, options.eyebrow),
    createElement("h3", { id: options.titleId }, options.title),
  );
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": options.closeLabel,
  });
  closeBtn.appendChild(createIcon("x", 14));
  closeBtn.addEventListener("click", options.onClose, { signal: options.signal });
  appendChildren(header, heading, closeBtn);
  return header;
}
