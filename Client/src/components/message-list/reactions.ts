/**
 * Reaction pill rendering — emoji reaction chips with counts and toggle behavior.
 */

import { createElement } from "@lib/dom";
import type { Message } from "@stores/messages.store";
import { safetyStore } from "../../features/safety/store";
import { formatUntil, safetyText } from "../../i18n/safety";
import type { MessageListOptions } from "../MessageList";
import { attachReactionTooltip } from "./reaction-tooltip";
import { buildCustomEmojiNode } from "./custom-emoji";

// -- Reaction rendering -------------------------------------------------------

/** While timed out (B9-15, Q4): why reacting is disabled, with the server's expiry; else null. */
export function reactionLockReason(): string | null {
  const timeout = safetyStore.getState().timeout;
  return timeout === null
    ? null
    : safetyText("timeout.react", { time: formatUntil(timeout.expiresAt) });
}

export function renderReactions(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const container = createElement("div", { class: "msg-reactions" });
  const locked = reactionLockReason();
  for (const reaction of msg.reactions) {
    const chip = createElement("span", {
      class: reaction.me ? "reaction-chip me" : "reaction-chip",
      // Focusable so the who-reacted tooltip is reachable without a pointer.
      tabindex: "0",
      role: "button",
      "data-emoji": reaction.emoji,
    });
    // Reaction strings are free-form, so a custom reaction is stored as the
    // literal ":shortcode:" text. Render the image when that resolves; when it
    // does not (the emoji was deleted, or the reaction predates it) the plain
    // text is exactly what the reaction is, and toggling it still works.
    const emoji: Node =
      buildCustomEmojiNode(reaction.emoji) ?? document.createTextNode(reaction.emoji);
    const count = createElement("span", { class: "rc-count" }, String(reaction.count));
    chip.appendChild(emoji);
    chip.appendChild(count);
    wireReactionControl(chip, () => opts.onReactionClick(msg.id, reaction.emoji), locked, signal);
    attachReactionTooltip(
      chip,
      {
        channelId: msg.channelId,
        messageId: msg.id,
        emoji: reaction.emoji,
        count: reaction.count,
      },
      signal,
    );
    container.appendChild(chip);
  }
  const addBtn = createElement(
    "span",
    { class: "reaction-chip add-reaction", tabindex: "0", role: "button" },
    "+",
  );
  wireReactionControl(addBtn, () => opts.onReactionClick(msg.id, ""), locked, signal);
  container.appendChild(addBtn);
  return container;
}

/** Wire a reaction control, or mark it disabled with the lock reason. */
export function wireReactionControl(
  el: HTMLElement,
  onActivate: () => void,
  locked: string | null,
  signal: AbortSignal,
): void {
  if (locked !== null) {
    el.setAttribute("aria-disabled", "true");
    el.title = locked;
    return;
  }
  el.addEventListener("click", onActivate, { signal });
  if (el.tagName !== "BUTTON") addKeyActivation(el, onActivate, signal);
}

/**
 * A bare <span role="button"> gets no native key activation, unlike a real
 * <button>. Mirror Enter/Space onto the same handler the click listener
 * uses, so a chip is actually usable from the keyboard once it is reachable
 * (mirrors QuickSwitchOverlay.ts's item/keydown pattern).
 */
function addKeyActivation(el: Element, onActivate: () => void, signal: AbortSignal): void {
  el.addEventListener(
    "keydown",
    (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
    { signal },
  );
}
