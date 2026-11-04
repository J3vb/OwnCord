/**
 * The keys you trust for one voice peer: each with its safety number, the one
 * in the current call marked, and "Forget this key" on every other one.
 * Opened from a peer's identity shield. Loaded on first open, so it stays out
 * of the main chunk.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/ui/a11y";
import { closeOnBackdropClick } from "@lib/ui/modalFactory";
import { showToast } from "@lib/ui/toast";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/text/safeRender";
import type { ForgetIdentityPinResult } from "@lib/net/identity";
import { computeKeyFingerprint, importIdentityPublicKey } from "@lib/net/e2eeCrypto";
import { shellText } from "../../i18n/shell";
import { trustedKeysText as t } from "../../i18n/trustedKeys";

const log = createLogger("trusted-keys");

export interface TrustedKeysPanelOptions {
  readonly userId: number;
  /** The peer's username (never a nickname: those are user-settable). */
  readonly username: string;
  /** Whether the key in the call is a changed one not yet confirmed. */
  readonly changed: boolean;
  /** Keys trusted for the peer, oldest first; null when they can't be read. */
  readonly loadKeys: () => Promise<readonly string[] | null>;
  /** The identity key of the device in the call, if any. */
  readonly keyInCall: () => string | null;
  readonly forget: (key: string) => Promise<ForgetIdentityPinResult>;
  readonly focusFallback?: () => HTMLElement | null;
  readonly onClose: () => void;
}

/** A key's safety number, or null when it does not parse as an identity key. */
async function fingerprintOf(key: string): Promise<string | null> {
  try {
    return await computeKeyFingerprint(await importIdentityPublicKey(key));
  } catch (err) {
    log.warn("E2EE: could not compute a trusted key's fingerprint", err);
    return null;
  }
}

export function createTrustedKeysPanel(options: TrustedKeysPanelOptions): MountableComponent {
  const { username, onClose } = options;
  const disposable = new Disposable();
  let overlay: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;
  let list: HTMLDivElement | null = null;
  // Each render owns the list until a newer one starts.
  let renderId = 0;

  async function render(): Promise<void> {
    const id = ++renderId;
    const keys = await options.loadKeys();
    const shown = keys === null ? null : await Promise.all(keys.map(fingerprintOf));
    if (id !== renderId || list === null || disposable.signal.aborted) return;
    list.replaceChildren();
    if (keys === null || shown === null) {
      list.appendChild(createElement("div", { class: "tk-empty" }, t("unavailable")));
      return;
    }
    if (keys.length === 0) {
      list.appendChild(createElement("div", { class: "tk-empty" }, t("none", { name: username })));
      return;
    }
    const inCall = options.keyInCall();
    const canForgetAny = keys.length > 1;
    // Newest first: the key in use is usually the newest.
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i] as string;
      const isInCall = key === inCall;
      const fingerprint = shown[i] ?? shellText("common.unknown");
      const row = buildRow(fingerprint, isInCall);
      if (!isInCall && canForgetAny) row.appendChild(forgetButton(key, fingerprint));
      list.appendChild(row);
    }
  }

  function buildRow(fingerprint: string, isInCall: boolean): HTMLDivElement {
    const row = createElement("div", { class: "tk-row" });
    const text = createElement("div", { class: "tk-text" });
    const fp = createElement("span", { class: "tk-fingerprint" }, fingerprint);
    const tag = createElement(
      "span",
      { class: isInCall ? (options.changed ? "tk-tag changed" : "tk-tag current") : "tk-tag" },
      isInCall ? t(options.changed ? "keyInCallChanged" : "keyInCall") : t("keyOlder"),
    );
    appendChildren(text, fp, tag);
    row.appendChild(text);
    return row;
  }

  function forgetButton(key: string, fingerprint: string): HTMLButtonElement {
    const forget = createElement("button", {
      type: "button",
      class: "tk-forget",
      "aria-label": t("forgetLabel", { fingerprint }),
    });
    setText(forget, t("forget"));
    forget.addEventListener(
      "click",
      () => {
        forget.disabled = true;
        void options
          .forget(key)
          .then((result) => {
            if (result === "failed") showToast(t("forgetFailed"), "error");
            return render();
          })
          .catch((err: unknown) => {
            log.error("E2EE: failed to forget a trusted key", err);
            showToast(t("forgetFailed"), "error");
            forget.disabled = false;
          });
      },
      { signal: disposable.signal },
    );
    return forget;
  }

  function mount(container: Element): void {
    overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal tk-modal" });
    applyDialogSemantics(modal, { labelledBy: "trusted-keys-title" });
    trapFocus(modal, disposable.signal);

    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "trusted-keys-title" }, t("title", { name: username }));
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": shellText("common.close"),
    });
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onClose, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });
    const intro = createElement("div", { class: "tk-intro" }, t("intro", { name: username }));
    list = createElement("div", { class: "tk-list", "aria-live": "polite" });
    const footnote = createElement("div", { class: "tk-footnote" }, t("footnote"));
    appendChildren(body, intro, list, footnote);

    const footer = createElement("div", { class: "modal-footer" });
    const done = createElement("button", { class: "btn-primary", type: "button" });
    setText(done, t("done"));
    done.addEventListener("click", onClose, { signal: disposable.signal });
    footer.appendChild(done);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);
    closeOnBackdropClick(overlay, () => onClose(), disposable.signal);
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && !isImeCommit(e) && overlay?.isConnected === true) onClose();
      },
      { signal: disposable.signal },
    );

    container.appendChild(overlay);
    restoreFocus = focusDialog(modal, options.focusFallback);
    void render().catch((err: unknown) => {
      log.error("E2EE: could not list trusted keys", err);
    });
  }

  function destroy(): void {
    disposable.destroy();
    renderId++;
    overlay?.remove();
    overlay = null;
    list = null;
    restoreFocus?.();
    restoreFocus = null;
  }

  return { mount, destroy };
}
