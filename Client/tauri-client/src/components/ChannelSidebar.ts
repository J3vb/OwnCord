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
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import {
  channelsStore,
  getChannelsByCategory,
  setActiveChannel,
  clearUnread,
  updateChannelPosition,
} from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import { authStore, getCurrentUser } from "@stores/auth.store";
import {
  uiStore,
  toggleCategory,
  isCategoryCollapsed,
} from "@stores/ui.store";
import { voiceStore, getChannelVoiceUsers } from "@stores/voice.store";
import { setUserVolume, getUserVolume } from "@lib/livekitSession";

// ---------------------------------------------------------------------------
// Per-user volume context menu (right-click on voice user row)
// ---------------------------------------------------------------------------

function showUserVolumeMenu(
  userId: number,
  username: string,
  x: number,
  y: number,
  signal: AbortSignal,
): void {
  // Remove any existing context menus
  document.querySelectorAll(".user-vol-menu").forEach((el) => el.remove());

  const menu = createElement("div", { class: "context-menu user-vol-menu" });

  const header = createElement("div", {
    class: "context-menu-item",
    style: "font-weight:600;cursor:default;pointer-events:none",
  }, username);
  menu.appendChild(header);

  const sep = createElement("div", { class: "context-menu-sep" });
  menu.appendChild(sep);

  const currentVol = getUserVolume(userId);
  const volLabel = createElement("div", {
    class: "context-menu-item",
    style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
  }, `User Volume: ${currentVol}%`);
  menu.appendChild(volLabel);

  const sliderRow = createElement("div", {
    style: "padding:4px 10px;display:flex;align-items:center;gap:8px",
  });
  const slider = createElement("input", {
    type: "range",
    class: "settings-slider",
    min: "0",
    max: "200",
    value: String(currentVol),
    style: "flex:1",
  });
  const valLabel = createElement("span", {
    class: "slider-val",
    style: "min-width:40px;text-align:right;font-size:12px;color:var(--text-muted)",
  }, `${currentVol}%`);

  slider.addEventListener("input", () => {
    const val = Number(slider.value);
    setText(valLabel, `${val}%`);
    setText(volLabel, `User Volume: ${val}%`);
    setUserVolume(userId, val);
  });

  appendChildren(sliderRow, slider, valLabel);
  menu.appendChild(sliderRow);

  const resetBtn = createElement("div", { class: "context-menu-item" }, "Reset Volume");
  resetBtn.addEventListener("click", () => {
    setUserVolume(userId, 100);
    slider.value = "100";
    setText(valLabel, "100%");
    setText(volLabel, "User Volume: 100%");
  });
  menu.appendChild(resetBtn);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Close on click outside
  const dismissAc = new AbortController();
  setTimeout(() => {
    document.addEventListener("mousedown", (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        dismissAc.abort();
      }
    }, { signal: dismissAc.signal });
  }, 0);

  // Also clean up if the parent component is destroyed
  signal.addEventListener("abort", () => {
    menu.remove();
    dismissAc.abort();
  });
}

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
}

// ── Drag state (mouse-based, avoids WebView2 HTML5 DnD issues) ──
interface DragState {
  channelId: number;
  sourceEl: HTMLElement;
  containerEl: HTMLElement;
  channels: readonly Channel[];
  onReorder: (reorders: readonly ChannelReorderData[]) => void;
}
let activeDrag: DragState | null = null;

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
      const rowClasses = user.speaking
        ? "voice-user-item speaking"
        : "voice-user-item";
      const row = createElement("div", { class: rowClasses, "data-voice-uid": String(user.userId) });

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

      if (user.camera) {
        const cameraIcon = createElement("span", { class: "vu-status" });
        cameraIcon.appendChild(createIcon("camera", 14));
        row.appendChild(cameraIcon);
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
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showUserVolumeMenu(user.userId, user.username || "Unknown", e.clientX, e.clientY, signal);
        }, { signal });
      }

      usersContainer.appendChild(row);
    }
    wrapper.appendChild(usersContainer);
  }

  return wrapper;
}

