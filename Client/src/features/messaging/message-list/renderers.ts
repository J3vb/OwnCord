/**
 * Message rendering barrel — re-exports the rendering helpers consumers use
 * and contains the composite functions (renderMessage, renderDayDivider,
 * renderReplyRef, renderSystemMessage) that orchestrate pieces from the
 * split modules.
 */

// -- Re-exports (only the names consumers actually import; everything else is
// -- available directly from the split modules) -------------------------------

export {
  formatTime,
  formatFullDate,
  formatMessageTimestamp,
  isSameDay,
  shouldGroup,
  getUserRole,
  roleColorVar,
} from "@lib/text/formatting";

export {
  renderInlineContent,
  renderMentions,
  renderMentionSegment,
  renderMessageContent,
} from "../content/contentParser";

export { setServerHost } from "../content/attachments";

import { createElement, appendChildren } from "@lib/dom";
import { applyDeleteGate, renderActionsBar } from "./messageActionBar";
import { type Message } from "@stores/messages.store";
import { messagingText } from "../../../i18n/messaging";
import { uiStore } from "@stores/ui.store";
import { formatFullDate } from "@lib/text/formatting";
import { resolveAuthor, userRoleColorVar } from "@lib/text/formatting";
import { importedAuthorKey } from "../importedAuthor";
import { highlightsCurrentUser } from "@lib/text/mentions";
import { renderReplyRef } from "./renderReplyRef";
import { renderKindRow } from "./renderRowKinds";
import {
  authorAvatarKey,
  mentionInfoOf,
  sendStatusClass,
  renderRowAvatar,
  renderHoverTime,
  renderMessageHeader,
  appendBody,
  appendSendState,
} from "./renderMessageBody";
import type { MessageRenderOptions } from "./messageRenderOptions";
export { authorAvatarKey } from "./renderMessageBody";
export type { MessageRenderOptions } from "./messageRenderOptions";
export { fullDateTimeTitle, messageHeaderTime } from "./messageTimes";

/** The header over a run of blocked users' messages, with its Show/Hide toggle. */
export function renderBlockedRun(
  item: { readonly firstId: number; readonly count: number; readonly expanded: boolean },
  onToggle: () => void,
  signal: AbortSignal,
): HTMLDivElement {
  const toggle = createElement(
    "button",
    {
      type: "button",
      class: "msg-blocked-toggle",
      "aria-expanded": String(item.expanded),
      "data-testid": `msg-blocked-toggle-${item.firstId}`,
    },
    messagingText(item.expanded ? "blocked.hide" : "blocked.show"),
  );
  toggle.addEventListener("click", onToggle, { signal });
  const run = createElement("div", {
    class: "msg-blocked-run",
    "data-testid": `msg-blocked-run-${item.firstId}`,
  });
  appendChildren(
    run,
    createElement("span", { class: "msg-blocked-text" }, messagingText("blocked.run", item)),
    toggle,
  );
  return run;
}

export function renderDayDivider(iso: string): HTMLDivElement {
  const divider = createElement("div", { class: "msg-day-divider" });
  appendChildren(
    divider,
    createElement("span", { class: "line" }),
    createElement("span", { class: "date" }, formatFullDate(iso)),
    createElement("span", { class: "line" }),
  );
  return divider;
}

/**
 * The unread bar pinned to the top of the message region. The
 * caller owns the label text and the `hidden` state; the button only reports
 * the click.
 */
export function renderUnreadBar(
  onMarkRead: () => void,
  signal: AbortSignal,
): {
  readonly bar: HTMLDivElement;
  readonly label: HTMLSpanElement;
  readonly announcer: HTMLDivElement;
} {
  const bar = createElement("div", { class: "unread-bar", "data-testid": "unread-bar" });
  bar.hidden = true;
  const label = createElement("span", { "data-testid": "unread-bar-label" });
  const markRead = createElement(
    "button",
    { type: "button", "data-testid": "unread-bar-mark-read" },
    messagingText("unreadBar.markRead"),
  );
  markRead.addEventListener("click", onMarkRead, { signal });
  appendChildren(bar, label, markRead);
  // A persistent live region outside the hidden bar: changes inside a hidden
  // region are not announced.
  const announcer = createElement("div", {
    class: "sr-only",
    role: "status",
    "data-testid": "unread-bar-announcer",
  });
  return { bar, label, announcer };
}

/**
 * The "NEW" line above the first message the reader has not seen. Built exactly
 * like the day divider — same rule/label/rule shape — so the two read as one
 * family; only the accent colour distinguishes them.
 */
export function renderNewDivider(): HTMLDivElement {
  const divider = createElement("div", {
    class: "msg-new-divider",
    role: "separator",
    "data-testid": "new-messages-divider",
  });
  appendChildren(
    divider,
    createElement("span", { class: "line" }),
    createElement("span", { class: "label" }, messagingText("divider.new")),
    createElement("span", { class: "line" }),
  );
  return divider;
}

/** Toggle the delete gate on every rendered delete control for the current
 *  connection status. Called on a connection flip; no row is rebuilt. */
export function refreshConnectionControls(root: ParentNode): void {
  const status = uiStore.getState().connectionStatus;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-testid^='msg-delete-']")) {
    applyDeleteGate(btn, status);
  }
}
export function renderMessage(
  msg: Message,
  isGrouped: boolean,
  allMessages: readonly Message[],
  opts: MessageRenderOptions,
  signal: AbortSignal,
  /** The inline editor to host in place of the message body. */
  editor?: HTMLElement,
): HTMLDivElement {
  const special = renderKindRow(msg, opts, signal);
  if (special !== null) return special;

  // A deleted row shows no content, so it must not keep the mention accent.
  const mentionedClass =
    !msg.deleted && highlightsCurrentUser(msg.content, mentionInfoOf(msg)) ? " mentioned" : "";
  const el = createElement("div", {
    class:
      (isGrouped ? "message grouped" : "message") +
      sendStatusClass(msg) +
      mentionedClass +
      (editor === undefined ? "" : " editing"),
    "data-testid": `message-${msg.id}`,
  });

  // The author's current identity, not the one frozen into the payload: a
  // rename or a new avatar has to show up on the messages already on screen.
  const author = resolveAuthor(msg.user);
  const roleColor = userRoleColorVar(msg.user.id);
  const imported = msg.importedAuthor;
  // Tag the row with the identity it was drawn from, so MessageList can repaint
  // only the rows whose author actually changed on a roleRevision bump.
  el.dataset["authorKey"] =
    imported === undefined ? authorAvatarKey(author, roleColor) : importedAuthorKey(imported);
  el.appendChild(renderRowAvatar(msg, author));
  if (isGrouped) el.appendChild(renderHoverTime(msg));
  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, msg.referencedMessage, allMessages, opts, signal));
  }
  el.appendChild(renderMessageHeader(msg, author, roleColor));
  appendBody(el, msg, opts, signal, editor);
  appendSendState(el, msg, opts, signal);
  // Confirmed server messages only: not deleted rows, unsent optimistic rows
  // or a row being edited.
  if (!msg.deleted && msg.status === "sent" && editor === undefined) {
    el.appendChild(renderActionsBar(el, msg, opts, signal));
  }
  return el;
}
