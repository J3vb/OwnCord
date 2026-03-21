/**
 * PinnedMessages component — Discord-style pinned messages panel
 * with avatars, hover actions, and entry animation.
 */

import {
  createElement,
  clearChildren,
  appendChildren,
} from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface PinnedMessage {
  readonly id: number;
  readonly content: string;
  readonly author: string;
  readonly timestamp: string;
  readonly avatarColor: string;
}

export interface PinnedMessagesOptions {
  readonly channelId: number;
  readonly pinnedMessages: readonly PinnedMessage[];
  readonly onUnpin: (messageId: number) => void;
  readonly onJumpToMessage: (messageId: number) => void;
  readonly onClose: () => void;
}

function getInitial(name: string): string {
  return name.length > 0 ? name.charAt(0).toUpperCase() : "?";
}

function renderPinnedItem(
  msg: PinnedMessage,
  options: PinnedMessagesOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const card = createElement("div", { class: "pinned-msg" });
  card.dataset.messageId = String(msg.id);

  // Row: avatar + body
  const row = createElement("div", { class: "pinned-msg__row" });

  const avatar = createElement("div", { class: "pinned-msg__avatar" });
  avatar.style.backgroundColor = msg.avatarColor;
  avatar.textContent = getInitial(msg.author);

  const body = createElement("div", { class: "pinned-msg__body" });

  const head = createElement("div", { class: "pinned-msg__head" });
  const authorEl = createElement("span", { class: "pinned-msg__author" }, msg.author);
  const timeEl = createElement("span", { class: "pinned-msg__time" }, msg.timestamp);
  appendChildren(head, authorEl, timeEl);

  const content = createElement("div", { class: "pinned-msg__content" }, msg.content);
  appendChildren(body, head, content);
  appendChildren(row, avatar, body);

  // Hover actions
  const actions = createElement("div", { class: "pinned-msg__actions" });
  const jumpBtn = createElement("button", { title: "Jump to message" }, "\u2197");
  const unpinBtn = createElement("button", {
    class: "pinned-msg__unpin",
    title: "Unpin message",
  }, "\u2715");

  jumpBtn.addEventListener("click", () => options.onJumpToMessage(msg.id), { signal });
  unpinBtn.addEventListener("click", () => options.onUnpin(msg.id), { signal });

  appendChildren(actions, jumpBtn, unpinBtn);
  appendChildren(card, row, actions);

  return card;
}

function renderEmptyState(): HTMLDivElement {
  const empty = createElement("div", { class: "pinned-panel__empty" });
  const icon = createElement("div", { class: "pinned-panel__empty-icon" });
  icon.textContent = "\uD83D\uDCCC";
  const text = createElement("div", { class: "pinned-panel__empty-text" });
  text.textContent = "This channel doesn't have any pinned messages\u2026 yet!";
  appendChildren(empty, icon, text);
  return empty;
}

export function createPinnedMessages(
  options: PinnedMessagesOptions,
): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "pinned-panel" });

    // Header
    const header = createElement("div", { class: "pinned-panel__header" });
    const title = createElement("h3", {});
    title.textContent = "\uD83D\uDCCC Pinned Messages";

    const count = createElement("span", { class: "pinned-panel__count" });
    count.textContent = String(options.pinnedMessages.length);

    const closeBtn = createElement("button", { class: "pinned-panel__close" }, "\u00D7");
    closeBtn.addEventListener("click", () => options.onClose(), { signal: ac.signal });

    const titleGroup = createElement("div", {
      style: "display:flex;align-items:center;gap:8px",
    });
    appendChildren(titleGroup, title, count);
    appendChildren(header, titleGroup, closeBtn);

    // Body — list or empty state
    if (options.pinnedMessages.length === 0) {
      const empty = renderEmptyState();
      appendChildren(root, header, empty);
    } else {
      const list = createElement("div", { class: "pinned-panel__list" });
      for (const msg of options.pinnedMessages) {
        list.appendChild(renderPinnedItem(msg, options, ac.signal));
      }
      appendChildren(root, header, list);
    }

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
