/**
 * The channel side panel's frame: a header (title, optional controls, one
 * Close button) over a scrolling body. Each feature fills the body; the
 * behaviour is sidePanel.ts.
 */

import { appendChildren, createElement } from "../dom";
import { createIcon, type IconName } from "../icons";

export interface SidePanelFrameOptions {
  /** The feature's own class on the frame, which its selectors keep using. */
  readonly className: string;
  readonly label: string;
  readonly title: string;
  readonly icon: IconName;
  /** Muted text after the title, such as the channel. */
  readonly subtitle?: string;
  readonly closeLabel: string;
  readonly testId?: string;
  readonly onClose: () => void;
  readonly signal: AbortSignal;
}

export interface SidePanelFrame {
  readonly root: HTMLDivElement;
  /** The title heading: a feature may append a count to it. */
  readonly title: HTMLHeadingElement;
  /** Controls between the title and Close. */
  readonly controls: HTMLDivElement;
  readonly body: HTMLDivElement;
}

export function createSidePanelFrame(opts: SidePanelFrameOptions): SidePanelFrame {
  // A complementary landmark beside the chat, not a modal: no focus trap.
  const root = createElement("div", {
    class: `side-panel ${opts.className}`,
    role: "complementary",
    tabindex: "-1",
    "aria-label": opts.label,
    ...(opts.testId === undefined ? {} : { "data-testid": opts.testId }),
  });
  const header = createElement("div", { class: "side-panel__header" });
  const title = createElement("h3", { class: "side-panel__title" });
  title.appendChild(createIcon(opts.icon, 16));
  title.appendChild(createElement("span", {}, opts.title));
  if (opts.subtitle !== undefined) {
    title.appendChild(createElement("span", { class: "side-panel__subtitle" }, opts.subtitle));
  }
  const controls = createElement("div", { class: "side-panel__controls" });
  const closeBtn = createElement("button", {
    type: "button",
    class: "side-panel__close",
    "aria-label": opts.closeLabel,
    title: opts.closeLabel,
  });
  closeBtn.appendChild(createIcon("x", 16));
  closeBtn.addEventListener("click", () => opts.onClose(), { signal: opts.signal });
  appendChildren(header, title, controls, closeBtn);
  const body = createElement("div", { class: "side-panel__body" });
  appendChildren(root, header, body);
  return { root, title, controls, body };
}
