/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, and infinite scroll.
 * Step 5.41
 */
import {
  createElement,
  setText,
  clearChildren,
  appendChildren,
} from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { Attachment } from "@lib/types";
import { messagesStore, getChannelMessages, hasMoreMessages } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";

// -- Options ------------------------------------------------------------------

export interface MessageListOptions {
  readonly channelId: number;
  readonly currentUserId: number;
  readonly onScrollTop: () => void;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  readonly onDeleteClick: (messageId: number) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
}

// -- Constants ----------------------------------------------------------------

const GROUP_THRESHOLD_MS = 5 * 60 * 1000;
const SCROLL_TOP_THRESHOLD = 50;
const SCROLL_BOTTOM_THRESHOLD = 100;
const MENTION_REGEX = /@(\w+)/g;
const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
const INLINE_CODE_REGEX = /`([^`]+)`/g;

// -- Formatting helpers -------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function shouldGroup(prev: Message, curr: Message): boolean {
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
  // First handle inline code, then mentions in non-code parts
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

function renderMentions(text: string): DocumentFragment {
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
  // Split on code blocks first
  let lastIndex = 0;
  for (const match of content.matchAll(CODE_BLOCK_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    // Render text before code block
    if (idx > lastIndex) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(content.slice(lastIndex, idx)));
      fragment.appendChild(text);
    }
    // Render code block
    const codeBlock = createElement("div", { class: "msg-codeblock" });
    setText(codeBlock, match[1]!.trim());
    fragment.appendChild(codeBlock);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex === 0) {
    // No code blocks — render as single text node
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(renderInlineContent(content));
    fragment.appendChild(text);
  } else if (lastIndex < content.length) {
    // Remaining text after last code block
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
    const placeholder = createElement("div", { class: "placeholder-img" }, att.filename);
    wrap.appendChild(placeholder);
    return wrap;
  }
  // File attachment
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
  // Add reaction button
  const addBtn = createElement("span", { class: "reaction-chip add-reaction" }, "+");
  addBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
  container.appendChild(addBtn);
  return container;
}

// -- DOM rendering (matches ui-mockup.html structure) -------------------------

function renderDayDivider(iso: string): HTMLDivElement {
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

function renderMessage(
  msg: Message,
  isGrouped: boolean,
  allMessages: readonly Message[],
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  // System messages use a different layout
  if (msg.user.username === "System") {
    return renderSystemMessage(msg);
  }

  const el = createElement("div", {
    class: isGrouped ? "message grouped" : "message",
    "data-testid": `message-${msg.id}`,
  });

  // Avatar (hidden for grouped messages via CSS)
  const role = getUserRole(msg.user.id);
  const initial = msg.user.username.charAt(0).toUpperCase();
  const avatar = createElement("div", {
    class: "msg-avatar",
    style: `background: ${roleColorVar(role)}`,
  }, initial);
  el.appendChild(avatar);

  // Hover time (shown on grouped messages)
  if (isGrouped) {
    const hoverTime = createElement("div", {
      class: "msg-hover-time",
    }, formatTime(msg.timestamp));
    el.appendChild(hoverTime);
  }

  // Reply reference
  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, allMessages));
  }

  // Header (hidden for grouped via CSS)
  const header = createElement("div", { class: "msg-header" });
  const author = createElement("span", {
    class: "msg-author",
    style: `color: ${roleColorVar(role)}`,
  }, msg.user.username);
  const time = createElement("span", { class: "msg-time" }, formatTime(msg.timestamp));
  appendChildren(header, author, time);
  el.appendChild(header);

  // Message content
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

    // Attachments
    for (const att of msg.attachments) {
      el.appendChild(renderAttachment(att));
    }

    // Reactions
    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  }

  // Hover actions bar (mockup: React, Reply, Edit, More)
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

// -- Factory ------------------------------------------------------------------

export function createMessageList(options: MessageListOptions): MountableComponent {
  const ac = new AbortController();
  const unsubscribers: Array<() => void> = [];
  let root: HTMLDivElement | null = null;
  let messagesContainer: HTMLDivElement | null = null;
  let wasAtBottom = true;

  function isNearBottom(): boolean {
    if (messagesContainer === null) return true;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
    return scrollHeight - scrollTop - clientHeight < SCROLL_BOTTOM_THRESHOLD;
  }

  function scrollToBottom(): void {
    if (messagesContainer === null) return;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function renderAll(): void {
    if (messagesContainer === null) return;
    wasAtBottom = isNearBottom();
    clearChildren(messagesContainer);
    const messages = getChannelMessages(options.channelId);
    if (messages.length === 0) return;

    let lastTimestamp: string | null = null;
    let prevMsg: Message | null = null;

    for (const msg of messages) {
      // Day divider
      if (lastTimestamp === null || !isSameDay(lastTimestamp, msg.timestamp)) {
        messagesContainer.appendChild(renderDayDivider(msg.timestamp));
      }

      const isGrouped = prevMsg !== null && shouldGroup(prevMsg, msg);
      messagesContainer.appendChild(
        renderMessage(msg, isGrouped, messages, options, ac.signal),
      );

      lastTimestamp = msg.timestamp;
      prevMsg = msg;
    }
    if (wasAtBottom) { scrollToBottom(); }
  }

  let loadingOlder = false;
  let prevMessageCount = 0;

  // Reset loadingOlder when the store updates with new messages (fetch completed)
  const unsubLoadingReset = messagesStore.subscribe(() => {
    const msgs = getChannelMessages(options.channelId);
    if (msgs.length !== prevMessageCount) {
      prevMessageCount = msgs.length;
      loadingOlder = false;
    }
  });

  function handleScroll(): void {
    if (messagesContainer === null) return;
    if (
      messagesContainer.scrollTop < SCROLL_TOP_THRESHOLD
      && !loadingOlder
      && hasMoreMessages(options.channelId)
    ) {
      loadingOlder = true;
      options.onScrollTop();
    }
  }

  function mount(parentContainer: Element): void {
    root = createElement("div", { class: "messages-container" });
    messagesContainer = root;
    messagesContainer.addEventListener("scroll", handleScroll, {
      signal: ac.signal,
      passive: true,
    });
    parentContainer.appendChild(root);
    renderAll();
    unsubscribers.push(messagesStore.subscribe(() => { renderAll(); }));

    // Only re-render when member roles change, not on typing updates
    let prevMembers = membersStore.getState().members;
    unsubscribers.push(membersStore.subscribe((state) => {
      if (state.members !== prevMembers) {
        prevMembers = state.members;
        renderAll();
      }
    }));
  }

  function destroy(): void {
    ac.abort();
    unsubLoadingReset();
    for (const unsub of unsubscribers) { unsub(); }
    unsubscribers.length = 0;
    if (root !== null) { root.remove(); root = null; }
    messagesContainer = null;
  }

  return { mount, destroy };
}
