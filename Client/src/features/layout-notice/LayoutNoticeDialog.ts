/**
 * The "OwnCord now uses Command Deck" dialog, in the What's new dialog's look:
 * shown once to someone the one-time move took from Classic to Command Deck,
 * with the way back. Every way a person closes it (✕, Esc, the backdrop, either
 * button) calls `onDismissed`; `destroy()` from the page removes it silently.
 */

import { isImeCommit } from "../../lib/text/ime";
import { Disposable } from "../../lib/disposable";
import { applyDialogSemantics, focusDialog, trapFocus } from "../../lib/ui/a11y";
import { closeOnBackdropClick } from "../../lib/ui/modalFactory";
import { buildEyebrowHeader } from "../../lib/ui/eyebrowHeader";
import { appendChildren, createElement } from "../../lib/dom";
import { layoutNoticeText as t } from "../../i18n/layoutNotice";

export interface LayoutNoticeDialog {
  destroy(): void;
}

export interface LayoutNoticeHandlers {
  /** Opens Settings on the Appearance tab, after the dialog has closed. */
  readonly onOpenSettings: () => void;
  /** The person closed the dialog, by any of its ways. */
  readonly onDismissed: () => void;
}

/** The way back, with the settings path and the layout name in bold. The
 *  sentence stays whole in the catalog; it is split at markers no catalog
 *  text contains. */
function switchBackParagraph(): HTMLParagraphElement {
  const [before = "", middle = "", after = ""] = t("dialog.switchBack", {
    path: "\u0000",
    layout: "\u0000",
  }).split("\u0000");
  const p = createElement("p", {});
  appendChildren(
    p,
    before,
    createElement("strong", {}, t("dialog.path")),
    middle,
    createElement("strong", {}, t("dialog.classic")),
    after,
  );
  return p;
}

function buildHeader(onClose: () => void, signal: AbortSignal): HTMLElement {
  return buildEyebrowHeader({
    eyebrow: t("dialog.eyebrow"),
    title: t("dialog.title"),
    titleId: "layout-notice-title",
    closeLabel: t("dialog.closeLabel"),
    onClose,
    signal,
  });
}

function buildFooter(
  onClose: () => void,
  onOpenSettings: () => void,
  signal: AbortSignal,
): HTMLElement {
  const footer = createElement("div", { class: "modal-footer" });
  const settingsBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "data-testid": "layout-notice-settings" },
    t("dialog.openSettings"),
  );
  settingsBtn.addEventListener(
    "click",
    () => {
      onClose();
      onOpenSettings();
    },
    { signal },
  );
  const doneBtn = createElement(
    "button",
    { class: "ac-btn", type: "button", "data-testid": "layout-notice-done" },
    t("dialog.gotIt"),
  );
  doneBtn.addEventListener("click", onClose, { signal });
  const actions = createElement("div", { class: "whats-new-actions" });
  appendChildren(actions, settingsBtn, doneBtn);
  footer.appendChild(actions);
  return footer;
}

export function showLayoutNoticeDialog(
  container: Element,
  handlers: LayoutNoticeHandlers,
): LayoutNoticeDialog {
  const disposable = new Disposable();
  const overlay = createElement("div", {
    class: "modal-overlay visible whats-new-overlay",
    "data-testid": "layout-notice-dialog",
  });
  const modal = createElement("div", { class: "modal whats-new-modal" });
  applyDialogSemantics(modal, { labelledBy: "layout-notice-title" });
  trapFocus(modal, disposable.signal);

  let restoreFocus: (() => void) | null = null;
  let removed = false;
  const remove = (): boolean => {
    if (removed) return false;
    removed = true;
    disposable.destroy();
    overlay.remove();
    restoreFocus?.();
    restoreFocus = null;
    return true;
  };
  const close = (): void => {
    if (remove()) handlers.onDismissed();
  };

  const body = createElement("div", { class: "modal-body layout-notice-body" });
  appendChildren(body, createElement("p", {}, t("dialog.same")), switchBackParagraph());

  appendChildren(
    modal,
    buildHeader(close, disposable.signal),
    body,
    buildFooter(close, handlers.onOpenSettings, disposable.signal),
  );
  overlay.appendChild(modal);
  closeOnBackdropClick(overlay, close, disposable.signal);
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      // Only an Esc meant for this dialog: not one a dialog on top already
      // handled, and not one typed while focus is elsewhere.
      if (e.key !== "Escape" || e.defaultPrevented || isImeCommit(e)) return;
      if (modal.contains(document.activeElement)) close();
    },
    { signal: disposable.signal },
  );

  container.appendChild(overlay);
  restoreFocus = focusDialog(modal);
  return { destroy: () => void remove() };
}
