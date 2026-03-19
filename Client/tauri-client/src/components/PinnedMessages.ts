/**
 * PinnedMessages component — slide-out panel showing pinned messages
 * for a channel with jump-to and unpin actions.
 */

import {
  createElement,
  setText,
  clearChildren,
  appendChildren,
} from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface PinnedMessage {
  readonly id: number;
  readonly content: string;
  readonly author: string;
  readonly timestamp: string;
}

export interface PinnedMessagesOptions {
  readonly channelId: number;
  readonly pinnedMessages: readonly PinnedMessage[];
  readonly onUnpin: (messageId: number) => void;
  readonly onJumpToMessage: (messageId: number) => void;
  readonly onClose: () => void;
}

function renderPinnedItem(
  msg: PinnedMessage,
  options: PinnedMessagesOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const item = createElement("div", { class: "pinned-msg" });
  item.dataset.messageId = String(msg.id);

  const author = createElement("div", { class: "pinned-msg__author" }, msg.author);
  const content = createElement("div", { class: "pinned-msg__content" }, msg.content);
  const time = createElement("div", { class: "pinned-msg__time" }, msg.timestamp);

  const actions = createElement("div", { class: "pinned-msg__actions" });
  const jumpBtn = createElement("button", {}, "Jump");
  const unpinBtn = createElement("button", {}, "Unpin");

  jumpBtn.addEventListener("click", () => options.onJumpToMessage(msg.id), { signal });
  unpinBtn.addEventListener("click", () => options.onUnpin(msg.id), { signal });

  appendChildren(actions, jumpBtn, unpinBtn);
  appendChildren(item, author, content, time, actions);
  return item;
}

export function createPinnedMessages(
  options: PinnedMessagesOptions,
): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "pinned-panel" });

    const header = createElement("div", { class: "pinned-panel__header" });
    const title = createElement("h3", {}, "Pinned Messages");
    const closeBtn = createElement("button", { class: "pinned-panel__close" }, "\u00D7");
    closeBtn.addEventListener("click", () => options.onClose(), { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    const list = createElement("div", { class: "pinned-panel__list" });
    const empty = createElement("div", { class: "pinned-panel__empty" }, "No pinned messages");

    if (options.pinnedMessages.length === 0) {
      empty.style.display = "";
      list.style.display = "none";
    } else {
      empty.style.display = "none";
      list.style.display = "";
      for (const msg of options.pinnedMessages) {
        list.appendChild(renderPinnedItem(msg, options, ac.signal));
      }
    }

    appendChildren(root, header, list, empty);
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
