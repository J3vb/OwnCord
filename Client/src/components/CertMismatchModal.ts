/**
 * CertMismatchModal — shows a warning when the server TLS certificate
 * fingerprint has changed (TOFU mismatch). Gives the user the choice
 * to accept the new certificate or disconnect.
 *
 * Uses the existing .modal-overlay / .cert-* CSS classes from login.css.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import type { MountableComponent } from "@lib/safe-render";

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
  const ac = new AbortController();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });

    const modal = createElement("div", { class: "modal" });
    // Ids are unique per factory, not per instance — these three trust prompts
    // never stack with each other in practice.
    applyDialogSemantics(modal, { labelledBy: "cert-mismatch-title" });
    trapFocus(modal, ac.signal);

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "cert-mismatch-title" }, "Certificate Warning");
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      // Icon-only control — the aria-label is its entire accessible name.
      "aria-label": "Close",
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("triangle-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, "Certificate Changed");

    const desc = createElement("div", { class: "cert-desc" });
    setText(
      desc,
      "The server's TLS certificate fingerprint has changed. " +
        "This could mean the server regenerated its certificate, " +
        "or it could indicate a security issue.",
    );

    const details = createElement("div", { class: "cert-details" });

    const hostRow = buildRow("Host", host, false);
    const storedRow = buildRow("Previous", storedFingerprint, true);
    const newRow = buildRow("Current", newFingerprint, true);
    appendChildren(details, hostRow, storedRow, newRow);

    appendChildren(body, warning, certTitle, desc, details);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", {
      class: "btn-ghost",
      type: "button",
    });
    setText(rejectBtn, "Disconnect");
    rejectBtn.addEventListener("click", onReject, { signal: ac.signal });

    const acceptBtn = createElement("button", {
      class: "btn-danger",
      type: "button",
    });
    setText(acceptBtn, "Accept New Certificate");
    acceptBtn.addEventListener("click", onAccept, { signal: ac.signal });

    appendChildren(footer, rejectBtn, acceptBtn);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) onReject();
      },
      { signal: ac.signal },
    );

    // Escape maps to reject because that is the fail-closed safe default
    // (Disconnect) — dismissing a trust prompt must never grant trust.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && overlay?.isConnected === true) onReject();
      },
      { signal: ac.signal },
    );

    container.appendChild(overlay);
    restoreFocus = focusDialog(modal);
  }

  function destroy(): void {
    ac.abort();
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
  const ac = new AbortController();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal" });
    // Unique per factory, not per instance — the three trust prompts never
    // stack with each other in practice.
    applyDialogSemantics(modal, { labelledBy: "cert-first-use-title" });
    trapFocus(modal, ac.signal);

    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "cert-first-use-title" }, "New Server Certificate");
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": "Close",
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("triangle-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, "Confirm the certificate fingerprint");

    const desc = createElement("div", { class: "cert-desc" });
    setText(
      desc,
      "This is the first connection to this server, so its certificate is not " +
        "yet trusted. Verify the fingerprint below out-of-band (e.g. with the " +
        "server operator) before trusting it — on an untrusted network an " +
        "attacker could present a fake certificate.",
    );

    const details = createElement("div", { class: "cert-details" });
    appendChildren(
      details,
      buildRow("Host", host, false),
      buildRow("Fingerprint", fingerprint, true),
    );

    appendChildren(body, warning, certTitle, desc, details);

    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", { class: "btn-ghost", type: "button" });
    setText(rejectBtn, "Cancel");
    rejectBtn.addEventListener("click", onReject, { signal: ac.signal });

    const acceptBtn = createElement("button", { class: "btn-danger", type: "button" });
    setText(acceptBtn, "Trust This Certificate");
    acceptBtn.addEventListener("click", onAccept, { signal: ac.signal });

    appendChildren(footer, rejectBtn, acceptBtn);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) onReject();
      },
      { signal: ac.signal },
    );

    // Escape rejects (Cancel) — the fail-closed default: never trust a
    // certificate because the prompt was dismissed.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && overlay?.isConnected === true) onReject();
      },
      { signal: ac.signal },
    );

    container.appendChild(overlay);
    restoreFocus = focusDialog(modal);
  }

  function destroy(): void {
    ac.abort();
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
  const ac = new AbortController();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal" });
    // Unique per factory, not per instance — the three trust prompts never
    // stack with each other in practice.
    applyDialogSemantics(modal, { labelledBy: "identity-mismatch-title" });
    trapFocus(modal, ac.signal);

    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "identity-mismatch-title" }, "Identity Warning");
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": "Close",
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onReject, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.appendChild(createIcon("shield-alert", 24));

    const certTitle = createElement("div", { class: "cert-title" });
    setText(certTitle, "Identity Key Changed");

    const desc = createElement("div", { class: "cert-desc" });
    setText(
      desc,
      "This participant's end-to-end encryption identity key no longer matches " +
        "the one pinned on first contact. This usually means they reinstalled or " +
        "switched device, but it could also indicate that the server swapped their " +
        "key. Verify the new key out-of-band before trusting it.",
    );

    const details = createElement("div", { class: "cert-details" });
    details.appendChild(buildRow("Participant", username, false));
    // Only when the new key's fingerprint is available — a null one would render
    // a misleading blank "Unknown" row and defeats the out-of-band check.
    if (fingerprint !== null) {
      details.appendChild(buildRow("New key", fingerprint, true));
    }

    appendChildren(body, warning, certTitle, desc, details);

    const footer = createElement("div", { class: "modal-footer" });

    const rejectBtn = createElement("button", { class: "btn-ghost", type: "button" });
    setText(rejectBtn, "Cancel");
    rejectBtn.addEventListener("click", onReject, { signal: ac.signal });

    const acceptBtn = createElement("button", { class: "btn-danger", type: "button" });
    setText(acceptBtn, "Trust New Key");
    acceptBtn.addEventListener("click", onAccept, { signal: ac.signal });

    appendChildren(footer, rejectBtn, acceptBtn);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) onReject();
      },
      { signal: ac.signal },
    );

    // Escape rejects (Cancel) — the fail-closed default: dismissing the
    // prompt must never re-pin the new identity key.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && overlay?.isConnected === true) onReject();
      },
      { signal: ac.signal },
    );

    container.appendChild(overlay);
    restoreFocus = focusDialog(modal);
  }

  function destroy(): void {
    ac.abort();
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
  setText(valueEl, value || "Unknown");
  appendChildren(row, labelEl, valueEl);
  return row;
}
