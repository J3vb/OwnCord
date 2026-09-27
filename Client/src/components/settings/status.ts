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
