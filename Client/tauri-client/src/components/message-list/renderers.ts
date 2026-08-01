/**
 * Message rendering barrel — re-exports the rendering helpers consumers use
 * and contains the composite functions (renderMessage, renderDayDivider,
 * renderReplyRef, renderSystemMessage) that orchestrate pieces from the
 * split modules.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { loadPref } from "@lib/preferences";
import { canManageMessages } from "@lib/permissions";
import { showToast } from "@lib/toast";
import { formatMessageLink } from "@lib/deep-link";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";

/** Cached value of the developerMode preference. Invalidated on pref change. */
let developerModeEnabled = loadPref<boolean>("developerMode", false);
window.addEventListener("owncord:pref-change", ((e: CustomEvent<{ key: string }>) => {
  if (e.detail.key === "developerMode") {
    developerModeEnabled = loadPref<boolean>("developerMode", false);
  }
}) as EventListener);

// -- Re-exports (only the names consumers actually import; everything else is
// -- available directly from the split modules) -------------------------------

export {
  GROUP_THRESHOLD_MS,
  formatTime,
  formatFullDate,
  formatMessageTimestamp,
  isSameDay,
  shouldGroup,
  getUserRole,
  roleColorVar,
} from "./formatting";

export {
  renderInlineContent,
  renderMentions,
  renderMentionSegment,
  renderMessageContent,
} from "./content-parser";

export { setServerHost } from "./attachments";

// -- Imports for composite functions ------------------------------------------

import { formatTime, formatFullDate, formatMessageTimestamp } from "./formatting";
import { getUserRole, resolveAuthor, roleColorVar } from "./formatting";
import { createAvatarElement, resolveDisplayName } from "@lib/avatar";
import { renderMentions, renderMessageContent } from "./content-parser";
import { highlightsCurrentUser } from "@lib/mentions";
import { renderUrlEmbeds } from "./media";
import { renderAttachment } from "./attachments";
import { renderReactions } from "./reactions";

// -- Composite rendering functions --------------------------------------------

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
    createElement("span", { class: "label" }, "NEW"),
    createElement("span", { class: "line" }),
  );
  return divider;
}

/**
 * The quoted bar above a reply. Clicking it jumps to the replied-to message —
 * including when that message is outside the loaded window, which is why the
 * bar stays clickable even in the "unknown message" case: the id is known, and
 * the jump path can fetch the window around it.
 */
function renderReplyRef(
  replyToId: number,
  allMessages: readonly Message[],
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const ref = allMessages.find((m) => m.id === replyToId);
  const bar = createElement("div", {
    class: "msg-reply-ref",
    role: "button",
    tabindex: "0",
    "data-reply-to": String(replyToId),
    title: "Jump to the replied-to message",
  });
  const jump = (): void => opts.onJumpToMessage?.(replyToId);
  bar.addEventListener("click", jump, { signal });
  bar.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump();
      }
    },
    { signal },
  );
  if (ref) {
    const preview = ref.deleted ? "[message deleted]" : ref.content.slice(0, 100);
    const role = getUserRole(ref.user.id);
    const author = resolveAuthor(ref.user);
    const miniAvatar = createAvatarElement(author, {
      className: "rr-avatar",
      background: roleColorVar(role),
    });
    appendChildren(
      bar,
      miniAvatar,
      createElement("span", { class: "rr-author" }, resolveDisplayName(author)),
      createElement("span", { class: "rr-text" }, preview),
    );
  } else {
    setText(bar, "Reply to unknown message");
  }
  return bar;
}

function renderSystemMessage(msg: Message): HTMLDivElement {
  const el = createElement("div", { class: "system-msg" });
  const icon = createElement("span", { class: "sm-icon" });
  icon.appendChild(createIcon("arrow-right", 14));
  const text = createElement("span", { class: "sm-text" });
  text.appendChild(renderMentions(msg.content));
  const time = createElement("span", { class: "sm-time" }, formatTime(msg.timestamp));
  appendChildren(el, icon, text, time);
  return el;
}

