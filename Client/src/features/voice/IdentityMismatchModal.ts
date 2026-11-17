/**
 * IdentityMismatchModal — the E2EE identity-key trust prompt. Kept out of
 * CertMismatchModal.ts because only the main page opens it, so it and its
 * copy load with the main page instead of the startup chunk.
 */

import type { MountableComponent } from "@lib/text/safeRender";
import { buildRow, createTrustPrompt } from "../connection/trustPrompt";
import { shellText } from "../../i18n/shell";

export interface IdentityMismatchModalOptions {
  readonly username: string;
  /** The peer's newly-delivered identity-key fingerprint (safety number) for
   *  out-of-band verification before re-pinning; null when it can't be computed. */
  readonly fingerprint: string | null;
  /** Where focus goes on close when the opener has since been replaced. */
  readonly focusFallback?: () => HTMLElement | null;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

/**
 * createIdentityMismatchModal — the E2EE-identity analogue of the cert-mismatch
 * modal (F3 TOFU). A peer's voice identity key no longer matches the pinned one:
 * either a legitimate key rotation (reinstall / new device / wiped keyring) or a
 * server MITM swapping the key. Accepting re-pins the new key (recovery), the
 * identity-key analogue of "Accept New Certificate". Shares the
 * certificate prompts' frame so the trust prompts stay visually identical.
 */
export function createIdentityMismatchModal(
  options: IdentityMismatchModalOptions,
): MountableComponent {
  const { username, fingerprint } = options;
  const rows = [buildRow(shellText("identity.participant"), username, false)];
  // Only when the new key's fingerprint is available — a null one would render
  // a misleading blank "Unknown" row and defeats the out-of-band check.
  if (fingerprint !== null) rows.push(buildRow(shellText("identity.newKey"), fingerprint, true));
  return createTrustPrompt({
    titleId: "identity-mismatch-title",
    title: shellText("identity.title"),
    closeLabel: shellText("common.close"),
    icon: "shield-alert",
    heading: shellText("identity.heading"),
    lines: [
      { className: "cert-desc", text: shellText("identity.description") },
      // Trusting adds a key; it never replaces the ones trusted before.
      { className: "cert-desc identity-accept-note", text: shellText("identity.acceptNote") },
    ],
    rows,
    rejectText: shellText("common.cancel"),
    acceptText: shellText("identity.accept"),
    focusReject: false,
    focusFallback: options.focusFallback,
    onAccept: options.onAccept,
    onReject: options.onReject,
  });
}
