/**
 * NsfwGate — the age-gate shown over a channel flagged NSFW.
 *
 * The server does nothing with the flag beyond storing and broadcasting it (see
 * `@lib/nsfw-gate`), so this overlay is the whole of the feature on the reading
 * side. It covers the message area rather than replacing it: the channel is
 * mounted and live underneath, and accepting the warning reveals it without a
 * refetch.
 *
 * Deliberately not a `.modal-overlay`: a modal is a decision about the app,
 * while this is a property of the channel you just opened. It fills its
 * container, so mounting it into the messages slot gates exactly the content it
 * is warning about and leaves the sidebar and header usable.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { acknowledgeNsfw } from "@lib/nsfw-gate";

export interface NsfwGateOptions {
  /** Channel being gated — its id keys the per-session acknowledgement. */
  readonly channelId: number;
  /** Channel name, shown without the leading '#'. */
  readonly channelName: string;
  /** Called after the acknowledgement is recorded. */
  readonly onContinue: () => void;
  /**
   * Called when the reader declines. Optional: without it the gate offers only
   * "Continue", which is right for a container the reader can simply navigate
   * away from.
   */
  readonly onCancel?: () => void;
}

export function createNsfwGate(options: NsfwGateOptions): MountableComponent {
  const { channelId, channelName, onContinue, onCancel } = options;
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", {
      class: "nsfw-gate",
      "data-testid": "nsfw-gate",
      role: "dialog",
      "aria-modal": "false",
      "aria-label": `Age restricted channel ${channelName}`,
    });

    const card = createElement("div", { class: "nsfw-gate-card" });

    const iconWrap = createElement("div", { class: "nsfw-gate-icon" });
    iconWrap.appendChild(createIcon("shield-alert", 40));

    const title = createElement("h2", { class: "nsfw-gate-title" });
    setText(title, `#${channelName}`);

    const body = createElement("p", { class: "nsfw-gate-body" });
    setText(body, "This channel may contain sensitive content — Continue?");

    // Says plainly what the flag is and is not, so nobody reads the gate as a
    // promise the server is filtering something.
    const note = createElement("p", { class: "nsfw-gate-note" });
    setText(
      note,
      "The channel has been marked age-restricted by a moderator. Nothing is filtered — you are only being asked once per session.",
    );

    const actions = createElement("div", { class: "nsfw-gate-actions" });

    if (onCancel !== undefined) {
      const backBtn = createElement(
        "button",
        { class: "btn-modal-cancel", type: "button", "data-testid": "nsfw-gate-back" },
        "Go Back",
      );
      backBtn.addEventListener("click", onCancel, { signal: ac.signal });
      actions.appendChild(backBtn);
    }

    const continueBtn = createElement(
      "button",
      { class: "btn-modal-save", type: "button", "data-testid": "nsfw-gate-continue" },
      "Continue",
    );
    continueBtn.addEventListener(
      "click",
      () => {
        // Record first, then notify: the caller's handler tears this component
        // down, and an acknowledgement written afterwards would race it.
        acknowledgeNsfw(channelId);
        onContinue();
      },
      { signal: ac.signal },
    );
    actions.appendChild(continueBtn);

    appendChildren(card, iconWrap, title, body, note, actions);
    root.appendChild(card);
    container.appendChild(root);
    continueBtn.focus();
  }

  function destroy(): void {
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