/** Attach a right-click context menu to a channel element for edit/delete. */
function attachChannelContextMenu(
  el: HTMLElement,
  channel: Channel,
  signal: AbortSignal,
  onEdit?: (channel: Channel) => void,
  onDelete?: (channel: Channel) => void,
): void {
  if (onEdit === undefined && onDelete === undefined) {
    return;
  }
  const user = getCurrentUser();
  const role = user?.role?.toLowerCase() ?? "";
  if (role !== "owner" && role !== "admin") {
    return;
  }

  el.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Remove any existing context menu
      document.querySelector(".channel-ctx-menu")?.remove();

      const menu = createElement("div", {
        class: "context-menu channel-ctx-menu",
        "data-testid": "channel-context-menu",
      });
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;

      if (onEdit !== undefined) {
        const editItem = createElement(
          "div",
          { class: "context-menu-item", "data-testid": "ctx-edit-channel" },
          "Edit Channel",
        );
        editItem.addEventListener(
          "click",
          () => {
            menu.remove();
            onEdit(channel);
          },
          { signal },
        );
        menu.appendChild(editItem);
      }

      if (onDelete !== undefined) {
        if (onEdit !== undefined) {
          menu.appendChild(createElement("div", { class: "context-menu-sep" }));
        }
        const deleteItem = createElement(
          "div",
          { class: "context-menu-item danger", "data-testid": "ctx-delete-channel" },
          "Delete Channel",
        );
        deleteItem.addEventListener(
          "click",
          () => {
            menu.remove();
            onDelete(channel);
          },
          { signal },
        );
        menu.appendChild(deleteItem);
      }

      document.body.appendChild(menu);

      // Close menu on click elsewhere
      const closeMenu = (): void => {
        menu.remove();
        document.removeEventListener("click", closeMenu);
      };
      // Defer so this click event doesn't immediately close it
      setTimeout(() => {
        document.addEventListener("click", closeMenu, { signal });
      }, 0);
    },
    { signal },
  );
}

/** Global mousemove/mouseup handlers for drag reordering. Registered once. */
let globalDragAc: AbortController | null = null;

function ensureGlobalDragListeners(): void {
  if (globalDragAc !== null) {
    return;
  }
  globalDragAc = new AbortController();

  document.addEventListener("mousemove", (e) => {
    if (activeDrag === null) {
      return;
    }
    // Clear old indicators
    activeDrag.containerEl.querySelectorAll(".channel-drop-indicator").forEach((x) => {
      x.classList.remove("channel-drop-indicator");
    });

    // Find which channel item we're hovering over
    const items = activeDrag.containerEl.querySelectorAll("[data-drag-channel-id]");
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const targetId = Number((item as HTMLElement).dataset.dragChannelId);
        if (targetId !== activeDrag.channelId) {
          item.classList.add("channel-drop-indicator");
        }
        break;
      }
    }
  }, { signal: globalDragAc.signal });

  document.addEventListener("mouseup", (e) => {
    if (activeDrag === null) {
      return;
    }
    const drag = activeDrag;
    activeDrag = null;

    // Clean up visual state
    drag.sourceEl.classList.remove("dragging");
    document.body.classList.remove("channel-reordering");
    drag.containerEl.querySelectorAll(".channel-drop-indicator").forEach((x) => {
      x.classList.remove("channel-drop-indicator");
    });

    // Find drop target
    const items = drag.containerEl.querySelectorAll("[data-drag-channel-id]");
    let dropTargetId: number | null = null;
    let dropBefore = false;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        dropTargetId = Number((item as HTMLElement).dataset.dragChannelId);
        dropBefore = e.clientY < rect.top + rect.height / 2;
        break;
      }
    }

    if (dropTargetId === null || dropTargetId === drag.channelId) {
      return;
    }

    // Compute new order
    const orderedIds = drag.channels.map((ch) => ch.id);
    const dragIdx = orderedIds.indexOf(drag.channelId);
    if (dragIdx === -1) {
      return;
    }
    orderedIds.splice(dragIdx, 1);

    const targetIdx = orderedIds.indexOf(dropTargetId);
    if (targetIdx === -1) {
      return;
    }
    const insertIdx = dropBefore ? targetIdx : targetIdx + 1;
    orderedIds.splice(insertIdx, 0, drag.channelId);

    // Build reorder data and update store immediately
    const reorders: ChannelReorderData[] = [];
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (id === undefined) {
        continue;
      }
      const ch = drag.channels.find((c) => c.id === id);
      if (ch !== undefined && ch.position !== i) {
        reorders.push({ channelId: id, newPosition: i });
        updateChannelPosition(id, i);
      }
    }

    if (reorders.length > 0) {
      drag.onReorder(reorders);
    }
  }, { signal: globalDragAc.signal });
}

