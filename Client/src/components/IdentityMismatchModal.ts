/**
 * IdentityMismatchModal — the E2EE identity-key trust prompt. Kept out of
 * CertMismatchModal.ts because only the main page opens it, so it and its
 * copy load with the main page instead of the startup chunk.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import type { MountableComponent } from "@lib/safe-render";
import { buildRow } from "./CertMismatchModal";
import { shellText } from "../i18n/shell";

export interface IdentityMismatchModalOptions {
  readonly username: string;
  /** The peer's newly-delivered identity-key fingerprint (safety number) for
   *  out-of-band verification before re-pinning; null when it can't be computed. */
  readonly fingerprint: string | null;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

/**
 * createIdentityMismatchModal — the E2EE-identity analogue of the cert-mismatch
 * modal (F3 TOFU). A peer's voice identity key no longer matches the pinned one:
 * either a legitimate key rotation (reinstall / new device / wiped keyring) or a
 * server MITM swapping the key. Accepting re-pins the new key (recovery), the
 * identity-key analogue of "Accept New Certificate". Reuses the .cert-* CSS and
 * buildRow helper so the two TOFU trust-prompts stay visually identical.
 */
export function createIdentityMismatchModal(
  options: IdentityMismatchModalOptions,
): MountableComponent {
  const { username, fingerprint, onAccept, onReject } = options;
  let overlay: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;
  const disposable = new Disposable();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal" });
    // Unique per factory, not per instance — the three trust prompts never
    // stack with each other in practice.
    applyDialogSemantics(modal, { labelledBy: "identity-mismatch-title" });
    trapFocus(modal, disposable.signal);

    const header = createElement("div", { class: "modal-header" });
    const title = createElement(
      "h3",
      { id: "identity-mismatch-title" },
      shellText("identity.title"),
    );
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": shellText("common.close"),
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("shield-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, shellText("identity.heading"));

    const desc = createElement("div", { class: "cert-desc" });
    setText(desc, shellText("identity.description"));

    const details = createElement("div", { class: "cert-details" });
    details.appendChild(buildRow(shellText("identity.participant"), username, false));
    // Only when the new key's fingerprint is available — a null one would render
    // a misleading blank "Unknown" row and defeats the out-of-band check.
    if (fingerprint !== null) {
      details.appendChild(buildRow(shellText("identity.newKey"), fingerprint, true));
    }

    appendChildren(body, warning, certTitle, desc, details);

    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", { class: "btn-ghost", type: "button" });
    setText(rejectBtn, shellText("common.cancel"));
    rejectBtn.addEventListener("click", onReject, { signal: disposable.signal });

    const acceptBtn = createElement("button", { class: "btn-danger", type: "button" });
    setText(acceptBtn, shellText("identity.accept"));
    acceptBtn.addEventListener("click", onAccept, { signal: disposable.signal });

    appendChildren(footer, rejectBtn, acceptBtn);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) onReject();
      },
      { signal: disposable.signal },
    );

    // Escape rejects (Cancel) — the fail-closed default: dismissing the
    // prompt must never re-pin the new identity key.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && overlay?.isConnected === true) onReject();
      },
      { signal: disposable.signal },
    );

    container.appendChild(overlay);
    restoreFocus = focusDialog(modal);
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
