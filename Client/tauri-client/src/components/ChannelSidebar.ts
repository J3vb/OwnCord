/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users and join/leave on click.
 */

import { createElement, setText, clearChildren, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import {
  channelsStore,
  getChannelsByCategory,
  setActiveChannel,
  clearUnread,
} from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import { authStore, getCurrentUser } from "@stores/auth.store";
import { uiStore, toggleCategory, isCategoryCollapsed } from "@stores/ui.store";
import { voiceStore, getChannelVoiceUsers } from "@stores/voice.store";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { attachStreamPreview, attachScrollCollapse } from "@lib/streamPreview";
import { showUserVolumeMenu } from "./channel-sidebar/volume-menu";
import { attachChannelContextMenu } from "./channel-sidebar/context-menu";
import { attachDragHandlers, releaseGlobalDragListeners } from "./channel-sidebar/drag-reorder";

export interface ChannelReorderData {
  readonly channelId: number;
  readonly newPosition: number;
}

export interface ChannelSidebarOptions {
  readonly onVoiceJoin: (channelId: number) => void;
  readonly onVoiceLeave: () => void;
  /** Called when the user clicks the "+" on a category header. */
  readonly onCreateChannel?: (category: string) => void;
  /** Called when the user right-clicks a channel and selects Edit. */
  readonly onEditChannel?: (channel: Channel) => void;
  /** Called when the user right-clicks a channel and selects Delete. */
  readonly onDeleteChannel?: (channel: Channel) => void;
  /** Called when the user drags a channel to a new position. */
  readonly onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void;
  /** Called when the user clicks a voice user row to watch their stream. */
  readonly onWatchStream?: (userId: number) => void;
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
    const badge = createElement("span", { class: "unread-badge" }, String(channel.unreadCount));
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
  onWatchStream?: (userId: number) => void,
): HTMLDivElement {
  const voiceState = voiceStore.getState();
  const isJoined = voiceState.currentChannelId === channel.id;

  const wrapper = createElement("div", {});

  const classes = ["channel-item", "voice", isJoined ? "active" : ""].filter(Boolean).join(" ");

  const item = createElement("div", { class: classes, "data-testid": `channel-${channel.id}` });
  item.dataset.channelId = String(channel.id);

  const prefix = createElement("span", { class: "ch-icon" });
  prefix.appendChild(createIcon("volume-2", 16));
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
      const rowClasses = user.speaking ? "voice-user-item speaking" : "voice-user-item";
      const row = createElement("div", {
        class: rowClasses,
        "data-voice-uid": String(user.userId),
      });

      const initial = user.username.length > 0 ? user.username.charAt(0).toUpperCase() : "?";
      const avatar = createElement("div", { class: "vu-avatar" }, initial);
      avatar.style.background = pickAvatarColor(user.username);
      row.appendChild(avatar);

      const nameEl = createElement("span", { class: "vu-name" }, user.username || "Unknown");
      row.appendChild(nameEl);

      if (user.camera) {
        const cameraIcon = createElement("span", { class: "vu-status" });
        cameraIcon.appendChild(createIcon("camera", 14));
        row.appendChild(cameraIcon);
      }

      if (user.screenshare) {
        const screenIcon = createElement("span", { class: "vu-status" });
        screenIcon.appendChild(createIcon("monitor", 14));
        row.appendChild(screenIcon);

        const liveBadge = createElement("span", { class: "vu-live-badge" }, "LIVE");
        row.appendChild(liveBadge);
      }

      if (user.deafened) {
        // Deafened: show both mic-off and headphones-off
        const muteIcon = createElement("span", { class: "vu-muted" });
        muteIcon.appendChild(createIcon("mic-off", 14));
        const deafIcon = createElement("span", { class: "vu-muted" });
        deafIcon.appendChild(createIcon("headphones-off", 14));
        row.appendChild(muteIcon);
        row.appendChild(deafIcon);
      } else if (user.muted) {
        // Muted only: show mic-off
        const muteIcon = createElement("span", { class: "vu-muted" });
        muteIcon.appendChild(createIcon("mic-off", 14));
        row.appendChild(muteIcon);
      }

      // Right-click for per-user volume (skip for own user)
      const currentUser = getCurrentUser();
      if (currentUser === null || currentUser.id !== user.userId) {
        row.addEventListener(
          "contextmenu",
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            showUserVolumeMenu(
              user.userId,
              user.username || "Unknown",
              e.clientX,
              e.clientY,
              signal,
            );
          },
          { signal },
        );
      }

      // Click to watch stream (if user has camera or screenshare)
      if (onWatchStream !== undefined && (user.camera || user.screenshare)) {
        row.addEventListener(
          "click",
          (e) => {
            // Don't trigger if the right-click menu is open
            if (e.button !== 0) return;
            e.stopPropagation();
            const tileId = user.screenshare
              ? user.userId + SCREENSHARE_TILE_ID_OFFSET
              : user.userId;
            onWatchStream(tileId);
          },
          { signal },
        );
        row.style.cursor = "pointer";
      }

      // Hover/focus preview for remote users with video
      if (
        (currentUser === null || currentUser.id !== user.userId) &&
        (user.camera || user.screenshare)
      ) {
        const tileId = user.screenshare ? user.userId + SCREENSHARE_TILE_ID_OFFSET : user.userId;
        attachStreamPreview(
          row,
          user.userId,
          user.username || "Unknown",
          user.screenshare,
          user.camera,
          signal,
          () => {
            // Placeholder click: join voice channel and watch stream
            // Only join if not already in this channel
            if (voiceStore.getState().currentChannelId !== channel.id) {
              onVoiceJoin(channel.id);
            }
            if (onWatchStream !== undefined) onWatchStream(tileId);
          },
          onWatchStream !== undefined ? () => onWatchStream(tileId) : undefined,
        );
      }

      usersContainer.appendChild(row);
    }
    attachScrollCollapse(usersContainer, signal);
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
  onEditChannel?: (channel: Channel) => void,
  onDeleteChannel?: (channel: Channel) => void,
  containerEl?: HTMLElement,
  channels?: readonly Channel[],
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
  onWatchStream?: (userId: number) => void,
): HTMLDivElement {
  let el: HTMLDivElement;
  if (channel.type === "voice") {
    el = renderVoiceChannelItem(channel, signal, onVoiceJoin, onVoiceLeave, onWatchStream);
  } else {
    el = renderTextChannelItem(channel, isActive, signal);
  }
  attachChannelContextMenu(el, channel, signal, onEditChannel, onDeleteChannel);
  if (containerEl !== undefined && channels !== undefined) {
    attachDragHandlers(el, channel, containerEl, channels, signal, onReorderChannel);
  }
  return el;
}

