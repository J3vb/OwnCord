/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users and join/leave on click.
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
import { voiceStore, getChannelVoiceUsers } from "@stores/voice.store";

export interface ChannelSidebarOptions {
  readonly onVoiceJoin: (channelId: number) => void;
  readonly onVoiceLeave: () => void;
}

const AVATAR_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245"];

function pickAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#5865f2";
}

function renderTextChannelItem(
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

  const prefix = createElement("span", { class: "ch-icon" }, "#");
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

function renderVoiceChannelItem(
  channel: Channel,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
): HTMLDivElement {
  const voiceState = voiceStore.getState();
  const isJoined = voiceState.currentChannelId === channel.id;

  const wrapper = createElement("div", {});

  const classes = ["channel-item", "voice", isJoined ? "active" : ""]
    .filter(Boolean)
    .join(" ");

  const item = createElement("div", { class: classes, "data-testid": `channel-${channel.id}` });
  item.dataset.channelId = String(channel.id);

  const prefix = createElement("span", { class: "ch-icon" }, "\uD83D\uDD0A");
  const name = createElement("span", { class: "ch-name" }, channel.name);

  appendChildren(item, prefix, name);

  item.addEventListener(
    "click",
    () => {
      if (isJoined) {
        onVoiceLeave();
      } else {
        onVoiceJoin(channel.id);
      }
    },
    { signal },
  );

  wrapper.appendChild(item);

  // Render connected voice users below the channel
  const voiceUsers = getChannelVoiceUsers(channel.id);
  if (voiceUsers.length > 0) {
    const usersContainer = createElement("div", { class: "voice-users-list" });
    for (const user of voiceUsers) {
      const rowClasses = user.speaking
        ? "voice-user-item speaking"
        : "voice-user-item";
      const row = createElement("div", { class: rowClasses });

      const initial = user.username.length > 0
        ? user.username.charAt(0).toUpperCase()
        : "?";
      const avatar = createElement("div", { class: "vu-avatar" }, initial);
      avatar.style.background = pickAvatarColor(user.username);
      row.appendChild(avatar);

      const nameEl = createElement(
        "span",
        { class: "vu-name" },
        user.username || "Unknown",
      );
      row.appendChild(nameEl);

      if (user.muted || user.deafened) {
        const icon = user.deafened ? "\uD83D\uDD08" : "\uD83D\uDD07";
        const mutedEl = createElement("span", { class: "vu-muted" }, icon);
        row.appendChild(mutedEl);
      }

      usersContainer.appendChild(row);
    }
    wrapper.appendChild(usersContainer);
  }

  return wrapper;
}

function renderChannelItem(
  channel: Channel,
  isActive: boolean,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
): HTMLDivElement {
  if (channel.type === "voice") {
    return renderVoiceChannelItem(channel, signal, onVoiceJoin, onVoiceLeave);
  }
  return renderTextChannelItem(channel, isActive, signal);
}

function renderCategoryGroup(
  categoryName: string | null,
  channels: readonly Channel[],
  activeChannelId: number | null,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
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
          renderChannelItem(ch, ch.id === activeChannelId, signal, onVoiceJoin, onVoiceLeave),
        );
      }
    }
  } else {
    // Uncategorized channels render directly
    for (const ch of channels) {
      group.appendChild(
        renderChannelItem(ch, ch.id === activeChannelId, signal, onVoiceJoin, onVoiceLeave),
      );
    }
  }

  return group;
}

export function createChannelSidebar(options: ChannelSidebarOptions): MountableComponent {
  const { onVoiceJoin, onVoiceLeave } = options;
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
        renderCategoryGroup(category, channels, state.activeChannelId, ac.signal, onVoiceJoin, onVoiceLeave),
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

    // Subscribe to voice store for connected user updates
    const unsubVoice = voiceStore.subscribe(() => {
      renderChannels();
    });
    unsubscribers.push(unsubVoice);
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
