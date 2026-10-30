// "Pinned a message" system row: "<Name> pinned a message to this
// channel. See all pinned messages." Drawn from `kind` + `replyTo` alone, never
// from `content` (the server's English fallback for older clients). The pinned
// message id rides in `replyTo`; once that message is deleted, or purged so the
// column is NULL, "a message" is plain text with nothing to jump to. DMs use the
// same wording as channels (design note 6.12, section 1).
import { resolveDisplayName } from "@lib/ui/avatar";
import { createElement, setText } from "@lib/dom";
import { resolveAuthor } from "@lib/text/formatting";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { messagingText } from "../../i18n/messaging";

// Private-use markers that stand in for the two links while the catalog
// sentence is formatted, so a future wording keeps its own word order.
const MESSAGE_MARK = "";
const PINS_MARK = "";
const MARKS = new RegExp(`[${MESSAGE_MARK}${PINS_MARK}]`, "g");

/** The message this row pinned, or null when it can no longer be jumped to. */
export function pinRowTarget(msg: Message): number | null {
  if (msg.replyTo === null) return null;
  if (msg.referencedMessage?.deleted === true) return null;
  return msg.replyTo;
}

function linkButton(
  testId: string,
  label: string,
  signal: AbortSignal,
  onClick: () => void,
): HTMLButtonElement {
  const button = createElement("button", {
    class: "pr-link",
    type: "button",
    "data-testid": testId,
  });
  setText(button, label);
  button.addEventListener("click", onClick, { signal });
  return button;
}

/**
 * The row's sentence. The author is "You" for the viewer, else their live
 * display name. "a message" is a button only while the target still exists and
 * the list can jump; "pinned messages" is a button only when the list can open
 * the panel.
 */
export function renderPinRowText(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLSpanElement {
  // A name carrying a marker would be split on too and move the links into it.
  const author = (
    msg.user.id === opts.currentUserId
      ? messagingText("group.you")
      : resolveDisplayName(resolveAuthor(msg.user))
  ).replace(MARKS, "");
  const sentence = messagingText("pin.row", {
    author,
    message: MESSAGE_MARK,
    pins: PINS_MARK,
  });
  const body = createElement("span", { class: "pr-text" });

  const target = pinRowTarget(msg);
  const onJump = opts.onJumpToMessage;
  const onOpenPins = opts.onOpenPins;
  const messageLabel = messagingText("pin.message");
  const pinsLabel = messagingText("pin.pins");

  const messageNode: Node =
    target !== null && onJump !== undefined
      ? linkButton(`pin-row-message-${msg.id}`, messageLabel, signal, () => onJump(target))
      : document.createTextNode(messageLabel);
  const pinsNode: Node =
    onOpenPins !== undefined
      ? linkButton(`pin-row-pins-${msg.id}`, pinsLabel, signal, () => onOpenPins())
      : document.createTextNode(pinsLabel);

  // Split on the markers, keeping them, and swap each for its node.
  for (const part of sentence.split(new RegExp(`(${MESSAGE_MARK}|${PINS_MARK})`))) {
    if (part === MESSAGE_MARK) body.appendChild(messageNode);
    else if (part === PINS_MARK) body.appendChild(pinsNode);
    else if (part !== "") body.appendChild(document.createTextNode(part));
  }
  return body;
}
