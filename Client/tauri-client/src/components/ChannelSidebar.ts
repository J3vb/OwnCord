/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 */

import {
  createElement,
  setText,
  clearChildren,
  appendChildren,
} from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import {
  channelsStore,
  getChannelsByCategory,
  setActiveChannel,
  clearUnread,
} from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import { authStore } from "@stores/auth.store";
import {
  uiStore,
  toggleCategory,
  isCategoryCollapsed,
} from "@stores/ui.store";

function renderChannelItem(
  channel: Channel,
  isActive: boolean,
  signal: AbortSignal,
): HTMLDivElement {
  const classes = [
    "channel-item",
    isActive ? "active" : "",
    channel.unreadCount > 0 ? "unread" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const item = createElement("div", { class: classes, "data-testid": `channel-${channel.id}` });
  item.dataset.channelId = String(channel.id);

  const prefix =
    channel.type === "voice"
      ? createElement("span", { class: "ch-icon" }, "\uD83D\uDD0A")
      : createElement("span", { class: "ch-icon" }, "#");

  const name = createElement("span", { class: "ch-name" }, channel.name);

  appendChildren(item, prefix, name);

  if (channel.unreadCount > 0) {
    const badge = createElement(
      "span",
      { class: "unread-badge" },
      String(channel.unreadCount),
    );
    item.appendChild(badge);
  }

  item.addEventListener(
    "click",
    () => {
      setActiveChannel(channel.id);
      clearUnread(channel.id);
    },
    { signal },
  );

  return item;
}

function renderCategoryGroup(
  categoryName: string | null,
  channels: readonly Channel[],
  activeChannelId: number | null,
  signal: AbortSignal,
): HTMLDivElement {
  const group = createElement("div", {});

  if (categoryName !== null) {
    const collapsed = isCategoryCollapsed(categoryName);
    const header = createElement("div", {
      class: collapsed ? "category collapsed" : "category",
    });
    header.dataset.category = categoryName;

    const arrow = createElement(
      "span",
      { class: "category-arrow" },
      collapsed ? "\u25B6" : "\u25BC",
    );
    const label = createElement("span", { class: "category-name" }, categoryName);

    appendChildren(header, arrow, label);

    header.addEventListener(
      "click",
      () => {
        toggleCategory(categoryName);
      },
      { signal },
    );

    group.appendChild(header);

    if (!collapsed) {
      for (const ch of channels) {
        group.appendChild(
          renderChannelItem(ch, ch.id === activeChannelId, signal),
        );
      }
    }
  } else {
    // Uncategorized channels render directly
    for (const ch of channels) {
      group.appendChild(
        renderChannelItem(ch, ch.id === activeChannelId, signal),
      );
    }
  }

  return group;
}

export function createChannelSidebar(): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let channelList: HTMLDivElement | null = null;
  let serverNameEl: HTMLSpanElement | null = null;

  const unsubscribers: Array<() => void> = [];

  function renderChannels(): void {
    if (channelList === null) {
      return;
    }
    clearChildren(channelList);

    const grouped = getChannelsByCategory();
    const state = channelsStore.getState();

    for (const [category, channels] of grouped) {
      channelList.appendChild(
        renderCategoryGroup(category, channels, state.activeChannelId, ac.signal),
      );
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });

    // Header
    const header = createElement("div", { class: "channel-sidebar-header" });
    const authState = authStore.getState();
    serverNameEl = createElement(
      "h2",
      {},
      authState.serverName ?? "Server Name",
    );
    header.appendChild(serverNameEl);

    // Channel list
    channelList = createElement("div", { class: "channel-list" });

    appendChildren(root, header, channelList);
    container.appendChild(root);

    // Initial render
    renderChannels();

    // Subscribe to channels store changes
    const unsubChannels = channelsStore.subscribe(() => {
      renderChannels();
    });
    unsubscribers.push(unsubChannels);

    // Subscribe to auth store for server name updates
    const unsubAuth = authStore.subscribe((state) => {
      if (serverNameEl !== null) {
        setText(serverNameEl, state.serverName ?? "Server Name");
      }
    });
    unsubscribers.push(unsubAuth);

    // Subscribe to UI store for category collapse changes
    const unsubUi = uiStore.subscribe(() => {
      renderChannels();
    });
    unsubscribers.push(unsubUi);
  }

  function destroy(): void {
    ac.abort();
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
    if (root !== null) {
      root.remove();
      root = null;
    }
    channelList = null;
    serverNameEl = null;
  }

  return { mount, destroy };
}
