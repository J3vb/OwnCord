/**
 * NsfwGate — the consent gate shown INSTEAD of a channel labelled NSFW, and
 * the bar that lets the reader withdraw that consent (B9-7).
 *
 * The server withholds a labelled channel's content until the account has
 * acknowledged it (B5-7), so nothing is mounted or fetched under the gate:
 * accepting records the acknowledgement with the server first, and only the
 * confirmed store change makes ChannelController mount the channel.
 *
 * Not a `.modal-overlay`: a modal is a decision about the app, while this is
 * a property of the channel you just opened. It fills the messages slot and
 * leaves the sidebar and header usable, so declining is ordinary navigation.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { nsfwConsentText } from "../i18n/nsfwConsent";

// Re-exported so the lazy caller reads the catalog from this chunk, not its own.
export { nsfwConsentText };

export interface NsfwGateOptions {
  /** Channel name, shown without the leading '#'. */
  readonly channelName: string;
  /**
   * Record consent with the server. Resolves once it is confirmed (the caller
   * then replaces the gate with the channel); rejects when it was not, and
   * the gate stays up with an error.
   */
  readonly onAccept: () => Promise<void>;
  /** The reader declined: leave the channel. */
  readonly onCancel: () => void;
  /** Move focus to the gate's heading on mount (default true). */
  readonly focusOnMount?: boolean;
}

let nextGateId = 0;

export function createNsfwGate(options: NsfwGateOptions): MountableComponent {
  const { channelName, onAccept, onCancel, focusOnMount = true } = options;
  const disposable = new Disposable();
  let root: HTMLElement | null = null;

  function mount(container: Element): void {
    const id = `nsfw-gate-${++nextGateId}`;
    root = createElement("section", {
      class: "nsfw-gate",
      "data-testid": "nsfw-gate",
      "aria-labelledby": `${id}-title`,
      "aria-describedby": `${id}-body ${id}-scope`,
    });

    const card = createElement("div", { class: "nsfw-gate-card" });

    const iconWrap = createElement("div", { class: "nsfw-gate-icon", "aria-hidden": "true" });
    iconWrap.appendChild(createIcon("shield-alert", 40));

    // Focus lands on the heading, not on the accept button: a stray Enter
    // right after navigating here must never be read as consent.
    const title = createElement("h2", {
      class: "nsfw-gate-title",
      id: `${id}-title`,
      tabindex: "-1",
    });
    setText(title, nsfwConsentText("gate.title", { name: channelName }));

    const body = createElement("p", { class: "nsfw-gate-body", id: `${id}-body` });
    setText(body, nsfwConsentText("gate.body"));

    const scope = createElement("p", { class: "nsfw-gate-note", id: `${id}-scope` });
    setText(scope, nsfwConsentText("gate.scope"));

    const error = createElement("p", {
      class: "nsfw-gate-error",
      role: "alert",
      "data-testid": "nsfw-gate-error",
    });

    const actions = createElement("div", { class: "nsfw-gate-actions" });

    const backBtn = createElement("button", {
      class: "btn-modal-cancel",
      type: "button",
      "data-testid": "nsfw-gate-back",
    });
    setText(backBtn, nsfwConsentText("gate.decline"));
    backBtn.addEventListener("click", onCancel, { signal: disposable.signal });

    const continueBtn = createElement("button", {
      class: "btn-modal-save",
      type: "button",
      "data-testid": "nsfw-gate-continue",
    });
    setText(continueBtn, nsfwConsentText("gate.accept"));

    // aria-disabled rather than disabled while saving, so focus stays on the
    // button instead of falling to <body>.
    let saving = false;
    continueBtn.addEventListener(
      "click",
      () => {
        if (saving) return;
        saving = true;
        continueBtn.setAttribute("aria-disabled", "true");
        root?.setAttribute("aria-busy", "true");
        setText(continueBtn, nsfwConsentText("gate.accepting"));
        setText(error, "");
        onAccept().catch(() => {
          if (disposable.signal.aborted) return;
          saving = false;
          continueBtn.removeAttribute("aria-disabled");
          root?.removeAttribute("aria-busy");
          setText(continueBtn, nsfwConsentText("gate.accept"));
          setText(error, nsfwConsentText("gate.failed"));
        });
      },
      { signal: disposable.signal },
    );

    root.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      },
      { signal: disposable.signal },
    );

    appendChildren(actions, backBtn, continueBtn);
    appendChildren(card, iconWrap, title, body, scope, error, actions);
    root.appendChild(card);
    container.appendChild(root);
    if (focusOnMount) title.focus();
  }

  function destroy(): void {
    disposable.destroy();
    root?.remove();
    root = null;
  }

  return { mount, destroy };
}

export interface NsfwConsentBarOptions {
  /** Withdraw consent with the server; settles either way (the caller reports failure). */
  readonly onRevoke: () => Promise<void>;
}

/**
 * The line above an acknowledged NSFW channel's messages that says why they
 * are showing and offers to withdraw consent. Mounted first in its container.
 */
export function createNsfwConsentBar(options: NsfwConsentBarOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "nsfw-consent-bar", "data-testid": "nsfw-consent-bar" });
    const text = createElement("span", { class: "nsfw-consent-bar-text" });
    setText(text, nsfwConsentText("bar.text"));
    const revokeBtn = createElement("button", {
      class: "nsfw-consent-bar-revoke",
      type: "button",
      "data-testid": "nsfw-consent-revoke",
    });
    setText(revokeBtn, nsfwConsentText("bar.revoke"));
    let pending = false;
    revokeBtn.addEventListener(
      "click",
      () => {
        if (pending) return;
        pending = true;
        revokeBtn.setAttribute("aria-disabled", "true");
        void options.onRevoke().finally(() => {
          pending = false;
          revokeBtn.removeAttribute("aria-disabled");
        });
      },
      { signal: disposable.signal },
    );
    appendChildren(root, text, revokeBtn);
    container.prepend(root);
  }

  function destroy(): void {
    disposable.destroy();
    root?.remove();
    root = null;
  }

  return { mount, destroy };
}
