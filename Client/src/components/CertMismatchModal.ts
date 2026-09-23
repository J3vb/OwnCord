/**
 * CertMismatchModal — shows a warning when the server TLS certificate
 * fingerprint has changed (TOFU mismatch). Gives the user the choice
 * to accept the new certificate or disconnect.
 *
 * Uses the existing .modal-overlay / .cert-* CSS classes from login.css.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import type { MountableComponent } from "@lib/safe-render";
import { connectText } from "../i18n/connect";

export interface CertMismatchModalOptions {
  readonly host: string;
  readonly storedFingerprint: string;
  readonly newFingerprint: string;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

export function createCertMismatchModal(options: CertMismatchModalOptions): MountableComponent {
  const { host, storedFingerprint, newFingerprint, onAccept, onReject } = options;
  let overlay: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;
  const disposable = new Disposable();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });

    const modal = createElement("div", { class: "modal" });
    // Ids are unique per factory, not per instance — these three trust prompts
    // never stack with each other in practice.
    applyDialogSemantics(modal, { labelledBy: "cert-mismatch-title" });
    trapFocus(modal, disposable.signal);

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement(
      "h3",
      { id: "cert-mismatch-title" },
      connectText("cert.mismatch.title"),
    );
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      // Icon-only control — the aria-label is its entire accessible name.
      "aria-label": connectText("common.close"),
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("triangle-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, connectText("cert.mismatch.heading"));

    const desc = createElement("div", { class: "cert-desc" });
    setText(desc, connectText("cert.mismatch.description"));

    const details = createElement("div", { class: "cert-details" });

    const hostRow = buildRow(connectText("cert.host"), host, false);
    const storedRow = buildRow(connectText("cert.mismatch.previous"), storedFingerprint, true);
    const newRow = buildRow(connectText("cert.mismatch.current"), newFingerprint, true);
    appendChildren(details, hostRow, storedRow, newRow);

    appendChildren(body, warning, certTitle, desc, details);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", {
      class: "btn-ghost",
      type: "button",
    });
    setText(rejectBtn, connectText("cert.mismatch.reject"));
    rejectBtn.addEventListener("click", onReject, { signal: disposable.signal });

    const acceptBtn = createElement("button", {
      class: "btn-danger",
      type: "button",
    });
    setText(acceptBtn, connectText("cert.mismatch.accept"));
    acceptBtn.addEventListener("click", onAccept, { signal: disposable.signal });

    appendChildren(footer, rejectBtn, acceptBtn);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) onReject();
      },
      { signal: disposable.signal },
    );

    // Escape maps to reject because that is the fail-closed safe default
    // (Disconnect) — dismissing a trust prompt must never grant trust.
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

export interface CertFirstUseModalOptions {
  readonly host: string;
  readonly fingerprint: string;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

/**
 * createCertFirstUseModal — shown on the FIRST connection to a server, when no
 * certificate is pinned yet (F4/F8). The proxy refuses to send anything until
 * the user confirms this fingerprint, so an on-path attacker at first contact
 * cannot silently capture credentials. Mirrors an SSH known-hosts prompt.
 */
export function createCertFirstUseModal(options: CertFirstUseModalOptions): MountableComponent {
  const { host, fingerprint, onAccept, onReject } = options;
  let overlay: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;
  const disposable = new Disposable();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal" });
    // Unique per factory, not per instance — the three trust prompts never
    // stack with each other in practice.
    applyDialogSemantics(modal, { labelledBy: "cert-first-use-title" });
    trapFocus(modal, disposable.signal);

    const header = createElement("div", { class: "modal-header" });
    const title = createElement(
      "h3",
      { id: "cert-first-use-title" },
      connectText("cert.firstUse.title"),
    );
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": connectText("common.close"),
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("triangle-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, connectText("cert.firstUse.heading"));

    const desc = createElement("div", { class: "cert-desc" });
    setText(desc, connectText("cert.firstUse.description"));

    const details = createElement("div", { class: "cert-details" });
    appendChildren(
      details,
      buildRow(connectText("cert.host"), host, false),
      buildRow(connectText("cert.firstUse.fingerprint"), fingerprint, true),
    );

    appendChildren(body, warning, certTitle, desc, details);

    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", { class: "btn-ghost", type: "button" });
    setText(rejectBtn, connectText("common.cancel"));
    rejectBtn.addEventListener("click", onReject, { signal: disposable.signal });

    const acceptBtn = createElement("button", { class: "btn-danger", type: "button" });
    setText(acceptBtn, connectText("cert.firstUse.accept"));
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

    // Escape rejects (Cancel) — the fail-closed default: never trust a
    // certificate because the prompt was dismissed.
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
      connectText("identity.title"),
    );
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": connectText("common.close"),
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("shield-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, connectText("identity.heading"));

    const desc = createElement("div", { class: "cert-desc" });
    setText(desc, connectText("identity.description"));

    const details = createElement("div", { class: "cert-details" });
    details.appendChild(buildRow(connectText("identity.participant"), username, false));
    // Only when the new key's fingerprint is available — a null one would render
    // a misleading blank "Unknown" row and defeats the out-of-band check.
    if (fingerprint !== null) {
      details.appendChild(buildRow(connectText("identity.newKey"), fingerprint, true));
    }

    appendChildren(body, warning, certTitle, desc, details);

    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", { class: "btn-ghost", type: "button" });
    setText(rejectBtn, connectText("common.cancel"));
    rejectBtn.addEventListener("click", onReject, { signal: disposable.signal });

    const acceptBtn = createElement("button", { class: "btn-danger", type: "button" });
    setText(acceptBtn, connectText("identity.accept"));
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

function buildRow(label: string, value: string, isFingerprint: boolean): HTMLDivElement {
  const row = createElement("div", { class: "cert-row" });
  const labelEl = createElement("span", { class: "cert-label" });
  setText(labelEl, label);
  const valueClass = isFingerprint ? "cert-value cert-fingerprint" : "cert-value";
  const valueEl = createElement("span", { class: valueClass });
  setText(valueEl, value || connectText("common.unknown"));
  appendChildren(row, labelEl, valueEl);
  return row;
}
