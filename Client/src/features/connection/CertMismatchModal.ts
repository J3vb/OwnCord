/**
 * The certificate trust prompts: a changed server TLS certificate fingerprint
 * (TOFU mismatch), and the first connection to a server with no pinned
 * certificate. Both use the .modal-overlay / .cert-* CSS from login.css.
 */

import type { MountableComponent } from "@lib/text/safeRender";
import { connectText } from "../../i18n/connect";
import { buildRow, createTrustPrompt } from "./trustPrompt";

export interface CertMismatchModalOptions {
  readonly host: string;
  readonly storedFingerprint: string;
  readonly newFingerprint: string;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

export function createCertMismatchModal(options: CertMismatchModalOptions): MountableComponent {
  return createTrustPrompt({
    titleId: "cert-mismatch-title",
    title: connectText("cert.mismatch.title"),
    closeLabel: connectText("common.close"),
    icon: "triangle-alert",
    heading: connectText("cert.mismatch.heading"),
    lines: [{ className: "cert-desc", text: connectText("cert.mismatch.description") }],
    rows: [
      buildRow(connectText("cert.host"), options.host, false),
      buildRow(connectText("cert.mismatch.previous"), options.storedFingerprint, true),
      buildRow(connectText("cert.mismatch.current"), options.newFingerprint, true),
    ],
    // Reject means Disconnect: the fail-closed default.
    rejectText: connectText("cert.mismatch.reject"),
    acceptText: connectText("cert.mismatch.accept"),
    focusReject: true,
    onAccept: options.onAccept,
    onReject: options.onReject,
  });
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
  return createTrustPrompt({
    titleId: "cert-first-use-title",
    title: connectText("cert.firstUse.title"),
    closeLabel: connectText("common.close"),
    icon: "triangle-alert",
    heading: connectText("cert.firstUse.heading"),
    lines: [{ className: "cert-desc", text: connectText("cert.firstUse.description") }],
    rows: [
      buildRow(connectText("cert.host"), options.host, false),
      buildRow(connectText("cert.firstUse.fingerprint"), options.fingerprint, true),
    ],
    rejectText: connectText("common.cancel"),
    acceptText: connectText("cert.firstUse.accept"),
    focusReject: true,
    onAccept: options.onAccept,
    onReject: options.onReject,
  });
}
