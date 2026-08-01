/**
 * Reaction pill rendering — emoji reaction chips with counts and toggle behavior.
 */

import { createElement } from "@lib/dom";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { attachReactionTooltip } from "./reaction-tooltip";
import { buildCustomEmojiNode } from "./custom-emoji";

// -- Reaction rendering -------------------------------------------------------

export function renderReactions(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const container = createElement("div", { class: "msg-reactions" });
  for (const reaction of msg.reactions) {
    const chip = createElement("span", {
      class: reaction.me ? "reaction-chip me" : "reaction-chip",
      // Focusable so the who-reacted tooltip is reachable without a pointer.
      tabindex: "0",
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
    chip.addEventListener("click", () => opts.onReactionClick(msg.id, reaction.emoji), { signal });
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
  const addBtn = createElement("span", { class: "reaction-chip add-reaction" }, "+");
  addBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
  container.appendChild(addBtn);
  return container;
}