function renderCategoryGroup(
  categoryName: string | null,
  channels: readonly Channel[],
  activeChannelId: number | null,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
  onCreateChannel?: (category: string) => void,
  onEditChannel?: (channel: Channel) => void,
  onDeleteChannel?: (channel: Channel) => void,
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
  onWatchStream?: (userId: number) => void,
): HTMLDivElement {
  const group = createElement("div", {});

  if (categoryName !== null) {
    const collapsed = isCategoryCollapsed(categoryName);
    const header = createElement("div", {
      class: collapsed ? "category collapsed" : "category",
    });
    header.dataset.category = categoryName;

    const arrow = createElement("span", { class: "category-arrow" });
    arrow.appendChild(createIcon(collapsed ? "chevron-right" : "chevron-down", 12));
    const label = createElement("span", { class: "category-name" }, categoryName);

    appendChildren(header, arrow, label);

    if (onCreateChannel !== undefined) {
      const user = getCurrentUser();
      const role = user?.role?.toLowerCase() ?? "";
      const canManageChannels = role === "owner" || role === "admin";

      if (canManageChannels) {
        const addBtn = createElement(
          "span",
          {
            class: "category-add-btn",
            title: "Create Channel",
            "data-testid": `create-channel-${categoryName.toLowerCase().replace(/\s+/g, "-")}`,
          },
          "+",
        );
        addBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onCreateChannel(categoryName);
          },
          { signal },
        );
        header.appendChild(addBtn);
      }
    }

    header.addEventListener(
      "click",
      () => {
        toggleCategory(categoryName);
      },
      { signal },
    );

    group.appendChild(header);

    if (!collapsed) {
      const channelsContainer = createElement("div", { class: "category-channels-container" });
      for (const ch of channels) {
        channelsContainer.appendChild(
          renderChannelItem(
            ch,
            ch.id === activeChannelId,
            signal,
            onVoiceJoin,
            onVoiceLeave,
            onEditChannel,
            onDeleteChannel,
            channelsContainer,
            channels,
            onReorderChannel,
            onWatchStream,
          ),
        );
      }
      group.appendChild(channelsContainer);
    }
  } else {
    // Uncategorized channels render directly
    const channelsContainer = createElement("div", { class: "category-channels-container" });
    for (const ch of channels) {
      channelsContainer.appendChild(
        renderChannelItem(
          ch,
          ch.id === activeChannelId,
          signal,
          onVoiceJoin,
          onVoiceLeave,
          onEditChannel,
          onDeleteChannel,
          channelsContainer,
          channels,
          onReorderChannel,
          onWatchStream,
        ),
      );
    }
    group.appendChild(channelsContainer);
  }

  return group;
}

