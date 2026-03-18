/**
 * Message rendering helpers — pure DOM builders for messages, day dividers,
 * reactions, attachments, and content parsing. XSS-safe (no innerHTML).
 */

import {
  createElement,
  setText,
  appendChildren,
} from "@lib/dom";
import type { Attachment } from "@lib/types";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { MessageListOptions } from "../MessageList";

// -- Constants ----------------------------------------------------------------

export const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

const MENTION_REGEX = /@(\w+)/g;
const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
const INLINE_CODE_REGEX = /`([^`]+)`/g;

// -- Formatting helpers -------------------------------------------------------

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function shouldGroup(prev: Message, curr: Message): boolean {
  if (prev.user.id !== curr.user.id) return false;
  if (prev.deleted || curr.deleted) return false;
  const dt = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
  return dt < GROUP_THRESHOLD_MS;
}

function getUserRole(userId: number): string {
  return membersStore.getState().members.get(userId)?.role ?? "member";
}

function roleColorVar(role: string): string {
  switch (role) {
    case "owner": return "var(--role-owner)";
    case "admin": return "var(--role-admin)";
    case "moderator": return "var(--role-mod)";
    default: return "var(--role-member)";
  }
}

// -- Content parsing (XSS-safe, no innerHTML) ---------------------------------

function renderInlineContent(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentions(text.slice(lastIndex, idx)));
    }
    const code = createElement("code", {});
    setText(code, match[1]!);
    fragment.appendChild(code);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentions(text.slice(lastIndex)));
  }
  return fragment;
}

export function renderMentions(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
    }
    const span = createElement("span", { class: "mention" });
    setText(span, match[0]);
    fragment.appendChild(span);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

function renderMessageContent(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of content.matchAll(CODE_BLOCK_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(content.slice(lastIndex, idx)));
      fragment.appendChild(text);
    }
    const codeBlock = createElement("div", { class: "msg-codeblock" });
    setText(codeBlock, match[1]!.trim());
    fragment.appendChild(codeBlock);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex === 0) {
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(renderInlineContent(content));
    fragment.appendChild(text);
  } else if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining.length > 0) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(remaining));
      fragment.appendChild(text);
    }
  }
  return fragment;
}

// -- Attachment rendering -----------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function renderAttachment(att: Attachment): HTMLDivElement {
  if (isImageMime(att.mime)) {
    const wrap = createElement("div", { class: "msg-image" });
    const img = createElement("img", {
      src: att.url,
      alt: att.filename,
      loading: "lazy",
    });
    img.addEventListener("error", () => {
      img.replaceWith(createElement("div", { class: "placeholder-img" }, att.filename));
    });
    wrap.appendChild(img);
    return wrap;
  }
  const wrap = createElement("div", { class: "msg-file" });
  const inner = createElement("div", { class: "msg-file-inner" });
  const icon = createElement("div", { class: "msg-file-icon" }, "\uD83D\uDCC4");
  const nameEl = createElement("div", { class: "msg-file-name" }, att.filename);
  const sizeEl = createElement("div", { class: "msg-file-size" }, formatFileSize(att.size));
  const info = createElement("div", {});
  appendChildren(info, nameEl, sizeEl);
  appendChildren(inner, icon, info);
  wrap.appendChild(inner);
  return wrap;
}

// -- Reaction rendering -------------------------------------------------------

function renderReactions(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const container = createElement("div", { class: "msg-reactions" });
  for (const reaction of msg.reactions) {
    const chip = createElement("span", {
      class: reaction.me ? "reaction-chip me" : "reaction-chip",
    });
    const emoji = document.createTextNode(reaction.emoji);
    const count = createElement("span", { class: "rc-count" }, String(reaction.count));
    chip.appendChild(emoji);
    chip.appendChild(count);
    chip.addEventListener("click", () => opts.onReactionClick(msg.id, reaction.emoji), { signal });
    container.appendChild(chip);
  }
  const addBtn = createElement("span", { class: "reaction-chip add-reaction" }, "+");
  addBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
  container.appendChild(addBtn);
  return container;
}

// -- DOM rendering (matches ui-mockup.html structure) -------------------------

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
    appendChildren(
      bar,
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
  const icon = createElement("span", { class: "sm-icon" }, "\u2192");
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
  const time = createElement("span", { class: "msg-time" }, formatTime(msg.timestamp));
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

    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  }

  if (!msg.deleted) {
    const actionsBar = createElement("div", { class: "msg-actions-bar" });

    const reactBtn = createElement("button", { "data-testid": `msg-react-${msg.id}` }, "\uD83D\uDE04");
    reactBtn.title = "React";
    reactBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
    actionsBar.appendChild(reactBtn);

    const replyBtn = createElement("button", { "data-testid": `msg-reply-${msg.id}` }, "\u21A9");
    replyBtn.title = "Reply";
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    if (msg.user.id === opts.currentUserId) {
      const editBtn = createElement("button", { "data-testid": `msg-edit-${msg.id}` }, "\u270E");
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      actionsBar.appendChild(editBtn);
    }

    if (msg.user.id === opts.currentUserId) {
      const deleteBtn = createElement("button", { "data-testid": `msg-delete-${msg.id}` }, "\uD83D\uDDD1");
      deleteBtn.title = "Delete";
      deleteBtn.addEventListener("click", () => opts.onDeleteClick(msg.id), { signal });
      actionsBar.appendChild(deleteBtn);
    }

    el.appendChild(actionsBar);
  }

  return el;
}
