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
import { messagesStore, getChannelMessages } from "@stores/messages.store";
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

// -- @mention parsing (XSS-safe, no innerHTML) --------------------------------

function renderMentionContent(text: string): DocumentFragment {
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
  text.appendChild(renderMentionContent(msg.content));
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

  // Message text
  if (msg.deleted) {
    const text = createElement("div", { class: "msg-text" });
    text.style.fontStyle = "italic";
    text.style.color = "var(--text-muted)";
    setText(text, "[message deleted]");
    el.appendChild(text);
  } else {
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(renderMentionContent(msg.content));
    el.appendChild(text);
    if (msg.editedAt !== null) {
      el.appendChild(createElement("span", { class: "msg-edited" }, "(edited)"));
    }
  }

  // Hover actions bar
  if (!msg.deleted) {
    const actionsBar = createElement("div", { class: "msg-actions-bar" });
    const replyBtn = createElement("button", {}, "\u21A9");
    replyBtn.title = "Reply";
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    if (msg.user.id === opts.currentUserId) {
      const editBtn = createElement("button", {}, "\u270E");
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      const delBtn = createElement("button", {}, "\uD83D\uDDD1");
      delBtn.title = "Delete";
      delBtn.addEventListener("click", () => opts.onDeleteClick(msg.id), { signal });
      appendChildren(actionsBar, editBtn, delBtn);
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

  function handleScroll(): void {
    if (messagesContainer === null) return;
    if (messagesContainer.scrollTop < SCROLL_TOP_THRESHOLD) {
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
    unsubscribers.push(membersStore.subscribe(() => { renderAll(); }));
  }

  function destroy(): void {
    ac.abort();
    for (const unsub of unsubscribers) { unsub(); }
    unsubscribers.length = 0;
    if (root !== null) { root.remove(); root = null; }
    messagesContainer = null;
  }

  return { mount, destroy };
}
