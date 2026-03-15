/**
 * DmSidebar component — direct messages sidebar showing conversations
 * sorted by most recent, with unread indicators.
 */

import {
  createElement,
  setText,
  clearChildren,
  appendChildren,
} from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface DmConversation {
  readonly userId: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly lastMessage: string;
  readonly timestamp: string;
  readonly unread: boolean;
}

export interface DmSidebarOptions {
  readonly conversations: readonly DmConversation[];
  readonly onSelectConversation: (userId: number) => void;
  readonly onNewDm: () => void;
}

function renderDmItem(
  convo: DmConversation,
  onSelect: (userId: number) => void,
  signal: AbortSignal,
): HTMLDivElement {
  const classes = convo.unread ? "dm-item dm-item--unread" : "dm-item";
  const item = createElement("div", { class: classes });
  item.dataset.userId = String(convo.userId);

  const avatar = createElement("div", { class: "dm-item__avatar" });
  if (convo.avatar !== null) {
    const img = createElement("img", {
      src: convo.avatar,
      alt: convo.username,
      class: "dm-item__avatar-img",
    });
    avatar.appendChild(img);
  } else {
    setText(avatar, convo.username.charAt(0).toUpperCase());
  }

  const info = createElement("div", { class: "dm-item__info" });
  const name = createElement("span", { class: "dm-item__name" }, convo.username);
  const preview = createElement("span", { class: "dm-item__preview" }, convo.lastMessage);
  appendChildren(info, name, preview);

  const time = createElement("span", { class: "dm-item__time" }, convo.timestamp);

  appendChildren(item, avatar, info, time);

  item.addEventListener("click", () => onSelect(convo.userId), { signal });

  return item;
}

export function createDmSidebar(options: DmSidebarOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "dm-sidebar" });

    const header = createElement("div", { class: "dm-sidebar__header" });
    const title = createElement("h2", {}, "Direct Messages");
    const newBtn = createElement("button", { class: "dm-sidebar__new" }, "+");
    newBtn.addEventListener("click", () => options.onNewDm(), { signal: ac.signal });
    appendChildren(header, title, newBtn);

    const list = createElement("div", { class: "dm-sidebar__list" });

    const sorted = [...options.conversations].sort(
      (a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0),
    );

    for (const convo of sorted) {
      list.appendChild(
        renderDmItem(convo, options.onSelectConversation, ac.signal),
      );
    }

    appendChildren(root, header, list);
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
