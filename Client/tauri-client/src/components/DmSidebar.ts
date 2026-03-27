/**
 * DmSidebar component — direct messages sidebar showing conversations
 * sorted by most recent, with unread indicators.
 *
 * Uses the `channel-sidebar` container class (shared with channel sidebar)
 * and DM-specific classes from app.css: dm-sidebar-header, dm-search,
 * dm-nav-item, dm-section-label, dm-add, dm-item, dm-avatar, dm-status,
 * dm-name, dm-close, dm-unread.
 */

import {
  createElement,
  setText,
  clearChildren,
  appendChildren,
} from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";

export interface DmConversation {
  readonly userId: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly avatarColor?: string;
  readonly status?: "online" | "idle" | "dnd" | "offline";
  readonly lastMessage: string;
  readonly timestamp: string;
  readonly unread: boolean;
  readonly active?: boolean;
}

export interface DmSidebarOptions {
  readonly conversations: readonly DmConversation[];
  readonly onSelectConversation: (userId: number) => void;
  readonly onNewDm: () => void;
  readonly onCloseDm?: (userId: number) => void;
  readonly onFriendsClick?: () => void;
  readonly friendsActive?: boolean;
  readonly onBack?: () => void;
  readonly serverName?: string;
}

const STATUS_COLORS: Record<string, string> = {
  online: "var(--green)",
  idle: "var(--yellow)",
  dnd: "var(--red)",
  offline: "var(--text-micro)",
};

function renderDmItem(
  convo: DmConversation,
  onSelect: (userId: number) => void,
  onClose: ((userId: number) => void) | undefined,
  signal: AbortSignal,
): HTMLDivElement {
  const item = createElement("div", { class: "dm-item" });
  if (convo.active === true) {
    item.classList.add("active");
  }
  item.dataset.userId = String(convo.userId);

  // Avatar with status dot
  const avatarBg = convo.avatarColor ?? "#5865F2";
  const avatar = createElement("div", { class: "dm-avatar" });
  avatar.style.background = avatarBg;

  if (convo.avatar !== null) {
    const img = createElement("img", {
      src: convo.avatar,
      alt: convo.username,
    });
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    avatar.appendChild(img);
  } else {
    setText(avatar, convo.username.charAt(0).toUpperCase());
  }

  // Status indicator dot
  const statusKey = convo.status ?? "offline";
  const statusDot = createElement("span", { class: "dm-status" });
  statusDot.style.background = STATUS_COLORS[statusKey] ?? "var(--text-micro)";
  avatar.appendChild(statusDot);

  // Username
  const name = createElement("span", { class: "dm-name" }, convo.username);

  // Close button (hidden by default, shown on hover via CSS)
  const closeBtn = createElement("button", {
    class: "dm-close",
    title: "Close DM",
  });
  closeBtn.textContent = "";
  closeBtn.appendChild(createIcon("x", 14));
  closeBtn.addEventListener(
    "click",
    (e: Event) => {
      e.stopPropagation();
      if (onClose !== undefined) {
        onClose(convo.userId);
      }
    },
    { signal },
  );

  appendChildren(item, avatar, name, closeBtn);

  // Unread dot
  if (convo.unread) {
    const unreadDot = createElement("span", { class: "dm-unread" });
    item.appendChild(unreadDot);
  }

  item.addEventListener("click", () => {
    const parent = item.parentElement;
    if (parent !== null) {
      for (const sibling of parent.querySelectorAll(".dm-item.active")) {
        sibling.classList.remove("active");
      }
    }
    item.classList.add("active");
    onSelect(convo.userId);
  }, { signal });

  return item;
}

export function createDmSidebar(options: DmSidebarOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    // Reuse channel-sidebar container class per mockup
    root = createElement("div", { class: "channel-sidebar" });

    // Back to server header (optional)
    if (options.onBack !== undefined) {
      const backFn = options.onBack;
      const backHeader = createElement("div", {
        class: "dm-back-header",
        "data-testid": "dm-back-header",
      });
      const arrow = createElement("span", { class: "dm-back-arrow" }, "\u2190");
      const backInfo = createElement("div", { class: "dm-back-info" });
      const backTitle = createElement("div", { class: "dm-back-title" },
        `Back to ${options.serverName ?? "Server"}`);
      const backSub = createElement("div", { class: "dm-back-subtitle" }, "Return to channels");
      appendChildren(backInfo, backTitle, backSub);
      appendChildren(backHeader, arrow, backInfo);
      backHeader.addEventListener("click", () => backFn(), { signal: ac.signal });
      root.appendChild(backHeader);
    }

    // Search header
    const header = createElement("div", { class: "dm-sidebar-header" });
    const searchInput = createElement("input", {
      class: "dm-search",
      placeholder: "Find a conversation",
    });
    header.appendChild(searchInput);

    // Friends nav item
    const friendsNav = createElement("div", { class: "dm-nav-item" });
    if (options.friendsActive === true) {
      friendsNav.classList.add("active");
    }
    setText(friendsNav, "Friends");
    friendsNav.addEventListener(
      "click",
      () => {
        if (options.onFriendsClick !== undefined) {
          options.onFriendsClick();
        }
      },
      { signal: ac.signal },
    );

    // Section label with + button
    const sectionLabel = createElement("div", { class: "dm-section-label" });
    setText(sectionLabel, "Direct Messages");
    const addBtn = createElement("button", {
      class: "dm-add",
      title: "New DM",
    });
    setText(addBtn, "+");
    addBtn.addEventListener("click", () => options.onNewDm(), { signal: ac.signal });
    sectionLabel.appendChild(addBtn);

    // Conversation list
    const sorted = [...options.conversations].sort(
      (a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0),
    );

    const items = sorted.map((convo) =>
      renderDmItem(convo, options.onSelectConversation, options.onCloseDm, ac.signal),
    );

    appendChildren(root, header, friendsNav, sectionLabel, ...items);
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
