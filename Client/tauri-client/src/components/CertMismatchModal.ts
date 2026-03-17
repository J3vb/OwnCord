/**
 * CertMismatchModal — shows a warning when the server TLS certificate
 * fingerprint has changed (TOFU mismatch). Gives the user the choice
 * to accept the new certificate or disconnect.
 *
 * Uses the existing .modal-overlay / .cert-* CSS classes from login.css.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface CertMismatchModalOptions {
  readonly host: string;
  readonly storedFingerprint: string;
  readonly newFingerprint: string;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

export function createCertMismatchModal(
  options: CertMismatchModalOptions,
): MountableComponent {
  const { host, storedFingerprint, newFingerprint, onAccept, onReject } = options;
  let overlay: HTMLDivElement | null = null;
  const ac = new AbortController();

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });

    const modal = createElement("div", { class: "modal" });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Certificate Warning");
    const closeBtn = createElement("button", { class: "modal-close", type: "button" });
    setText(closeBtn, "\u2715");
    closeBtn.addEventListener("click", onReject, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });

    const warning = createElement("div", { class: "cert-warning" });
    warning.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

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

    container.appendChild(overlay);
  }

  function destroy(): void {
    ac.abort();
    if (overlay !== null) {
      overlay.remove();
      overlay = null;
    }
  }

  return { mount, destroy };
}

function buildRow(
  label: string,
  value: string,
  isFingerprint: boolean,
): HTMLDivElement {
  const row = createElement("div", { class: "cert-row" });
  const labelEl = createElement("span", { class: "cert-label" });
  setText(labelEl, label);
  const valueClass = isFingerprint ? "cert-value cert-fingerprint" : "cert-value";
  const valueEl = createElement("span", { class: valueClass });
  setText(valueEl, value || "Unknown");
  appendChildren(row, labelEl, valueEl);
  return row;
}