/** Map a send-failure error code to a short, user-facing reason. */
function sendErrorReason(code: string | null): string {
  switch (code) {
    case "SLOW_MODE":
      return "Slow mode — wait before sending again";
    case "RATE_LIMITED":
      return "You're sending too fast — try again in a moment";
    case "FORBIDDEN":
      return "You don't have permission to post here";
    case "OFFLINE":
      return "Not connected — message not sent";
    case "NETWORK":
      return "Connection problem — message not sent";
    case "BAD_REQUEST":
      return "Message rejected";
    default:
      return "Failed to send";
  }
}

export function renderMessage(
  msg: Message,
  isGrouped: boolean,
  allMessages: readonly Message[],
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  if (msg.user.username === "System") {
    return renderSystemMessage(msg);
  }

  const statusClass =
    msg.status === "pending" ? " pending" : msg.status === "failed" ? " failed" : "";
  const mentionInfo = { mentions: msg.mentions, mentionsEveryone: msg.mentionsEveryone };
  // A deleted row shows no content, so it must not keep the mention accent.
  const mentionedClass =
    !msg.deleted && highlightsCurrentUser(msg.content, mentionInfo) ? " mentioned" : "";
  const el = createElement("div", {
    class: (isGrouped ? "message grouped" : "message") + statusClass + mentionedClass,
    "data-testid": `message-${msg.id}`,
  });

  const role = getUserRole(msg.user.id);
  // The author's current identity, not the one frozen into the payload: a
  // rename or a new avatar has to show up on the messages already on screen.
  const author = resolveAuthor(msg.user);
  const avatar = createAvatarElement(author, {
    className: "msg-avatar",
    background: roleColorVar(role),
  });
  el.appendChild(avatar);

  if (isGrouped) {
    const hoverTime = createElement(
      "div",
      {
        class: "msg-hover-time",
        title: formatFullDate(msg.timestamp),
      },
      formatTime(msg.timestamp),
    );
    el.appendChild(hoverTime);
  }

  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, allMessages, opts, signal));
  }

  const header = createElement("div", { class: "msg-header" });
  const authorEl = createElement(
    "span",
    {
      class: "msg-author",
      // The username stays as the title so the handle you would @mention is
      // one hover away even when a display name is standing in for it.
      title: author.username,
      style: `color: ${roleColorVar(role)}`,
    },
    resolveDisplayName(author),
  );
  const time = createElement(
    "span",
    { class: "msg-time", title: formatFullDate(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(header, authorEl, time);
  el.appendChild(header);

  if (msg.deleted) {
    const text = createElement("div", { class: "msg-text" });
    text.style.fontStyle = "italic";
    text.style.color = "var(--text-muted)";
    setText(text, "[message deleted]");
    el.appendChild(text);
  } else {
    el.appendChild(renderMessageContent(msg.content, mentionInfo));
    if (msg.editedAt !== null) {
      el.appendChild(createElement("span", { class: "msg-edited" }, "(edited)"));
    }

    for (const att of msg.attachments) {
      el.appendChild(renderAttachment(att));
    }

    // URL embeds (YouTube players, link previews)
    const embeds = renderUrlEmbeds(msg.content);
    if (embeds.childNodes.length > 0) {
      el.appendChild(embeds);
    }

    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  }

  // Failed optimistic send: show the reason and offer retry / discard.
  if (msg.status === "failed" && msg.correlationId !== null) {
    const cid = msg.correlationId;
    const bar = createElement("div", { class: "msg-send-failed" });
    bar.appendChild(
      createElement("span", { class: "msg-send-failed-text" }, sendErrorReason(msg.errorCode)),
    );
    const retryBtn = createElement(
      "button",
      { class: "msg-send-retry", "data-testid": `msg-retry-${cid}` },
      "Retry",
    );
    retryBtn.addEventListener("click", () => opts.onRetry?.(cid), { signal });
    const discardBtn = createElement(
      "button",
      { class: "msg-send-discard", "data-testid": `msg-discard-${cid}` },
      "Delete",
    );
    discardBtn.addEventListener("click", () => opts.onDeleteDraft?.(cid), { signal });
    appendChildren(bar, retryBtn, discardBtn);
    el.appendChild(bar);
  }

  // The hover action bar (react/reply/pin/edit/delete) only applies to
  // confirmed server messages — not deleted rows or unsent optimistic rows.
  if (!msg.deleted && msg.status === "sent") {
    const actionsBar = createElement("div", { class: "msg-actions-bar" });

    const reactBtn = createElement("button", {
      "data-testid": `msg-react-${msg.id}`,
      "aria-label": "React",
    });
    reactBtn.appendChild(createIcon("smile", 16));
    reactBtn.title = "React";
    reactBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
    actionsBar.appendChild(reactBtn);

    const replyBtn = createElement("button", {
      "data-testid": `msg-reply-${msg.id}`,
      "aria-label": "Reply",
    });
    replyBtn.appendChild(createIcon("reply", 16));
    replyBtn.title = "Reply";
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    const pinBtn = createElement("button", {
      "data-testid": `msg-pin-${msg.id}`,
      "aria-label": msg.pinned ? "Unpin" : "Pin",
    });
    pinBtn.appendChild(createIcon(msg.pinned ? "pin-off" : "pin", 16));
    pinBtn.title = msg.pinned ? "Unpin" : "Pin";
    pinBtn.addEventListener("click", () => opts.onPinClick(msg.id, msg.channelId, msg.pinned), {
      signal,
    });
    actionsBar.appendChild(pinBtn);

    if (msg.user.id === opts.currentUserId) {
      const editBtn = createElement("button", {
        "data-testid": `msg-edit-${msg.id}`,
        "aria-label": "Edit",
      });
      editBtn.appendChild(createIcon("pencil", 16));
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      actionsBar.appendChild(editBtn);
    }

    // Own message, or a moderator acting on someone else's.
    if (msg.user.id === opts.currentUserId || canManageMessages()) {
      const deleteBtn = createElement("button", {
        "data-testid": `msg-delete-${msg.id}`,
        "aria-label": "Delete",
      });
      deleteBtn.appendChild(createIcon("trash-2", 16));
      deleteBtn.title = "Delete";
      deleteBtn.addEventListener("click", () => opts.onDeleteClick(msg.id), { signal });
      actionsBar.appendChild(deleteBtn);
    }

    const copyLinkBtn = createElement("button", {
      "data-testid": `msg-copy-link-${msg.id}`,
      "aria-label": "Copy Message Link",
    });
    copyLinkBtn.appendChild(createIcon("link", 16));
    copyLinkBtn.title = "Copy Message Link";
    copyLinkBtn.addEventListener(
      "click",
      () => {
        // No silent success: a copy with no feedback is indistinguishable
        // from a clipboard that refused.
        void navigator.clipboard.writeText(formatMessageLink(msg.channelId, msg.id)).then(
          () => showToast("Message link copied", "success"),
          () => showToast("Couldn't copy the message link", "error"),
        );
      },
      { signal },
    );
    actionsBar.appendChild(copyLinkBtn);

    if (developerModeEnabled) {
      const copyIdBtn = createElement("button", {
        "data-testid": `msg-copy-id-${msg.id}`,
        "aria-label": "Copy ID",
      });
      copyIdBtn.appendChild(createIcon("hash", 16));
      copyIdBtn.title = "Copy ID";
      copyIdBtn.addEventListener(
        "click",
        () => {
          // No silent success: a copy with no feedback is indistinguishable
          // from a clipboard that refused.
          void navigator.clipboard.writeText(String(msg.id)).then(
            () => showToast("Message ID copied", "success"),
            () => showToast("Couldn't copy the message ID", "error"),
          );
        },
        { signal },
      );
      actionsBar.appendChild(copyIdBtn);
    }

    el.appendChild(actionsBar);
  }

  return el;
}
