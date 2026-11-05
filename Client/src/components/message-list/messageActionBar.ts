/**
 * The hover action bar of a confirmed message: the quick reactions, React,
 * Edit (own) or Reply (others'), Pin, Delete and the "..." opener, each gated
 * by what the viewer may do.
 */
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { uiStore } from "@stores/ui.store";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { messagingText } from "../../i18n/messaging";
import {
  connectionLockReason,
  messageActionGates,
  type MessageActionGates,
} from "./messageActions";
import { QUICK_REACTIONS, emojiNode, quickReactionEmojiForPass } from "./quickReactions";
import { atReactionLimit, wireReactionControl } from "./reactions";

/** Apply the connection gate to one delete button in place. */
export function applyDeleteGate(
  btn: HTMLButtonElement,
  status: "connected" | "reconnecting" | "disconnected",
): void {
  if (status === "connected") {
    btn.disabled = false;
    btn.removeAttribute("aria-disabled");
    btn.title = messagingText("action.delete");
    return;
  }
  btn.disabled = true;
  btn.setAttribute("aria-disabled", "true");
  btn.title = connectionLockReason(status) ?? messagingText("action.delete");
}

/** The lock is applied at render from the current timeout, then updated in
 *  place by refreshReactionLocks when the timeout changes. */
function appendQuickReactions(
  bar: HTMLElement,
  msg: Message,
  opts: MessageListOptions,
  gates: MessageActionGates,
  signal: AbortSignal,
): void {
  quickReactionEmojiForPass(QUICK_REACTIONS).forEach((emoji, index) => {
    // A new emoji on a message at the cap is left out, as in the menu.
    if (atReactionLimit(msg.reactions, emoji)) return;
    const { node, name } = emojiNode(emoji);
    const label = messagingText("action.reactWith", { name });
    const quickBtn = createElement("button", {
      class: "msg-quick-react",
      "data-testid": `msg-quick-react-${msg.id}-${index}`,
      "aria-label": label,
    });
    quickBtn.appendChild(node);
    quickBtn.title = label;
    wireReactionControl(
      quickBtn,
      () => opts.onReactionClick(msg.id, emoji),
      gates.react.reason,
      signal,
    );
    bar.appendChild(quickBtn);
  });
}

/** A bar button holding one icon, titled the same as its accessible name. */
function iconButton(
  attrs: Record<string, string>,
  icon: Parameters<typeof createIcon>[0],
  title: string,
): HTMLButtonElement {
  const btn = createElement("button", attrs);
  btn.appendChild(createIcon(icon, 16));
  btn.title = title;
  return btn;
}

function appendReactButton(
  bar: HTMLElement,
  msg: Message,
  opts: MessageListOptions,
  gates: MessageActionGates,
  signal: AbortSignal,
): void {
  const label = messagingText("action.react");
  const reactBtn = iconButton(
    { "data-testid": `msg-react-${msg.id}`, "aria-label": label },
    "smile",
    label,
  );
  wireReactionControl(reactBtn, () => opts.onReactionClick(msg.id, ""), gates.react.reason, signal);
  bar.appendChild(reactBtn);
}

function appendEditButton(
  bar: HTMLElement,
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): void {
  const label = messagingText("action.edit");
  const editBtn = iconButton(
    { "data-testid": `msg-edit-${msg.id}`, "aria-label": label },
    "pencil",
    label,
  );
  editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
  bar.appendChild(editBtn);
}

function appendReplyButton(
  bar: HTMLElement,
  msg: Message,
  opts: MessageListOptions,
  own: boolean,
  signal: AbortSignal,
): void {
  const label = messagingText("action.reply");
  const replyBtn = iconButton(
    {
      class: own ? "msg-shift-only" : "",
      ...(own ? { tabindex: "-1" } : {}),
      "data-testid": `msg-reply-${msg.id}`,
      "aria-label": label,
    },
    "reply",
    label,
  );
  replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
  bar.appendChild(replyBtn);
}

function appendPinButton(
  bar: HTMLElement,
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): void {
  const label = msg.pinned ? messagingText("action.unpin") : messagingText("action.pin");
  const pinBtn = iconButton(
    {
      class: "msg-shift-only",
      tabindex: "-1",
      "data-testid": `msg-pin-${msg.id}`,
      "aria-label": label,
    },
    msg.pinned ? "pin-off" : "pin",
    label,
  );
  pinBtn.addEventListener("click", () => opts.onPinClick(msg.id, msg.channelId, msg.pinned), {
    signal,
  });
  bar.appendChild(pinBtn);
}

function appendDeleteButton(
  bar: HTMLElement,
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): void {
  const label = messagingText("action.delete");
  const deleteBtn = iconButton(
    {
      class: "msg-shift-only",
      tabindex: "-1",
      "data-testid": `msg-delete-${msg.id}`,
      "aria-label": label,
    },
    "trash-2",
    label,
  );
  // The listener is attached once; whether the button is disabled is read
  // at click time, so a connection flip is a class/attribute change on the
  // already-rendered button (refreshConnectionControls) rather than a row
  // rebuild.
  deleteBtn.addEventListener(
    "click",
    (e) => {
      if (deleteBtn.disabled) return;
      opts.onDeleteClick(msg.id, e.shiftKey);
    },
    { signal },
  );
  applyDeleteGate(deleteBtn, uiStore.getState().connectionStatus);
  bar.appendChild(deleteBtn);
}

/**
 * The hover action bar only applies to confirmed server messages — not
 * deleted rows or unsent optimistic rows. Normal bar: the quick reactions,
 * React, Edit (own) or Reply (others'), then "...". Holding Shift also shows
 * Pin, Delete and, on your own message, Reply (CSS on `.shift-held`; the
 * buttons are always rendered when their gate allows, `display:none` keeps
 * them out of the tab order otherwise). Copy Link, Report and Copy ID live
 * in the "..." menu.
 */
export function renderActionsBar(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const gates = messageActionGates(msg, opts);
  const bar = createElement("div", { class: "msg-actions-bar" });
  appendQuickReactions(bar, msg, opts, gates, signal);
  appendReactButton(bar, msg, opts, gates, signal);
  const own = gates.edit.shown;
  if (own) appendEditButton(bar, msg, opts, signal);
  appendReplyButton(bar, msg, opts, own, signal);
  if (gates.pin.shown) appendPinButton(bar, msg, opts, signal);
  if (gates.delete.shown) appendDeleteButton(bar, msg, opts, signal);
  // Opened by MessageList's delegated listener, which owns the menu's signal.
  bar.appendChild(
    iconButton(
      {
        "data-testid": `msg-more-${msg.id}`,
        "aria-label": messagingText("action.more"),
        "aria-haspopup": "menu",
        "aria-expanded": "false",
      },
      "ellipsis",
      messagingText("action.more"),
    ),
  );
  return bar;
}
