/**
 * Status icons and disclosures for the settings tabs (UX clarity pass).
 * Kept out of helpers.ts, which loads at startup: only the lazy tabs use these.
 */

import { createElement } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";

/** ok = working, warn = needs attention, crit = broken, pending = not known yet. */
export type StatusKind = "ok" | "warn" | "crit" | "pending";

const STATUS_ICONS: Readonly<Record<StatusKind, IconName>> = {
  ok: "circle-check",
  warn: "triangle-alert",
  crit: "circle-x",
  pending: "circle-dashed",
};

/** A status icon. Decorative (aria-hidden): always pair it with words. */
export function statusIcon(kind: StatusKind): HTMLSpanElement {
  const span = createElement("span", { class: `st-ic st-${kind}` });
  span.appendChild(createIcon(STATUS_ICONS[kind], 18));
  return span;
}

/** Point an existing status icon at `kind`. */
export function setStatusIcon(span: HTMLElement, kind: StatusKind): void {
  span.className = `st-ic st-${kind}`;
  span.replaceChildren(createIcon(STATUS_ICONS[kind], 18));
}

/**
 * A closed native disclosure (`<details>`) titled `label`. `count` is a muted
 * span in the summary for the state a reader needs before opening it.
 */
export function createDisclosure(label: string): {
  details: HTMLDetailsElement;
  count: HTMLSpanElement;
} {
  const details = createElement("details", { class: "disclose" });
  const summary = createElement("summary", {});
  const count = createElement("span", { class: "disclose-count" });
  summary.appendChild(createIcon("chevron-right", 16));
  // One text block beside the chevron, so a narrow pane wraps words, not the
  // icon; the space keeps label and count apart in the accessible name.
  const text = createElement("span", {});
  text.append(createElement("span", { class: "disclose-label" }, label), " ", count);
  summary.appendChild(text);
  details.appendChild(summary);
  return { details, count };
}

/**
 * A status row: icon, name and result on one line, then a full-width body.
 * The caller paints the icon (`setStatusIcon`), fills the result and adds any
 * action between result and body.
 */
export function createStatusRow(
  name: string,
  testId: string,
): { row: HTMLLIElement; icon: HTMLSpanElement; result: HTMLSpanElement; body: HTMLDivElement } {
  const row = createElement("li", { class: "status-item", "data-testid": testId });
  const icon = statusIcon("pending");
  const result = createElement("span", { class: "status-result" });
  const body = createElement("div", { class: "status-body" });
  row.append(icon, createElement("span", { class: "status-name" }, name), result, body);
  return { row, icon, result, body };
}

let revealIds = 0;

/**
 * A secondary button that shows and hides `panel` (hidden to start), with
 * aria-expanded and aria-controls kept in step.
 */
export function createRevealToggle(
  label: string,
  panel: HTMLElement,
  signal: AbortSignal,
  testId: string,
): HTMLButtonElement {
  if (panel.id === "") panel.id = `settings-reveal-${++revealIds}`;
  panel.hidden = true;
  const button = createElement(
    "button",
    {
      class: "ac-btn secondary",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": panel.id,
      "data-testid": testId,
    },
    label,
  );
  button.addEventListener(
    "click",
    () => {
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
    },
    { signal },
  );
  return button;
}
