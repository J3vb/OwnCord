/**
 * The "What's new" dialog: one version's release notes, shown once after the
 * app updates (whatsNewPrompt.ts). Version history and the repository link
 * live on Settings › About, which the dialog links to.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "../../lib/disposable";
import { applyDialogSemantics, focusDialog, trapFocus } from "../../lib/ui/a11y";
import { closeOnBackdropClick } from "../../lib/ui/modalFactory";
import { createElement, appendChildren } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import { whatsNewText as t } from "../../i18n/whatsNew";
import { REPO_URL, renderChangelogBody } from "./changelog";
import type { ChangelogVersion } from "./changelog";

export interface WhatsNewDialog {
  destroy(): void;
}

export function showWhatsNewDialog(
  container: Element,
  entry: ChangelogVersion,
  onOpenHistory: () => void,
  onClosed: () => void,
): WhatsNewDialog {
  const disposable = new Disposable();
  const overlay = createElement("div", {
    class: "modal-overlay visible whats-new-overlay",
    "data-testid": "whats-new-dialog",
  });
  const modal = createElement("div", { class: "modal whats-new-modal" });
  applyDialogSemantics(modal, { labelledBy: "whats-new-title" });
  trapFocus(modal, disposable.signal);

  let restoreFocus: (() => void) | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    disposable.destroy();
    overlay.remove();
    restoreFocus?.();
    restoreFocus = null;
    onClosed();
  };

  const header = createElement("div", { class: "modal-header" });
  const heading = createElement("div", {});
  appendChildren(
    heading,
    createElement(
      "div",
      { class: "whats-new-eyebrow" },
      t("dialog.updatedTo", { version: entry.version }),
    ),
    createElement("h3", { id: "whats-new-title" }, t("dialog.title")),
  );
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": t("dialog.closeLabel"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  closeBtn.addEventListener("click", close, { signal: disposable.signal });
  appendChildren(header, heading, closeBtn);

  // Focusable so the keyboard can scroll long notes (WebKitGTK does not
  // scroll an overflow box that has no focusable content).
  const body = createElement("div", {
    class: "modal-body whats-new-body",
    tabindex: "0",
    role: "region",
    "aria-labelledby": "whats-new-title",
  });
  body.appendChild(renderChangelogBody(entry.body));

  const footer = createElement("div", { class: "modal-footer whats-new-footer" });
  const repo = createElement("a", {
    class: "whats-new-repo",
    href: REPO_URL,
    target: "_blank",
    rel: "noopener noreferrer",
  });
  repo.append(t("about.github"), " ");
  repo.appendChild(createIcon("external-link", 14));
  const historyBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button" },
    t("dialog.history"),
  );
  historyBtn.addEventListener(
    "click",
    () => {
      close();
      onOpenHistory();
    },
    { signal: disposable.signal },
  );
  const doneBtn = createElement("button", { class: "ac-btn", type: "button" }, t("dialog.close"));
  doneBtn.addEventListener("click", close, { signal: disposable.signal });
  const actions = createElement("div", { class: "whats-new-actions" });
  appendChildren(actions, historyBtn, doneBtn);
  appendChildren(footer, repo, actions);

  appendChildren(modal, header, body, footer);
  overlay.appendChild(modal);
  closeOnBackdropClick(overlay, () => close(), disposable.signal);
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isImeCommit(e)) close();
    },
    { signal: disposable.signal },
  );

  container.appendChild(overlay);
  restoreFocus = focusDialog(modal);
  return { destroy: close };
}
