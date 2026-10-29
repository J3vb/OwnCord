/**
 * The "Forwarded" frame around a forwarded message's body. The
 * renderer fills `startForwardBlock`'s box with the text, files and embeds the
 * way it does for any message, then seals it with `endForwardBlock`, which adds
 * the source line. The block carries no author and no channel name, so the
 * channel is looked up here, and only for a channel this viewer can see.
 *
 * The jump chip reuses `.message-link-chip` and the same `jumpToMessage` the
 * pasted-permalink chip uses. It shows only while the source still exists
 * (`source_message_id` is set) and its channel is known; otherwise the line is
 * plain text, so there is never a link that goes nowhere. Imports only @lib
 * modules, so it cannot close a cycle through attachments.ts.
 */

import { findChannelById } from "@lib/channel-navigation";
import { createElement, setText } from "@lib/dom";
import { formatFullDate, formatMessageTimestamp } from "@lib/formatting";
import { createIcon } from "@lib/icons";
import { jumpToMessage } from "@lib/message-navigation";
import type { ForwardInfo } from "@lib/types";
import { messagingText } from "../../i18n/messaging";

/** The frame with its "Forwarded" header; the caller appends the message body to it. */
export function startForwardBlock(): HTMLElement {
  const box = createElement("div", { class: "msg-forward", "data-testid": "msg-forward" });
  const head = createElement("div", { class: "msg-forward-head" });
  head.appendChild(createIcon("arrow-right", 12));
  head.appendChild(createElement("span", {}, messagingText("forward.label")));
  box.appendChild(head);
  return box;
}

/** Add the source line (channel, time, and a jump chip when the original is reachable). */
export function endForwardBlock(box: HTMLElement, forward: ForwardInfo): void {
  const channel = findChannelById(forward.source_channel_id);
  const when = formatMessageTimestamp(forward.source_timestamp);
  const label = channel === null ? when : `${channel.isDm ? "@" : "#"}${channel.name} · ${when}`;
  const messageId = forward.source_message_id;
  if (channel === null || messageId === null) {
    box.appendChild(
      createElement(
        "div",
        {
          class: "msg-edited",
          title: formatFullDate(forward.source_timestamp),
          "data-testid": "msg-forward-source",
        },
        label,
      ),
    );
    return;
  }
  const chip = createElement("span", {
    class: "message-link-chip",
    role: "link",
    tabindex: "0",
    title: messagingText("message.jumpIn", { channel: label }),
    "data-testid": "msg-forward-jump",
  });
  const text = createElement("span", { class: "mlc-channel" });
  setText(text, label);
  const action = createElement("span", { class: "mlc-action" });
  setText(action, messagingText("message.jump"));
  chip.appendChild(text);
  chip.appendChild(action);
  const go = (): void => jumpToMessage(channel.id, messageId);
  // Per-node listeners with no signal, like the message-link chip: the chip
  // lives and dies with the row.
  chip.addEventListener("click", go);
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
  box.appendChild(chip);
}