export function createChannelSidebar(options: ChannelSidebarOptions): MountableComponent {
  const {
    onVoiceJoin,
    onVoiceLeave,
    onCreateChannel,
    onEditChannel,
    onDeleteChannel,
    onReorderChannel,
    onWatchStream,
  } = options;
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

    if (grouped.size === 0) {
      const emptyState = createElement("div", { class: "channel-list-empty" });
      const msg = createElement("p", { class: "channel-list-empty-text" }, "No channels yet");
      const hint = createElement(
        "p",
        { class: "channel-list-empty-hint" },
        "Right-click a category to create one",
      );
      appendChildren(emptyState, msg, hint);
      channelList.appendChild(emptyState);
      return;
    }

    for (const [category, channels] of grouped) {
      channelList.appendChild(
        renderCategoryGroup(
          category,
          channels,
          state.activeChannelId,
          ac.signal,
          onVoiceJoin,
          onVoiceLeave,
          onCreateChannel,
          onEditChannel,
          onDeleteChannel,
          onReorderChannel,
          onWatchStream,
        ),
      );
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });

    // Header
    const header = createElement("div", { class: "channel-sidebar-header" });
    const authState = authStore.getState();
    serverNameEl = createElement("h2", {}, authState.serverName ?? "Server Name");
    header.appendChild(serverNameEl);

    // Channel list
    channelList = createElement("div", { class: "channel-list" });

    appendChildren(root, header, channelList);
    container.appendChild(root);

    // Initial render
    renderChannels();

    // Subscribe to channels store changes (channels map OR active channel)
    const unsubChannelsMap = channelsStore.subscribeSelector(
      (s) => s.channels,
      () => renderChannels(),
    );
    unsubscribers.push(unsubChannelsMap);
    const unsubActiveChannel = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => renderChannels(),
    );
    unsubscribers.push(unsubActiveChannel);

    // Subscribe to auth store for server name updates
    const unsubAuth = authStore.subscribeSelector(
      (s) => s.serverName,
      (serverName) => {
        if (serverNameEl !== null) {
          setText(serverNameEl, serverName ?? "Server Name");
        }
      },
    );
    unsubscribers.push(unsubAuth);

    // Subscribe to UI store for category collapse changes
    const unsubUi = uiStore.subscribeSelector(
      (s) => s.collapsedCategories,
      () => renderChannels(),
    );
    unsubscribers.push(unsubUi);

    // Subscribe to voice store — only full re-render when users join/leave
    // or mute/deafen/camera changes. Speaking state is patched in-place via
    // CSS class toggle to avoid destroying DOM elements (which kills hover).
    let prevVoiceStructureSig = "";
    const unsubVoice = voiceStore.subscribe((state) => {
      // Structural signature: who is in which channel + mute/deafen/camera.
      // Excludes speaking — that's patched in-place below.
      let structSig = String(state.currentChannelId ?? "");
      for (const [chId, users] of state.voiceUsers) {
        structSig += `|${chId}`;
        for (const [uid, u] of users) {
          structSig += `:${uid}${u.muted ? "m" : ""}${u.deafened ? "d" : ""}${u.camera ? "c" : ""}${u.screenshare ? "s" : ""}`;
        }
      }
      if (structSig !== prevVoiceStructureSig) {
        prevVoiceStructureSig = structSig;
        renderChannels();
        return;
      }

      // Patch speaking state in-place — toggle CSS class without re-rendering.
      if (channelList === null) return;
      for (const [, users] of state.voiceUsers) {
        for (const [uid, u] of users) {
          const row = channelList.querySelector<HTMLElement>(
            `.voice-user-item[data-voice-uid="${uid}"]`,
          );
          if (row !== null) {
            row.classList.toggle("speaking", u.speaking);
          }
        }
      }
    });
    unsubscribers.push(unsubVoice);
  }

  function destroy(): void {
    ac.abort();
    releaseGlobalDragListeners(channelList ?? undefined);
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
