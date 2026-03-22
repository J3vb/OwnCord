/**
 * Message rendering barrel — re-exports all rendering helpers and contains
 * the composite functions (renderMessage, renderDayDivider, renderReplyRef,
 * renderSystemMessage) that orchestrate pieces from the split modules.
 */

import {
  createElement,
  setText,
  appendChildren,
} from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";

// -- Re-exports (preserve all existing public API) ----------------------------

export {
  GROUP_THRESHOLD_MS,
  parseTimestamp,
  formatTime,
  formatFullDate,
  formatMessageTimestamp,
  isSameDay,
  shouldGroup,
  getUserRole,
  roleColorVar,
} from "./formatting";

export {
  MENTION_REGEX,
  CODE_BLOCK_REGEX,
  INLINE_CODE_REGEX,
  URL_REGEX,
  renderInlineContent,
  renderMentions,
  renderMentionSegment,
  renderMessageContent,
} from "./content-parser";

export {
  extractYouTubeId,
  renderYouTubeEmbed,
  isDirectImageUrl,
  renderInlineImage,
  openImageLightbox,
  extractUrls,
  renderUrlEmbeds,
} from "./media";

export type { OgMeta } from "./embeds";
export {
  parseOgTags,
  renderGenericLinkPreview,
  applyOgMeta,
} from "./embeds";

export {
  formatFileSize,
  isImageMime,
  isSafeUrl,
  openCacheDb,
  uint8ToBase64,
  fetchImageAsDataUrl,
  renderAttachment,
  setServerHost,
  resolveServerUrl,
} from "./attachments";

export { renderReactions } from "./reactions";

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

function renderReplyRef(
  replyToId: number,
  allMessages: readonly Message[],
): HTMLDivElement {
  const ref = allMessages.find((m) => m.id === replyToId);
  const bar = createElement("div", { class: "msg-reply-ref" });
  if (ref) {
    const preview = ref.deleted ? "[message deleted]" : ref.content.slice(0, 100);
    const role = getUserRole(ref.user.id);
    const miniAvatar = createElement("div", {
      class: "rr-avatar",
      style: `background: ${roleColorVar(role)}`,
    }, ref.user.username.charAt(0).toUpperCase());
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

  const el = createElement("div", {
    class: isGrouped ? "message grouped" : "message",
    "data-testid": `message-${msg.id}`,
  });

  const role = getUserRole(msg.user.id);
  const initial = msg.user.username.charAt(0).toUpperCase();
  const avatar = createElement("div", {
    class: "msg-avatar",
    style: `background: ${roleColorVar(role)}`,
  }, initial);
  el.appendChild(avatar);

  if (isGrouped) {
    const hoverTime = createElement("div", {
      class: "msg-hover-time",
      title: formatFullDate(msg.timestamp),
    }, formatTime(msg.timestamp));
    el.appendChild(hoverTime);
  }

  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, allMessages));
  }

  const header = createElement("div", { class: "msg-header" });
  const author = createElement("span", {
    class: "msg-author",
    style: `color: ${roleColorVar(role)}`,
  }, msg.user.username);
  const time = createElement("span", { class: "msg-time", title: formatFullDate(msg.timestamp) }, formatMessageTimestamp(msg.timestamp));
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

  if (!msg.deleted) {
    const actionsBar = createElement("div", { class: "msg-actions-bar" });

    const reactBtn = createElement("button", { "data-testid": `msg-react-${msg.id}` });
    reactBtn.appendChild(createIcon("smile", 16));
    reactBtn.title = "React";
    reactBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
    actionsBar.appendChild(reactBtn);

    const replyBtn = createElement("button", { "data-testid": `msg-reply-${msg.id}` });
    replyBtn.appendChild(createIcon("reply", 16));
    replyBtn.title = "Reply";
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    const pinBtn = createElement("button", { "data-testid": `msg-pin-${msg.id}` });
    pinBtn.appendChild(createIcon(msg.pinned ? "pin-off" : "pin", 16));
    pinBtn.title = msg.pinned ? "Unpin" : "Pin";
    pinBtn.addEventListener(
      "click",
      () => opts.onPinClick(msg.id, msg.channelId, msg.pinned),
      { signal },
    );
    actionsBar.appendChild(pinBtn);

    if (msg.user.id === opts.currentUserId) {
      const editBtn = createElement("button", { "data-testid": `msg-edit-${msg.id}` });
      editBtn.appendChild(createIcon("pencil", 16));
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      actionsBar.appendChild(editBtn);
    }

    if (msg.user.id === opts.currentUserId) {
      const deleteBtn = createElement("button", { "data-testid": `msg-delete-${msg.id}` });
      deleteBtn.appendChild(createIcon("trash-2", 16));
      deleteBtn.title = "Delete";
      deleteBtn.addEventListener("click", () => opts.onDeleteClick(msg.id), { signal });
      actionsBar.appendChild(deleteBtn);
    }

    el.appendChild(actionsBar);
  }

  return el;
}
