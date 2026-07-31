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
import { getUserRole, roleColorVar } from "./formatting";
import { renderMentions, renderMessageContent } from "./content-parser";
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

function renderReplyRef(replyToId: number, allMessages: readonly Message[]): HTMLDivElement {
  const ref = allMessages.find((m) => m.id === replyToId);
  const bar = createElement("div", { class: "msg-reply-ref" });
  if (ref) {
    const preview = ref.deleted ? "[message deleted]" : ref.content.slice(0, 100);
    const role = getUserRole(ref.user.id);
    const miniAvatar = createElement(
      "div",
      {
        class: "rr-avatar",
        style: `background: ${roleColorVar(role)}`,
      },
      ref.user.username.charAt(0).toUpperCase(),
    );
    appendChildren(
      bar,
      miniAvatar,
      createElement("span", { class: "rr-author" }, ref.user.username),
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
  const el = createElement("div", {
    class: (isGrouped ? "message grouped" : "message") + statusClass,
    "data-testid": `message-${msg.id}`,
  });

  const role = getUserRole(msg.user.id);
  const initial = msg.user.username.charAt(0).toUpperCase();
  const avatar = createElement(
    "div",
    {
      class: "msg-avatar",
      style: `background: ${roleColorVar(role)}`,
    },
    initial,
  );
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
    el.appendChild(renderReplyRef(msg.replyTo, allMessages));
  }

  const header = createElement("div", { class: "msg-header" });
  const author = createElement(
    "span",
    {
      class: "msg-author",
      style: `color: ${roleColorVar(role)}`,
    },
    msg.user.username,
  );
  const time = createElement(
    "span",
    { class: "msg-time", title: formatFullDate(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(header, author, time);
  el.appendChild(header);

  if (msg.deleted) {
    const text = createElement("div", { class: "msg-text" });
    text.style.fontStyle = "italic";
    text.style.color = "var(--text-muted)";
    setText(text, "[message deleted]");
    el.appendChild(text);
  } else {
    el.appendChild(renderMessageContent(msg.content));
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
