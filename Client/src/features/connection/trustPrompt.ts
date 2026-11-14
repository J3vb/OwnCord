/**
 * The shared frame of the three trust prompts (certificate first use,
 * certificate change, voice identity key change). Every way out that is not the
 * accept button rejects: the close X, the backdrop, Escape and Cancel. Dismissing
 * a trust prompt must never grant trust.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/ui/a11y";
import { closeOnBackdropClick } from "@lib/ui/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import { connectText } from "../../i18n/connect";

export interface TrustPromptSpec {
  /** Unique per prompt kind; the three prompts never stack with each other. */
  readonly titleId: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly icon: IconName;
  readonly heading: string;
  /** Text lines under the heading, each with its own class. */
  readonly lines: readonly { readonly className: string; readonly text: string }[];
  readonly rows: readonly HTMLElement[];
  readonly rejectText: string;
  readonly acceptText: string;
  /** Start on Cancel so Enter right away declines. */
  readonly focusReject: boolean;
  readonly focusFallback?: () => HTMLElement | null;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

export function createTrustPrompt(spec: TrustPromptSpec): MountableComponent {
  const { onAccept, onReject } = spec;
  let overlay: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;
  const disposable = new Disposable();

  function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
    const btn = createElement("button", { class: className, type: "button" });
    setText(btn, text);
    btn.addEventListener("click", onClick, { signal: disposable.signal });
    return btn;
  }

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal" });
    applyDialogSemantics(modal, { labelledBy: spec.titleId });
    trapFocus(modal, disposable.signal);

    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: spec.titleId }, spec.title);
    // Icon-only control: the aria-label is its entire accessible name.
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": spec.closeLabel,
    });
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });
    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon(spec.icon, 24));
    const heading = createElement("div", { class: "cert-title" });
    setText(heading, spec.heading);
    appendChildren(body, warning, heading);
    for (const line of spec.lines) {
      const el = createElement("div", { class: line.className });
      setText(el, line.text);
      body.appendChild(el);
    }
    const details = createElement("div", { class: "cert-details" });
    for (const row of spec.rows) details.appendChild(row);
    body.appendChild(details);

    const footer = createElement("div", { class: "modal-footer" });
    const rejectBtn = button("btn-ghost", spec.rejectText, onReject);
    appendChildren(footer, rejectBtn, button("btn-danger", spec.acceptText, onAccept));

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);
    closeOnBackdropClick(overlay, () => onReject(), disposable.signal);
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && !isImeCommit(e) && overlay?.isConnected === true) onReject();
      },
      { signal: disposable.signal },
    );

    container.appendChild(overlay);
    restoreFocus = focusDialog(modal, spec.focusFallback);
    if (spec.focusReject) rejectBtn.focus();
  }

  function destroy(): void {
    disposable.destroy();
    if (overlay !== null) {
      overlay.remove();
      overlay = null;
    }
    restoreFocus?.();
    restoreFocus = null;
  }

  return { mount, destroy };
}

/** One label and value line of a prompt's details; a fingerprint gets the mono style. */
export function buildRow(label: string, value: string, isFingerprint: boolean): HTMLDivElement {
  const row = createElement("div", { class: "cert-row" });
  const labelEl = createElement("span", { class: "cert-label" });
  setText(labelEl, label);
  const valueClass = isFingerprint ? "cert-value cert-fingerprint" : "cert-value";
  const valueEl = createElement("span", { class: valueClass });
  setText(valueEl, value || connectText("common.unknown"));
  appendChildren(row, labelEl, valueEl);
  return row;
}
