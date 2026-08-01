/**
 * Reaction pill rendering — emoji reaction chips with counts and toggle behavior.
 */

import { createElement } from "@lib/dom";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { attachReactionTooltip } from "./reaction-tooltip";

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
    const emoji = document.createTextNode(reaction.emoji);
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