/** Make a channel element draggable via mousedown (admin/owner only). */
function attachDragHandlers(
  el: HTMLElement,
  channel: Channel,
  containerEl: HTMLElement,
  channels: readonly Channel[],
  signal: AbortSignal,
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
): void {
  if (onReorderChannel === undefined) {
    return;
  }
  const user = getCurrentUser();
  const role = user?.role?.toLowerCase() ?? "";
  if (role !== "owner" && role !== "admin") {
    return;
  }

  ensureGlobalDragListeners();

  el.classList.add("channel-draggable");
  el.dataset.dragChannelId = String(channel.id);

  let pendingDrag: { startX: number; startY: number } | null = null;

  el.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) {
        return;
      }
      // Start tracking — only activate drag after movement threshold
      pendingDrag = { startX: e.clientX, startY: e.clientY };
    },
    { signal },
  );

  el.addEventListener(
    "mousemove",
    (e) => {
      if (pendingDrag === null || activeDrag !== null) {
        return;
      }
      const dx = Math.abs(e.clientX - pendingDrag.startX);
      const dy = Math.abs(e.clientY - pendingDrag.startY);
      // Require 5px movement to start drag (avoids hijacking clicks)
      if (dx + dy < 5) {
        return;
      }
      pendingDrag = null;
      activeDrag = {
        channelId: channel.id,
        sourceEl: el,
        containerEl,
        channels,
        onReorder: onReorderChannel,
      };
      el.classList.add("dragging");
      document.body.classList.add("channel-reordering");
    },
    { signal },
  );

  el.addEventListener(
    "mouseup",
    () => {
      pendingDrag = null;
    },
    { signal },
  );
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
): HTMLDivElement {
  let el: HTMLDivElement;
  if (channel.type === "voice") {
    el = renderVoiceChannelItem(channel, signal, onVoiceJoin, onVoiceLeave);
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
        const addBtn = createElement("span", {
          class: "category-add-btn",
          title: "Create Channel",
          "data-testid": `create-channel-${categoryName.toLowerCase().replace(/\s+/g, "-")}`,
        }, "+");
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
          renderChannelItem(ch, ch.id === activeChannelId, signal, onVoiceJoin, onVoiceLeave, onEditChannel, onDeleteChannel, channelsContainer, channels, onReorderChannel),
        );
      }
      group.appendChild(channelsContainer);
    }
  } else {
    // Uncategorized channels render directly
    const channelsContainer = createElement("div", { class: "category-channels-container" });
    for (const ch of channels) {
      channelsContainer.appendChild(
        renderChannelItem(ch, ch.id === activeChannelId, signal, onVoiceJoin, onVoiceLeave, onEditChannel, onDeleteChannel, channelsContainer, channels, onReorderChannel),
      );
    }
    group.appendChild(channelsContainer);
  }

  return group;
}

export function createChannelSidebar(options: ChannelSidebarOptions): MountableComponent {
  const { onVoiceJoin, onVoiceLeave, onCreateChannel, onEditChannel, onDeleteChannel, onReorderChannel } = options;
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
      const hint = createElement("p", { class: "channel-list-empty-hint" }, "Right-click a category to create one");
      appendChildren(emptyState, msg, hint);
      channelList.appendChild(emptyState);
      return;
    }

    for (const [category, channels] of grouped) {
      channelList.appendChild(
        renderCategoryGroup(category, channels, state.activeChannelId, ac.signal, onVoiceJoin, onVoiceLeave, onCreateChannel, onEditChannel, onDeleteChannel, onReorderChannel),
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
          structSig += `:${uid}${u.muted ? "m" : ""}${u.deafened ? "d" : ""}${u.camera ? "c" : ""}`;
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
          const row = channelList.querySelector<HTMLElement>(`.voice-user-item[data-voice-uid="${uid}"]`);
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
    globalDragAc?.abort();
    globalDragAc = null;
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
